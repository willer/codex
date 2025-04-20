// Multi-Agent Orchestrator
import { log, isLoggingEnabled } from "../log.js";
import { AppConfig } from "../../config.js";
import { AgentRole, AgentConfig, defaultAgentConfigs } from "./agent-registry";
import { createAgent } from "./agent-implementations";
import { WorkflowEngine, WorkflowPlan } from "./workflow-engine";
import { 
  Agent, 
  AgentContext, 
  AgentResponse, 
  Message, 
  RepoContext,
  TaskState
} from "./agent-interface";
import { ResponseItem } from "openai/resources/responses/responses.mjs";
import { randomUUID } from "node:crypto";

/**
 * Options for the multi-agent orchestrator
 */
export interface MultiAgentOrchestratorOptions {
  config: AppConfig;
  sessionId?: string;
  onResponse?: (response: string) => void;
  onStateChange?: (state: TaskState) => void;
  onStepCompleted?: (role: AgentRole, output: any) => void;
  onWorkflowPlanChanged?: (plan: WorkflowPlan) => void;
}

/**
 * The MultiAgentOrchestrator is the main entry point for the multi-agent system.
 * It initializes and manages all the agents and the workflow engine.
 */
export class MultiAgentOrchestrator {
  private config: AppConfig;
  private agents: Map<AgentRole, Agent>;
  private context: AgentContext;
  private workflowEngine: WorkflowEngine | null = null;
  private sessionId: string;
  private apiKey: string;
  private options: MultiAgentOrchestratorOptions;

  constructor(options: MultiAgentOrchestratorOptions) {
    this.options = options;
    this.config = options.config;
    this.sessionId = options.sessionId || randomUUID().replaceAll("-", "");
    this.apiKey = this.config.apiKey || process.env.OPENAI_API_KEY || "";
    
    // Initialize agents
    this.agents = new Map();
    
    // Initialize empty context
    this.context = {
      userInput: "",
      conversationHistory: [],
      taskState: {
        status: "planning",
        currentStep: 0,
        totalSteps: 0
      },
      repoContext: {
        rootPath: process.cwd(),
        fileStructure: [],
        gitInfo: {
          currentBranch: "",
          isClean: true
        }
      },
      roleSpecificContext: {}
    };
  }

  /**
   * Initialize all the agents with their configurations
   */
  public initialize(): void {
    if (isLoggingEnabled()) {
      log("[MultiAgentOrchestrator] Initializing agents");
    }
    
    // Initialize all agents
    for (const role of Object.values(AgentRole)) {
      // Get agent config, using the model from the config if specified
      const baseConfig = { ...defaultAgentConfigs[role] };
      
      // Check if we have a model override from the config
      const multiAgentModels = this.config?.multiAgent?.models;
      if (multiAgentModels && multiAgentModels[role]) {
        baseConfig.model = multiAgentModels[role];
      } else if (this.config.model) {
        // If no specific model for this role but a global model is set, use that
        baseConfig.model = this.config.model;
      }
      
      // Check if the role is disabled in the config
      const enabledRoles = this.config?.multiAgent?.enabledRoles;
      if (enabledRoles && enabledRoles[role] === false) {
        if (isLoggingEnabled()) {
          log(`[MultiAgentOrchestrator] Skipping disabled agent role: ${role}`);
        }
        continue;
      }
      
      // Create the agent
      const agent = createAgent(role, baseConfig, this.apiKey, this.sessionId);
      this.agents.set(role, agent);
      
      if (isLoggingEnabled()) {
        log(`[MultiAgentOrchestrator] Initialized ${role} agent with model ${baseConfig.model}`);
      }
    }
    
    // Initialize repository context
    this.initializeRepoContext();
  }

  /**
   * Set up the repository context
   */
  public setRepoContext(repoContext: RepoContext): void {
    this.context.repoContext = repoContext;
  }
  
