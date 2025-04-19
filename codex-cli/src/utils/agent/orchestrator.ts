import type { ApprovalPolicy } from "../../approvals.js";
import type { Action, ChangePlan, EditAction, CommandAction, MessageAction } from "./change_plan.js";
import type { AppConfig } from "../config.js";
import type { ResponseInputItem, ResponseItem } from "openai/resources/responses/responses.mjs";

import { log, isLoggingEnabled } from "./log.js";
import { validateChangePlan } from "./change_plan.js";
import { callArchitect, callCoder } from "./models.js";
import { buildCoderContext } from "./context.js";
import { handleExecCommand } from "./handle-exec-command.js";
import { execSync, spawn } from "child_process";
import { ApplyPatchCommand } from "../../approvals.js";
import { ReviewDecision } from "./review.js";
import fs from "fs";
import path from "path";

/**
 * Represents the state of the orchestrator
 */
export enum OrchestratorState {
  IDLE = "idle",
  ARCHITECT_CALL = "architect_call",
  VALIDATE_PLAN = "validate_plan",
  EXECUTING_PLAN = "executing_plan",
  ERROR = "error",
  DONE = "done",
}

/**
 * Output of a health check
 */
interface HealthCheckResult {
  success: boolean;
  message: string;
}

/**
 * Parameters for the Orchestrator
 */
interface OrchestratorParams {
  config: AppConfig;
  approvalPolicy: ApprovalPolicy;
  onItem: (item: ResponseItem) => void;
  onLoading: (loading: boolean) => void;
  getCommandConfirmation: (
    command: Array<string>,
    applyPatch: ApplyPatchCommand | undefined,
  ) => Promise<{
    review: ReviewDecision;
    applyPatch?: ApplyPatchCommand;
    customDenyMessage?: string;
  }>;
  onLastResponseId: (lastResponseId: string) => void;
}

/**
 * The Orchestrator manages the multi-agent workflow
 */
export class Orchestrator {
  private state: OrchestratorState = OrchestratorState.IDLE;
  private config: AppConfig;
  private approvalPolicy: ApprovalPolicy;
  private currentPlan: ChangePlan | null = null;
  private currentActionIndex = 0;
  private abortController: AbortController = new AbortController();
  // We'll use the global telemetry array instead of a local one
  private get telemetryData(): Array<{
    ts: number;
    role: string;
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
    duration_ms?: number;
  }> {
    return global.multiAgentTelemetry || [];
  }

  private onItem: (item: ResponseItem) => void;
  private onLoading: (loading: boolean) => void;
  private getCommandConfirmation: OrchestratorParams["getCommandConfirmation"];
  private onLastResponseId: (lastResponseId: string) => void;

  constructor(params: OrchestratorParams) {
    this.config = params.config;
    this.approvalPolicy = params.approvalPolicy;
    this.onItem = params.onItem;
    this.onLoading = params.onLoading;
    this.getCommandConfirmation = params.getCommandConfirmation;
    this.onLastResponseId = params.onLastResponseId;
  }

  /**
   * Starts the orchestrator with an initial input
   */
  public async run(input: Array<ResponseInputItem>, previousResponseId?: string): Promise<void> {
    try {
      this.state = OrchestratorState.ARCHITECT_CALL;
      this.onLoading(true);
      this.abortController = new AbortController();
      
      // Create a system message to explain the multi-agent workflow
      this.onItem({
        id: `system-${Date.now()}`,
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: "🏗️ Running in multi-agent mode: Architect will plan changes, Coder will implement them.",
          },
        ],
      });
      
      // Call the Architect to get a change plan
      const architectResponse = await callArchitect(input, this.config, previousResponseId);
      
      // Parse and validate the change plan
      this.state = OrchestratorState.VALIDATE_PLAN;
      let changePlan: ChangePlan;
      
