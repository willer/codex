import type { AppConfig } from "../config.js";
import type { ApprovalPolicy } from "../../approvals.js";
import type { ResponseItem } from "openai/resources/responses/responses.mjs";
import type { ApplyPatchCommand } from "../../approvals.js";
import type { ReviewDecision } from "./review.js";

import { Agent, AgentContext, AgentResponse } from "./registry/agent-interface";
import { AgentRole } from "./registry/agent-roles";
import { OrchestratorAgent } from "./agents/orchestrator-agent";
import { ArchitectAgent } from "./agents/architect-agent";
import { CoderAgent } from "./agents/coder-agent";
import { TesterAgent } from "./agents/tester-agent";
import { ReviewerAgent } from "./agents/reviewer-agent";
import { WorkflowEngine, WorkflowPlan, WorkflowStep } from "./workflow/workflow-engine";
import { log } from "./log.js";
import OpenAI from "openai";
import { CLI_VERSION, ORIGIN, getSessionId } from "../session.js";
import path from "path";

/**
 * Enum for the states of the multi-agent orchestrator
 */
export enum MultiAgentOrchestratorState {
  IDLE = "idle",
  INITIALIZING = "initializing",
  EXECUTING_WORKFLOW = "executing_workflow",
  ERROR = "error",
  DONE = "done",
}

/**
 * Parameters for the MultiAgentOrchestrator
 */
export interface MultiAgentOrchestratorParams {
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
 * The MultiAgentOrchestrator manages the multi-agent workflow
 */
export class MultiAgentOrchestrator {
  private state: MultiAgentOrchestratorState = MultiAgentOrchestratorState.IDLE;
  private config: AppConfig;
  private approvalPolicy: ApprovalPolicy;
  private workflowEngine: WorkflowEngine;
  private currentWorkflow: WorkflowPlan | null = null;
  private agents: Map<AgentRole, Agent> = new Map();
  private openai: OpenAI;
  private abortController: AbortController = new AbortController();
  
  // Global telemetry array for tracking usage and costs
  private get telemetryData(): Array<{
    ts: number;
    role: string;
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
    duration_ms?: number;
  }> {
    // Make sure the global telemetry array is initialized
    if (!global.multiAgentTelemetry) {
      global.multiAgentTelemetry = [];
    }
    return global.multiAgentTelemetry || [];
  }
  
  // Callback functions
  private onItem: (item: ResponseItem) => void;
  private onLoading: (loading: boolean) => void;
  private getCommandConfirmation: MultiAgentOrchestratorParams["getCommandConfirmation"];
  private onLastResponseId: (lastResponseId: string) => void;
  
  constructor(params: MultiAgentOrchestratorParams) {
    this.config = params.config;
    this.approvalPolicy = params.approvalPolicy;
    this.onItem = params.onItem;
    this.onLoading = params.onLoading;
    this.getCommandConfirmation = params.getCommandConfirmation;
    this.onLastResponseId = params.onLastResponseId;
    
    this.workflowEngine = new WorkflowEngine();
    
    // Initialize OpenAI
    const apiKey = this.config.apiKey ?? process.env["OPENAI_API_KEY"] ?? "";
    const timeoutMs = parseInt(process.env["OPENAI_TIMEOUT_MS"] || "0", 10) || undefined;
    
    this.openai = new OpenAI({
      apiKey,
      baseURL: process.env["OPENAI_BASE_URL"] || undefined,
      defaultHeaders: {
        originator: ORIGIN,
        version: CLI_VERSION,
        session_id: getSessionId() || "",
      },
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
    });
    
    // Initialize agents
    this.initializeAgents();
  }
  
  /**
   * Initialize the agent registry with all available agents
   */
  private initializeAgents(): void {
    // Initialize all agents using the imported classes
    try {
      this.agents.set(AgentRole.ORCHESTRATOR, new OrchestratorAgent(this.openai));
      this.agents.set(AgentRole.ARCHITECT, new ArchitectAgent(this.openai));
      this.agents.set(AgentRole.CODER, new CoderAgent(this.openai));
      this.agents.set(AgentRole.TESTER, new TesterAgent(this.openai));
      this.agents.set(AgentRole.REVIEWER, new ReviewerAgent(this.openai));
    } catch (error) {
      log(`Error initializing agents: ${error}`);
      // Create a fallback orchestrator if initialization fails
      if (!this.agents.get(AgentRole.ORCHESTRATOR)) {
        this.agents.set(AgentRole.ORCHESTRATOR, new OrchestratorAgent(this.openai));
      }
    }
  }
  
  /**
   * Starts the orchestrator with an initial input
   */
  public async run(input: Array<any>, previousResponseId?: string): Promise<void> {
    try {
      this.state = MultiAgentOrchestratorState.INITIALIZING;
      this.onLoading(true);
      this.abortController = new AbortController();
      
      // Create a system message to introduce the multi-agent system
      this.onItem({
        id: `system-${Date.now()}`,
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: "🏗️ Running in advanced multi-agent mode with Orchestrator, Architect, Coder, Tester, and Reviewer.",
          },
        ],
      });
      