  /**
   * Initialize repository context from the current directory
   */
  public initializeRepoContext(): void {
    try {
      const cwd = process.cwd();
      
      // Use Node's built-in child_process module
      const { execSync } = require('child_process');
      
      // Check if in git repo (safely - catch any errors)
      let isGitRepo = false;
      try {
        execSync('git rev-parse --is-inside-work-tree', { 
          cwd, 
          stdio: 'ignore',
          timeout: 3000 // 3 seconds timeout to prevent hanging
        });
        isGitRepo = true;
      } catch (err) {
        if (isLoggingEnabled()) {
          log(`[MultiAgentOrchestrator] Not in a git repo: ${err}`);
        }
        isGitRepo = false;
      }
      
      // Default repository context
      const repoContext: RepoContext = {
        rootPath: cwd,
        fileStructure: [],
        gitInfo: {
          currentBranch: "",
          isClean: true
        }
      };
      
      if (isGitRepo) {
        try {
          // Get file structure
          const gitLsOutput = execSync('git ls-files', { cwd }).toString().trim();
          repoContext.fileStructure = gitLsOutput.split('\n')
            .filter(file => 
              !file.match(/\.(png|jpg|jpeg|gif|ico|ttf|woff|woff2|eot|mp3|mp4|mov|zip|tar\.gz)$/i) &&
              !file.includes('node_modules/') &&
              !file.includes('.git/')
            )
            .slice(0, 200); // Limit to avoid context overflow
          
          // Get Git information
          repoContext.gitInfo = {
            currentBranch: execSync('git rev-parse --abbrev-ref HEAD', { cwd }).toString().trim(),
            isClean: execSync('git status --porcelain', { cwd }).toString().trim() === ""
          };
          
          // Try to get last commit information
          try {
            const lastCommitHash = execSync('git rev-parse HEAD', { cwd }).toString().trim();
            const lastCommitMessage = execSync('git log -1 --pretty=%B', { cwd }).toString().trim();
            const lastCommitAuthor = execSync('git log -1 --pretty=%an', { cwd }).toString().trim();
            const lastCommitDate = execSync('git log -1 --pretty=%ad', { cwd }).toString().trim();
            
            repoContext.gitInfo.lastCommit = {
              hash: lastCommitHash,
              message: lastCommitMessage,
              author: lastCommitAuthor,
              date: lastCommitDate
            };
          } catch (error) {
            if (isLoggingEnabled()) {
              log(`[MultiAgentOrchestrator] Error getting git commit info: ${error}`);
            }
          }
        } catch (error) {
          if (isLoggingEnabled()) {
            log(`[MultiAgentOrchestrator] Error initializing repo context: ${error}`);
          }
        }
      }
      
      // Set the repository context
      this.setRepoContext(repoContext);
      
      if (isLoggingEnabled()) {
        log(`[MultiAgentOrchestrator] Initialized repo context with ${repoContext.fileStructure.length} files`);
      }
    } catch (error) {
      if (isLoggingEnabled()) {
        log(`[MultiAgentOrchestrator] Failed to initialize repo context: ${error}`);
      }
    }
  }

  /**
   * Cancel the current execution
   */
  public cancel(): void {
    if (isLoggingEnabled()) {
      log("[MultiAgentOrchestrator] Canceling current execution");
    }
    
    // If we have a workflow engine, try to cancel it
    if (this.workflowEngine) {
      // Mark task as canceled
      this.context.taskState.status = "failed";
      
      // Notify listeners
      if (this.options.onStateChange) {
        this.options.onStateChange(this.context.taskState);
      }
    }
  }
  
  /**
   * Terminate the orchestrator
   */
  public terminate(): void {
    if (isLoggingEnabled()) {
      log("[MultiAgentOrchestrator] Terminating orchestrator");
    }
    
    // Clear the agents
    this.agents.clear();
    
    // Reset the workflow engine
    this.workflowEngine = null;
    
    // Mark task as failed
    this.context.taskState.status = "failed";
    
    // Notify listeners
    if (this.options.onStateChange) {
      this.options.onStateChange(this.context.taskState);
    }
  }