      try {
        changePlan = validateChangePlan(JSON.parse(architectResponse));
        this.currentPlan = changePlan;
      } catch (error) {
        // Handle JSON parsing or validation errors
        this.state = OrchestratorState.ERROR;
        this.onItem({
          id: `error-${Date.now()}`,
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: `⚠️ Architect produced an invalid change plan: ${error}`,
            },
          ],
        });
        this.onLoading(false);
        return;
      }
      
      // Display the plan to the user
      this.onItem({
        id: `plan-${Date.now()}`,
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: `📋 Architect's plan (${changePlan.actions.length} actions):\n${changePlan.actions.map((action, i) => 
              `${i+1}. [${action.kind}] ${action.kind === 'edit' 
                ? `${action.file}: ${action.description}` 
                : action.kind === 'command' 
                  ? action.cmd 
                  : action.content}`
            ).join('\n')}`,
          },
        ],
      });
      
      // Execute the plan
      this.state = OrchestratorState.EXECUTING_PLAN;
      this.currentActionIndex = 0;
      
      // Process each action in the plan
      for (let i = 0; i < changePlan.actions.length; i++) {
        this.currentActionIndex = i;
        const action = changePlan.actions[i];
        
        // Check if we've been canceled
        if (this.abortController.signal.aborted) {
          break;
        }
        
        const success = await this.processAction(action, i + 1, changePlan.actions.length);
        
        // Run health checks after each action
        const healthResult = await this.runHealthChecks(action);
        
        if (!success || !healthResult.success) {
          // Handle action failure
          this.onItem({
            id: `action-failed-${Date.now()}`,
            type: "message",
            role: "system",
            content: [
              {
                type: "input_text",
                text: `⚠️ Action ${i + 1} failed: ${healthResult.message || "Unknown error"}`,
              },
            ],
          });
          
          // Attempt mid-flight replanning with the Architect
          const replanned = await this.attemptReplan(
            action, 
            healthResult.message || "Unknown error"
          );
          
          if (!replanned) {
            this.onItem({
              id: `replan-failed-${Date.now()}`,
              type: "message",
              role: "system",
              content: [
                {
                  type: "input_text",
                  text: `⚠️ Failed to replan with Architect. Stopping execution.`,
                },
              ],
            });
            break;
          }
          
          // If replanning was successful, the replan method would have executed the new plan
          // so we just exit the original loop
          break;
        }
      }
      
      // Final health check after all actions complete
      await this.runFinalHealthChecks();
      
      // Display telemetry if complete
      this.reportTelemetry();
      
      this.state = OrchestratorState.DONE;
      this.onLoading(false);
      
    } catch (error) {
      this.state = OrchestratorState.ERROR;
      this.onItem({
        id: `error-${Date.now()}`,
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: `⚠️ Error in orchestrator: ${error}`,
          },
        ],
      });
      this.onLoading(false);
    }
  }
  
  /**
   * Cancels the current operation
   */
  public cancel(): void {
    if (this.state === OrchestratorState.IDLE || this.state === OrchestratorState.DONE) {
      return;
    }
    
    this.abortController.abort();
    this.onLoading(false);
    
    this.onItem({
      id: `cancel-${Date.now()}`,
      type: "message",
      role: "system",
      content: [
        {
          type: "input_text",
          text: "⏹️ Operation canceled by user.",
        },
      ],
    });
  }
  
  /**
   * Processes a single action from the plan
   */
  private async processAction(action: Action, index: number, total: number): Promise<boolean> {
    try {
      this.onItem({
        id: `action-start-${Date.now()}`,
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: `🔄 Executing action ${index}/${total}: [${action.kind}] ${
              action.kind === 'edit' ? path.basename(action.file) : 
              action.kind === 'command' ? action.cmd.substring(0, 40) + (action.cmd.length > 40 ? '...' : '') : 
              'message'
            }`,
          },
        ],
      });
      
      switch (action.kind) {
        case "edit":
          return await this.processEditAction(action);
        case "command":
          return await this.processCommandAction(action);
        case "message":
          return this.processMessageAction(action);
        default:
          this.onItem({
            id: `action-unknown-${Date.now()}`,
            type: "message",
            role: "system",
            content: [
              {
                type: "input_text",
                text: `⚠️ Unknown action type: ${(action as any).kind}`,
              },
            ],
          });
          return false;
      }
    } catch (error) {
      this.onItem({
        id: `action-error-${Date.now()}`,
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: `⚠️ Error processing action: ${error}`,
          },
        ],
      });
      return false;
    }
  }
  
  /**
   * Processes an edit action using the Coder agent
   */
  private async processEditAction(action: EditAction): Promise<boolean> {
    // Build context for the coder
    const context = await buildCoderContext(action, this.config);
    
    // Call the Coder to generate a patch
    const coderResponse = await callCoder(
      action,
      context.fileContent,
      this.config
    );
    
    // Parse and apply the patch
    const patchText = coderResponse.trim();
    
    // Create a synthetic patch command for the existing system
    const patchCommand: ApplyPatchCommand = {
      patchText,
      type: "apply_patch"
    };
    
    // Get confirmation based on approval policy
    const confirmation = await this.getCommandConfirmation(
      ["apply_patch", patchText],
      patchCommand
    );
    
    if (confirmation.review !== ReviewDecision.YES) {
      this.onItem({
        id: `edit-denied-${Date.now()}`,
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: confirmation.customDenyMessage || "⚠️ Edit was not approved by user.",
          },
        ],
      });
      return false;
    }
    
    try {
      // Apply the patch using the patch command provided by confirmation
      if (confirmation.applyPatch) {
        // Use the existing parsing and application logic
        // This uses the existing patch application functionality
        const result = confirmation.applyPatch.apply();
        
        if (!result.success) {
          this.onItem({
            id: `edit-failed-${Date.now()}`,
            type: "message",
            role: "system",
            content: [
              {
                type: "input_text",
                text: `⚠️ Failed to apply patch: ${result.error || "Unknown error"}`,
              },
            ],
          });
          return false;
        }
        
        // Record telemetry
        this.recordTelemetry(
          "coder",
          context.fileContent.length,
          patchText.length,
          0.0001 * patchText.length // Simple cost estimation
        );
      }
      
      this.onItem({
        id: `edit-success-${Date.now()}`,
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: `✅ Successfully edited ${action.file}`,
          },
        ],
      });
      
      return true;
    } catch (error) {
      this.onItem({
        id: `edit-error-${Date.now()}`,
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: `⚠️ Error applying patch: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      });
      return false;
    }
  }
  
  /**
   * Processes a command action
   */
  private async processCommandAction(action: CommandAction): Promise<boolean> {
    const args = { command: action.cmd.split(" ") };
    
    try {
      const { outputText, metadata } = await handleExecCommand(
        args,
        this.config,
        this.approvalPolicy,
        this.getCommandConfirmation,
        this.abortController.signal
      );
      
      // Check if command succeeded based on exit code
      const succeeded = metadata?.exit_code === 0;
      const expectedPass = action.expect !== "fail";
      
      // If the result doesn't match expectations, that's a problem
      if (succeeded !== expectedPass) {
        this.onItem({
          id: `command-unexpected-${Date.now()}`,
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: `⚠️ Command ${expectedPass ? "failed" : "succeeded"} unexpectedly: ${action.cmd}`,
            },
          ],
        });
        return false;
      }
      
      this.onItem({
        id: `command-success-${Date.now()}`,
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: `✅ Command executed as expected: ${action.cmd}`,
          },
        ],
      });
      
      return true;
    } catch (error) {
      this.onItem({
        id: `command-error-${Date.now()}`,
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: `⚠️ Error executing command: ${error}`,
          },
        ],
      });
      return false;
    }
  }
  
  /**
   * Processes a message action
   */
  private processMessageAction(action: MessageAction): boolean {
    this.onItem({
      id: `message-${Date.now()}`,
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: action.content,
        },
      ],
    });
    
    return true;
  }
  
  /**
   * Runs appropriate health checks after an action
   */
  private async runHealthChecks(action: Action): Promise<HealthCheckResult> {
    // Run different health checks based on action type
    if (action.kind === "edit") {
      // For edits, run type checking
      const result = await this.runTypeCheck();
      
      // If type check failed, we may need to do self-healing attempt
      if (!result.success && this.currentPlan) {
        // Let's try to give the Coder a chance to fix the issue
        await this.attemptSelfHealing(action, result.message);
      }
      
      return result;
    } else if (action.kind === "command") {
      // Commands are checked by their exit codes
      return { success: true, message: "" };
    }
    
    // Messages don't need health checks
    return { success: true, message: "" };
  }
  
  /**
   * Attempts to recover from a failed action by giving the Coder another chance
   * with more context about the failure
   */
  private async attemptSelfHealing(action: Action, errorMessage: string): Promise<boolean> {
    if (action.kind !== "edit") {
      return false; // Only edit actions can be self-healed for now
    }
    
    this.onItem({
      id: `healing-attempt-${Date.now()}`,
      type: "message",
      role: "system",
      content: [
        {
          type: "input_text",
          text: `🔄 Attempting to self-heal issue with ${action.file}...`,
        },
      ],
    });
    
    try {
      // Build an enriched context with error information
      const context = await buildCoderContext(action, this.config);
      
      // Call the Coder again with error information
      const retryAction = {
        ...action,
        hints: `${action.hints || ""}\n\nPrevious attempt failed with error: ${errorMessage}\nPlease fix the issues and ensure the code compiles.`
      };
      
      const coderResponse = await callCoder(
        retryAction,
        context.fileContent,
        this.config
      );
      
      // Parse and apply the patch
      const patchText = coderResponse.trim();
      
      // Create a synthetic patch command for the existing system
      const patchCommand: ApplyPatchCommand = {
        patchText,
        type: "apply_patch"
      };
      
      // In self-healing mode, we'll use the same approval policy as before
      const confirmation = await this.getCommandConfirmation(
        ["apply_patch", patchText],
        patchCommand
      );
      
      if (confirmation.review !== ReviewDecision.YES) {
        this.onItem({
          id: `healing-denied-${Date.now()}`,
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: confirmation.customDenyMessage || "⚠️ Self-healing edit was not approved by user.",
            },
          ],
        });
        return false;
      }
      
      // Apply the healing patch
      if (confirmation.applyPatch) {
        // Use the existing patch application functionality
        const result = confirmation.applyPatch.apply();
        
        if (!result.success) {
          this.onItem({
            id: `healing-failed-${Date.now()}`,
            type: "message",
            role: "system",
            content: [
              {
                type: "input_text",
                text: `⚠️ Failed to apply healing patch: ${result.error || "Unknown error"}`,
              },
            ],
          });
          return false;
        }
        
        // Record telemetry for healing attempt
        this.recordTelemetry(
          "coder-healing",
          context.fileContent.length,
          patchText.length,
          0.0001 * patchText.length
        );
        
        this.onItem({
          id: `healing-success-${Date.now()}`,
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: `✅ Successfully applied healing patch to ${action.file}`,
            },
          ],
        });
        
        // Verify healing was successful with another type check
        const healingCheck = await this.runTypeCheck();
        return healingCheck.success;
      }
      
      return false;
    } catch (error) {
      this.onItem({
        id: `healing-error-${Date.now()}`,
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: `⚠️ Error during self-healing: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      });
      return false;
    }
  }
  
  /**
   * Attempts to re-plan with the Architect when something goes wrong
   */
  private async attemptReplan(failedAction: Action, errorMessage: string): Promise<boolean> {
    this.onItem({
      id: `replan-start-${Date.now()}`,
      type: "message",
      role: "system",
      content: [
        {
          type: "input_text",
          text: `🔄 Re-planning with Architect due to error: ${errorMessage}`,
        },
      ],
    });
    
    try {
      // Create a synthetic input message explaining what went wrong
      const replanInput = [
        {
          content: [
            {
              type: "input_text",
              text: `The previous plan encountered an error at step ${this.currentActionIndex + 1} (${failedAction.kind}): ${errorMessage}\n\nPlease create a revised plan that fixes this issue.`,
            },
          ],
          role: "user",
        },
      ];
      
      // Call the Architect to get a new plan
      const architectResponse = await callArchitect(replanInput, this.config);
      
      try {
        // Parse and validate the change plan
        const newPlan = validateChangePlan(JSON.parse(architectResponse));
        
        this.onItem({
          id: `replan-success-${Date.now()}`,
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: `✅ Architect created a revised plan with ${newPlan.actions.length} actions`,
            },
          ],
        });
        
        // Display the new plan
        this.onItem({
          id: `new-plan-${Date.now()}`,
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: `📋 Architect's revised plan (${newPlan.actions.length} actions):\n${newPlan.actions.map((action, i) => 
                `${i+1}. [${action.kind}] ${action.kind === 'edit' 
                  ? `${action.file}: ${action.description}` 
                  : action.kind === 'command' 
                    ? action.cmd 
                    : action.content}`
              ).join('\n')}`,
            },
          ],
        });
        
        // Update the current plan and reset the action index
        this.currentPlan = newPlan;
        this.currentActionIndex = 0;
        
        // Continue execution with the new plan
        for (let i = 0; i < newPlan.actions.length; i++) {
          this.currentActionIndex = i;
          const action = newPlan.actions[i];
          
          // Check if we've been canceled
          if (this.abortController.signal.aborted) {
            break;
          }
          
          const success = await this.processAction(action, i + 1, newPlan.actions.length);
          
          // Run health checks after each action
          const healthResult = await this.runHealthChecks(action);
          
          if (!success || !healthResult.success) {
            // If we've already tried replanning once, don't recurse further
            this.onItem({
              id: `replan-action-failed-${Date.now()}`,
              type: "message",
              role: "system",
              content: [
                {
                  type: "input_text",
                  text: `⚠️ Action ${i + 1} in the revised plan failed: ${healthResult.message || "Unknown error"}`,
                },
              ],
            });
            break;
          }
        }
        
        return true;
      } catch (error) {
        // Handle JSON parsing or validation errors in replan
        this.onItem({
          id: `replan-invalid-${Date.now()}`,
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: `⚠️ Architect produced an invalid revised plan: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        });
        return false;
      }
    } catch (error) {
      this.onItem({
        id: `replan-error-${Date.now()}`,
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: `⚠️ Error during replanning: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      });
      return false;
    }
  }
  
  /**
   * Runs a final health check after all actions are complete
   */
  private async runFinalHealthChecks(): Promise<void> {
    try {
      // Run linting
      const lintResult = await this.runLint();
      if (!lintResult.success) {
        this.onItem({
          id: `lint-check-${Date.now()}`,
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: `⚠️ Lint check failed: ${lintResult.message}`,
            },
          ],
        });
      }
      
      // Run tests
      const testResult = await this.runTests();
      if (!testResult.success) {
        this.onItem({
          id: `test-check-${Date.now()}`,
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: `⚠️ Tests failed: ${testResult.message}`,
            },
          ],
        });
      }
    } catch (error) {
      this.onItem({
        id: `health-check-error-${Date.now()}`,
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: `⚠️ Error during health checks: ${error}`,
          },
        ],
      });
    }
  }
  
  /**
   * Runs TypeScript type checking
   */
  private async runTypeCheck(): Promise<HealthCheckResult> {
    try {
      // Check if we're in a TypeScript project
      if (fs.existsSync(path.join(process.cwd(), "tsconfig.json"))) {
        execSync("npm run typecheck", { stdio: "pipe" });
        return { success: true, message: "" };
      }
      return { success: true, message: "No TypeScript project detected" };
    } catch (error) {
      return { 
        success: false, 
        message: `Type checking failed: ${error instanceof Error ? error.message : String(error)}` 
      };
    }
  }
  
  /**
   * Runs linting
   */
  private async runLint(): Promise<HealthCheckResult> {
    try {
      // Check if we have a lint script
      const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"));
      if (packageJson.scripts && packageJson.scripts.lint) {
        execSync("npm run lint", { stdio: "pipe" });
        return { success: true, message: "" };
      }
      return { success: true, message: "No lint script found" };
    } catch (error) {
      return { 
        success: false, 
        message: `Linting failed: ${error instanceof Error ? error.message : String(error)}` 
      };
    }
  }
  
  /**
   * Runs tests
   */
  private async runTests(): Promise<HealthCheckResult> {
    try {
      // Check if we have a test script
      const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"));
      if (packageJson.scripts && packageJson.scripts.test) {
        execSync("npm test", { stdio: "pipe" });
        return { success: true, message: "" };
      }
      return { success: true, message: "No test script found" };
    } catch (error) {
      return { 
        success: false, 
        message: `Tests failed: ${error instanceof Error ? error.message : String(error)}` 
      };
    }
  }
  
  /**
   * Records telemetry data for a model call
   */
  private recordTelemetry(role: string, tokensIn: number, tokensOut: number, costUsd: number): void {
    if (global.multiAgentTelemetry) {
      global.multiAgentTelemetry.push({
        ts: Date.now(),
        role,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_usd: costUsd,
        duration_ms: 0 // Not tracking duration for these internal records
      });
    }
  }
  
  /**
   * Reports telemetry data at the end of the session
   */
  private reportTelemetry(): void {
    if (this.telemetryData.length === 0) {
      return;
    }
    
    // Calculate total tokens and cost
    const totalTokensIn = this.telemetryData.reduce((sum, item) => sum + item.tokens_in, 0);
    const totalTokensOut = this.telemetryData.reduce((sum, item) => sum + item.tokens_out, 0);
    const totalCost = this.telemetryData.reduce((sum, item) => sum + item.cost_usd, 0);
    
    // Calculate per-model stats
    const architectStats = this.telemetryData
      .filter(item => item.role === 'architect')
      .reduce(
        (acc, item) => ({
          tokens_in: acc.tokens_in + item.tokens_in,
          tokens_out: acc.tokens_out + item.tokens_out,
          cost: acc.cost + item.cost_usd
        }),
        { tokens_in: 0, tokens_out: 0, cost: 0 }
      );
    
    const coderStats = this.telemetryData
      .filter(item => item.role === 'coder' || item.role === 'coder-healing')
      .reduce(
        (acc, item) => ({
          tokens_in: acc.tokens_in + item.tokens_in,
          tokens_out: acc.tokens_out + item.tokens_out,
          cost: acc.cost + item.cost_usd
        }),
        { tokens_in: 0, tokens_out: 0, cost: 0 }
      );
    
    // Calculate hypothetical cost if everything used the Architect model
    // The cost ratio is approximately 5:1 according to the PLAN document
    const hypotheticalCost = totalCost * 5;
    const savings = hypotheticalCost - totalCost;
    const savingsPercent = Math.round((savings / hypotheticalCost) * 100);
    
    this.onItem({
      id: `telemetry-${Date.now()}`,
      type: "message",
      role: "system",
      content: [
        {
          type: "input_text",
          text: `📊 Session stats: ${totalTokensIn + totalTokensOut} tokens total (in: ${totalTokensIn}, out: ${totalTokensOut})\n` +
            `🏗️ Architect: ${architectStats.tokens_in + architectStats.tokens_out} tokens, $${architectStats.cost.toFixed(4)}\n` +
            `🔧 Coder: ${coderStats.tokens_in + coderStats.tokens_out} tokens, $${coderStats.cost.toFixed(4)}\n` +
            `💰 Two-agent savings: $${savings.toFixed(4)} (${savingsPercent}% less than single-agent)`,
        },
      ],
    });
  }
}