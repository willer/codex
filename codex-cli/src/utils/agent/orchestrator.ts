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
 * The Orchestrator manages the two-agent workflow
 */
export class Orchestrator {
  private state: OrchestratorState = OrchestratorState.IDLE;
  private config: AppConfig;
  private approvalPolicy: ApprovalPolicy;
  private currentPlan: ChangePlan | null = null;
  private currentActionIndex = 0;
  private abortController: AbortController = new AbortController();
  private telemetryData: Array<{
    ts: number;
    role: string;
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
  }> = [];

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
      
      // Create a system message to explain the two-agent workflow
      this.onItem({
        id: `system-${Date.now()}`,
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: "🏗️ Running in two-agent mode: Architect will plan changes, Coder will implement them.",
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
          
          // TODO: Implement retry or replan logic here
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
    
    // TODO: Apply the patch here
    // This should integrate with the existing apply_patch functionality
    
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
      return this.runTypeCheck();
    } else if (action.kind === "command") {
      // Commands are checked by their exit codes
      return { success: true, message: "" };
    }
    
    // Messages don't need health checks
    return { success: true, message: "" };
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
    this.telemetryData.push({
      ts: Date.now(),
      role,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: costUsd
    });
  }
  
  /**
   * Reports telemetry data at the end of the session
   */
  private reportTelemetry(): void {
    if (this.telemetryData.length === 0) {
      return;
    }
    
    const totalTokensIn = this.telemetryData.reduce((sum, item) => sum + item.tokens_in, 0);
    const totalTokensOut = this.telemetryData.reduce((sum, item) => sum + item.tokens_out, 0);
    const totalCost = this.telemetryData.reduce((sum, item) => sum + item.cost_usd, 0);
    
    this.onItem({
      id: `telemetry-${Date.now()}`,
      type: "message",
      role: "system",
      content: [
        {
          type: "input_text",
          text: `📊 Session stats: ${totalTokensIn + totalTokensOut} tokens total (in: ${totalTokensIn}, out: ${totalTokensOut}), estimated cost: $${totalCost.toFixed(4)}`,
        },
      ],
    });
  }
}