  public async executeRequest(userInput: string): Promise<AgentResponse> {
    if (isLoggingEnabled()) {
      log(`[MultiAgentOrchestrator] Executing request: ${userInput}`);
    }
    
    // Initialize agents if not already done
    if (this.agents.size === 0) {
      this.initialize();
    }
    
    // Update context with user input
    this.context.userInput = userInput;
    
    // Add to conversation history
    this.context.conversationHistory.push({
      role: "user",
      content: userInput,
      timestamp: Date.now()
    });
    
    // Reset task state
    this.context.taskState = {
      status: "planning",
      currentStep: 0,
      totalSteps: 0
    };
    
    // Notify listeners
    if (this.options.onStateChange) {
      this.options.onStateChange(this.context.taskState);
    }
    
    // Initialize workflow engine
    this.workflowEngine = new WorkflowEngine(
      this.agents,
      this.context,
      {
        onStepCompleted: (step) => {
          if (isLoggingEnabled()) {
            log(`[MultiAgentOrchestrator] Step completed: ${step.role}`);
          }
          
          // Add to conversation history
          this.context.conversationHistory.push({
            role: step.role,
            content: JSON.stringify(step.output),
            timestamp: Date.now(),
            metadata: { output: step.output }
          });
          
          // Notify listeners
          if (this.options.onStepCompleted) {
            this.options.onStepCompleted(step.role, step.output);
          }
        },
        onPlanUpdated: (plan) => {
          if (isLoggingEnabled()) {
            log(`[MultiAgentOrchestrator] Plan updated: ${plan.status}, ${plan.currentStepIndex}/${plan.steps.length} steps`);
          }
          
          // Update task state
          this.context.taskState = {
            status: plan.status,
            currentStep: plan.currentStepIndex + 1,
            totalSteps: plan.steps.length,
            plan: {
              steps: plan.steps.map(step => ({
                role: step.role,
                action: typeof step.input === 'object' ? (step.input.description || JSON.stringify(step.input)) : String(step.input),
                description: step.status
              }))
            }
          };
          
          // Notify listeners
          if (this.options.onStateChange) {
            this.options.onStateChange(this.context.taskState);
          }
          
          if (this.options.onWorkflowPlanChanged) {
            this.options.onWorkflowPlanChanged(plan);
          }
        }
      }
    );
    
    // Execute the workflow
    await this.workflowEngine.execute();
    
    // Get final results
    const finalOutput = this.getFinalOutput();
    
    if (this.options.onResponse) {
      this.options.onResponse(finalOutput.finalOutput);
    }
    
    return {
      output: {
        message: finalOutput.finalOutput,
        workflowCompleted: this.context.taskState.status === "completed"
      },
      nextAction: { type: "complete", finalOutput: finalOutput.finalOutput },
      metadata: { sessionId: this.sessionId }
    };
  }

  /**
   * Process a function call from an agent
   */
  public async processFunctionCall(item: ResponseItem): Promise<ResponseItem[]> {
    // Implementation depends on the specific function call
    // This will be customized based on the types of function calls needed
    return [];
  }

  /**
   * Get the final output from the workflow
   */
  private getFinalOutput(): { finalOutput: string } {
    // Find the reviewer's final output if available
    const reviewerOutput = this.context.conversationHistory
      .filter(msg => msg.role === AgentRole.REVIEWER)
      .slice(-1)[0];
    
    if (reviewerOutput && reviewerOutput.metadata?.output?.finalResponse) {
      return { finalOutput: reviewerOutput.metadata.output.finalResponse };
    }
    
    // If no reviewer output, check for any completed agent's output
    for (const role of [AgentRole.REVIEWER, AgentRole.TESTER, AgentRole.CODER, AgentRole.ARCHITECT, AgentRole.ORCHESTRATOR]) {
      const output = this.context.conversationHistory
        .filter(msg => msg.role === role)
        .slice(-1)[0];
      
      if (output) {
        if (typeof output.metadata?.output?.message === 'string') {
          return { finalOutput: output.metadata.output.message };
        } else if (typeof output.content === 'string') {
          try {
            const parsed = JSON.parse(output.content);
            if (typeof parsed.message === 'string') {
              return { finalOutput: parsed.message };
            }
          } catch (e) {
            // If parsing fails, just use the content
            return { finalOutput: output.content };
          }
        }
      }
    }
    
    // Fallback
    return {
      finalOutput: this.context.taskState.status === "completed"
        ? "Task completed successfully."
        : "Task could not be completed."
    };
  }
}