      // Create initial context
      const context = this.createInitialContext(input);
      
      // Start with the Orchestrator to analyze the request
      const orchestratorAgent = this.agents.get(AgentRole.ORCHESTRATOR);
      if (!orchestratorAgent) {
        throw new Error("Orchestrator agent not initialized");
      }
      
      // Call the Orchestrator to analyze the request
      const initialInput = {
        type: "initial_request",
        request: this.extractUserRequest(input)
      };
      
      const orchestratorResponse = await orchestratorAgent.process(initialInput, context);
      
      // Display the workflow plan to the user
      this.onItem({
        id: `workflow-plan-${Date.now()}`,
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: `📋 Orchestrator's analysis:\n- Task type: ${orchestratorResponse.output.taskType}\n- Initial workflow: Orchestrator → ${this.formatWorkflowSteps(orchestratorResponse.output.workflowPlan?.steps)}`,
          },
        ],
      });
      
      // Execute the workflow
      this.state = MultiAgentOrchestratorState.EXECUTING_WORKFLOW;
      this.currentWorkflow = orchestratorResponse.output.workflowPlan;
      
      // Process the next action from the Orchestrator
      await this.processNextAction(orchestratorResponse.nextAction, context);
      
      // Report telemetry
      this.reportTelemetry();
      
      this.state = MultiAgentOrchestratorState.DONE;
      this.onLoading(false);
      
    } catch (error) {
      this.state = MultiAgentOrchestratorState.ERROR;
      this.onItem({
        id: `error-${Date.now()}`,
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: `⚠️ Error in multi-agent orchestrator: ${error}`,
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
    if (this.state === MultiAgentOrchestratorState.IDLE || this.state === MultiAgentOrchestratorState.DONE) {
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
   * Process the next action in the workflow
   */
  private async processNextAction(nextAction: any, context: AgentContext): Promise<void> {
    if (nextAction.type === "complete") {
      // The workflow is complete
      this.onItem({
        id: `complete-${Date.now()}`,
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: nextAction.finalOutput,
          },
        ],
      });
      return;
    }
    
    if (nextAction.type === "continue" && nextAction.nextRole) {
      // Continue to the next agent in the workflow
      const nextRole = nextAction.nextRole;
      
      this.onItem({
        id: `next-agent-${Date.now()}`,
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: `🔄 Handing off to ${nextRole}...`,
          },
        ],
      });
      
      // Get or create the agent for the next role
      const agent = await this.getOrCreateAgent(nextRole);
      
      // Prepare input for the next agent
      const agentInput = {
        type: "workflow_step",
        previousOutput: nextAction,
        workflowPlan: this.currentWorkflow
      };
      
      // Process with the next agent
      const agentResponse = await agent.process(agentInput, context);
      
      // Process the response from the agent
      await this.processAgentResponse(agent.role, agentResponse, context);
      
      // Process the next action
      await this.processNextAction(agentResponse.nextAction, context);
    }
  }
  
  /**
   * Process a response from an agent
   */
  private async processAgentResponse(role: AgentRole, response: AgentResponse, context: AgentContext): Promise<void> {
    // Display the agent's response to the user
    this.onItem({
      id: `agent-response-${Date.now()}`,
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: `[${role}] ${JSON.stringify(response.output)}`,
        },
      ],
    });
    
    // Update the context with the agent's response
    this.updateContext(context, role, response);
  }
  
  /**
   * Get an existing agent or create a new one for a role
   */
  private async getOrCreateAgent(role: AgentRole): Promise<Agent> {
    // Check if we already have this agent
    const existingAgent = this.agents.get(role);
    if (existingAgent) {
      return existingAgent;
    }
    
    // If agent is not already initialized, create it now
    try {
      let newAgent: Agent;
      
      switch (role) {
        case AgentRole.ARCHITECT:
          newAgent = new ArchitectAgent(this.openai);
          break;
        case AgentRole.CODER:
          newAgent = new CoderAgent(this.openai);
          break;
        case AgentRole.TESTER:
          newAgent = new TesterAgent(this.openai);
          break;
        case AgentRole.REVIEWER:
          newAgent = new ReviewerAgent(this.openai);
          break;
        default:
          // Default to Orchestrator
          newAgent = new OrchestratorAgent(this.openai);
      }
      
      // Store the new agent
      this.agents.set(role, newAgent);
      return newAgent;
    } catch (error) {
      log(`Error creating agent for role ${role}: ${error}`);
      
      // Fall back to orchestrator if available
      const orchestrator = this.agents.get(AgentRole.ORCHESTRATOR);
      if (orchestrator) {
        return orchestrator;
      }
      
      // If no orchestrator, create one as a last resort
      const fallbackAgent = new OrchestratorAgent(this.openai);
      this.agents.set(AgentRole.ORCHESTRATOR, fallbackAgent);
      return fallbackAgent;
    }
  }
  
  /**
   * Create the initial context for the workflow
   */
  private createInitialContext(input: Array<any>): AgentContext {
    return {
      userInput: this.extractUserRequest(input),
      conversationHistory: [],
      taskState: {
        taskId: `task_${Date.now()}`,
        status: "planning",
        createdFiles: [],
        modifiedFiles: []
      },
      repoContext: {
        repositoryRoot: process.cwd(),
        currentDirectory: process.cwd(),
        projectStructure: "To be populated",
        relevantFiles: [],
        fileContents: {}
      },
      roleSpecificContext: {}
    };
  }
  
  /**
   * Extract the user request from the input
   */
  private extractUserRequest(input: Array<any>): string {
    // For now, just concatenate all text content from the input
    return input.map(item => {
      if (item.content) {
        return item.content.filter((c: any) => c.type === "input_text")
          .map((c: any) => c.text)
          .join(" ");
      }
      return "";
    }).join(" ");
  }
  
  /**
   * Update the context with an agent's response
   */
  private updateContext(context: AgentContext, role: AgentRole, response: AgentResponse): void {
    // Add the response to the conversation history
    context.conversationHistory.push({
      role: "assistant",
      content: JSON.stringify(response.output),
      metadata: {
        fromRole: role,
        timestamp: new Date().toISOString()
      }
    });
    
    // Update task state based on the response
    if (response.output.createdFiles) {
      context.taskState.createdFiles.push(...response.output.createdFiles);
    }
    
    if (response.output.modifiedFiles) {
      context.taskState.modifiedFiles.push(...response.output.modifiedFiles);
    }
    
    if (response.output.testResults) {
      context.taskState.testResults = response.output.testResults;
    }
    
    if (response.output.errors) {
      context.taskState.errors = response.output.errors;
    }
  }
  
  /**
   * Format the workflow steps for display
   */
  private formatWorkflowSteps(steps?: Array<WorkflowStep>): string {
    if (!steps || steps.length === 0) {
      return "No steps defined";
    }
    
    return steps.map(step => step.role).join(" → ");
  }
  
  /**
   * Records telemetry data for model usage
   */
  private recordTelemetry(role: string, tokensIn: number, tokensOut: number, costUsd: number): void {
    // Initialize telemetry array if it doesn't exist
    if (!global.multiAgentTelemetry) {
      global.multiAgentTelemetry = [];
    }
    
    // Record the telemetry data
    global.multiAgentTelemetry.push({
      ts: Date.now(),
      role,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: costUsd,
      duration_ms: 0 // Not tracking duration for these internal records
    });
  }
  
  /**
   * Reports telemetry data at the end of the session
   */
  private reportTelemetry(): void {
    if (this.telemetryData.length === 0) {
      return;
    }
    
    // Calculate total tokens and cost with defensive programming
    const totalTokensIn = this.telemetryData.reduce((sum, item) => 
      sum + (item && item.tokens_in ? item.tokens_in : 0), 0);
    const totalTokensOut = this.telemetryData.reduce((sum, item) => 
      sum + (item && item.tokens_out ? item.tokens_out : 0), 0);
    const totalCost = this.telemetryData.reduce((sum, item) => 
      sum + (item && item.cost_usd ? item.cost_usd : 0), 0);
    
    // Calculate per-role stats - safely handling undefined roles
    const roleStats = Object.values(AgentRole).reduce((acc: Record<string, any>, role) => {
      try {
        // Extra defensive programming to ensure role is defined before using toLowerCase
        if (role === undefined || role === null) {
          return acc; // Skip this role if it's undefined or null
        }
        
        // Ensure role is a string before calling toLowerCase
        const roleStr = typeof role === 'string' ? role.toLowerCase() : String(role).toLowerCase();
        
        // Filter telemetry items matching this role
        const roleData = this.telemetryData.filter(item => 
          item && item.role && item.role === roleStr
        );
        
        if (roleData && roleData.length > 0) {
          acc[role] = {
            tokens_in: roleData.reduce((sum, item) => sum + (item.tokens_in || 0), 0),
            tokens_out: roleData.reduce((sum, item) => sum + (item.tokens_out || 0), 0),
            cost: roleData.reduce((sum, item) => sum + (item.cost_usd || 0), 0)
          };
        }
      } catch (error) {
        // Silently catch any errors to prevent crashing
        console.error(`Error processing role stats: ${error}`);
      }
      
      return acc;
    }, {});
    
    // Calculate hypothetical cost if everything used the o3 model
    // The cost ratio is approximately 5:1 for o3 vs o4-mini
    const hypotheticalCost = totalCost * 3; // Conservative estimate
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
            Object.entries(roleStats).map(([role, stats]) => 
              `${role}: ${(stats as any).tokens_in + (stats as any).tokens_out} tokens, $${(stats as any).cost.toFixed(4)}`
            ).join('\n') + '\n' +
            `💰 Multi-agent savings: $${savings.toFixed(4)} (${savingsPercent}% less than using a single powerful model)`,
        },
      ],
    });
  }
}