// Workflow Engine for the Multi-Agent architecture
import { log, isLoggingEnabled } from "../log.js";
import { AgentRole } from "./agent-registry";
import { Agent, AgentContext, NextAction } from "./agent-interface";

/**
 * Represents a workflow step in the multi-agent system
 */
export interface WorkflowStep {
  role: AgentRole;
  input: any;
  output?: any;
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
}

/**
 * Represents a workflow plan for the multi-agent system
 */
export interface WorkflowPlan {
  steps: Array<WorkflowStep>;
  currentStepIndex: number;
  status: "planning" | "executing" | "completed" | "failed";
}

/**
 * Options for the workflow engine
 */
export interface WorkflowEngineOptions {
  maxSteps?: number;
  timeoutMs?: number;
  onStepCompleted?: (step: WorkflowStep) => void;
  onPlanUpdated?: (plan: WorkflowPlan) => void;
}

/**
 * The Workflow Engine orchestrates the multi-agent workflow
 */
export class WorkflowEngine {
  private agents: Map<AgentRole, Agent>;
  private plan: WorkflowPlan;
  private context: AgentContext;
  private options: WorkflowEngineOptions;

  constructor(
    agents: Map<AgentRole, Agent>,
    context: AgentContext,
    options: WorkflowEngineOptions = {}
  ) {
    this.agents = agents;
    this.context = context;
    this.options = {
      maxSteps: 20,
      timeoutMs: 300000, // 5 minutes
      ...options
    };
    
    // Initialize empty plan
    this.plan = {
      steps: [],
      currentStepIndex: -1,
      status: "planning"
    };
  }

  /**
   * Creates an initial workflow plan
   */
  async createPlan(): Promise<WorkflowPlan> {
    if (isLoggingEnabled()) {
      log("[WorkflowEngine] Creating initial plan");
    }
    
    this.plan.status = "planning";
    
    // The Orchestrator is always the first agent to create the plan
    const orchestrator = this.agents.get(AgentRole.ORCHESTRATOR);
    if (!orchestrator) {
      throw new Error("Orchestrator agent is not available");
    }
    
    // Get initial plan from orchestrator
    const response = await orchestrator.process({
      type: "plan_request",
      userInput: this.context.userInput
    }, this.context);
    
    // Build the plan from orchestrator's response
    if (response.output?.plan?.steps) {
      this.plan.steps = response.output.plan.steps.map((step: any) => ({
        role: step.role,
        input: {
          type: "task",
          description: step.action
        },
        status: "pending"
      }));
      
      // Update plan metadata
      this.plan.currentStepIndex = 0;
      this.plan.status = "executing";
      
      if (this.options.onPlanUpdated) {
        this.options.onPlanUpdated(this.plan);
      }
    } else {
      throw new Error("Orchestrator failed to create a valid plan");
    }
    
    return this.plan;
  }

  /**
   * Executes the workflow based on the current plan
   */
  async execute(): Promise<void> {
    // Create plan if not already done
    if (this.plan.status === "planning" || this.plan.steps.length === 0) {
      await this.createPlan();
    }
    
    // Track execution time for timeout
    const startTime = Date.now();
    let stepCount = 0;
    
    while (
      this.plan.currentStepIndex < this.plan.steps.length && 
      this.plan.status === "executing" && 
      stepCount < (this.options.maxSteps || Infinity) &&
      Date.now() - startTime < (this.options.timeoutMs || Infinity)
    ) {
      const currentStep = this.plan.steps[this.plan.currentStepIndex];
      
      if (isLoggingEnabled()) {
        log(`[WorkflowEngine] Executing step ${this.plan.currentStepIndex + 1}/${this.plan.steps.length}: ${currentStep.role}`);
      }
      
      currentStep.status = "in_progress";
      if (this.options.onPlanUpdated) {
        this.options.onPlanUpdated(this.plan);
      }
      
      try {
        // Get the agent for the current step
        const agent = this.agents.get(currentStep.role);
        if (!agent) {
          throw new Error(`Agent for role ${currentStep.role} not found`);
        }
        
        // Process the step
        const response = await agent.process(currentStep.input, this.context);
        
        // Update step with output
        currentStep.output = response.output;
        currentStep.status = "completed";
        
        // Handle next action based on agent's response
        await this.handleNextAction(response.nextAction);
        
        // Notify listeners
        if (this.options.onStepCompleted) {
          this.options.onStepCompleted(currentStep);
        }
        
        if (this.options.onPlanUpdated) {
          this.options.onPlanUpdated(this.plan);
        }
        
        stepCount++;
      } catch (error) {
        currentStep.status = "failed";
        currentStep.output = { error: error instanceof Error ? error.message : String(error) };
        
        if (isLoggingEnabled()) {
          log(`[WorkflowEngine] Step failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        
        // Try to recover with orchestrator
        await this.attemptRecovery(error);
        
        if (this.options.onPlanUpdated) {
          this.options.onPlanUpdated(this.plan);
        }
      }
    }
    
    // Check if we completed all steps
    if (this.plan.currentStepIndex >= this.plan.steps.length) {
      this.plan.status = "completed";
      if (isLoggingEnabled()) {
        log("[WorkflowEngine] Workflow completed successfully");
      }
    } else if (Date.now() - startTime >= (this.options.timeoutMs || Infinity)) {
      this.plan.status = "failed";
      if (isLoggingEnabled()) {
        log("[WorkflowEngine] Workflow timed out");
      }
    } else if (stepCount >= (this.options.maxSteps || Infinity)) {
      this.plan.status = "failed";
      if (isLoggingEnabled()) {
        log("[WorkflowEngine] Workflow exceeded maximum number of steps");
      }
    }
    
    if (this.options.onPlanUpdated) {
      this.options.onPlanUpdated(this.plan);
    }
  }

  /**
   * Handles the next action specified by an agent
   */
  private async handleNextAction(nextAction: NextAction): Promise<void> {
    switch (nextAction.type) {
      case "continue":
        // Move to the next step or specific agent
        if (nextAction.nextRole) {
          // Find the next step with the specified role
          const nextIndex = this.plan.steps.findIndex(
            (step, index) => index > this.plan.currentStepIndex && step.role === nextAction.nextRole
          );
          
          if (nextIndex !== -1) {
            // Skip steps in between
            for (let i = this.plan.currentStepIndex + 1; i < nextIndex; i++) {
              this.plan.steps[i].status = "skipped";
            }
            this.plan.currentStepIndex = nextIndex;
          } else {
            // Role not found, continue to next step
            this.plan.currentStepIndex++;
          }
        } else {
          // Simply move to next step
          this.plan.currentStepIndex++;
        }
        break;
        
      case "reject":
        // Current agent rejected the task; suggest another agent
        if (isLoggingEnabled()) {
          log(`[WorkflowEngine] Agent ${this.plan.steps[this.plan.currentStepIndex].role} rejected task: ${nextAction.reason}`);
        }
        
        // Add a new step for the suggested role
        this.plan.steps.splice(this.plan.currentStepIndex + 1, 0, {
          role: nextAction.suggestedRole,
          input: {
            type: "recovery",
            reason: nextAction.reason,
            previousRole: this.plan.steps[this.plan.currentStepIndex].role,
            previousInput: this.plan.steps[this.plan.currentStepIndex].input
          },
          status: "pending"
        });
        
        // Move to the new step
        this.plan.currentStepIndex++;
        break;
        
      case "complete":
        // Task is complete, mark all remaining steps as skipped
        for (let i = this.plan.currentStepIndex + 1; i < this.plan.steps.length; i++) {
          this.plan.steps[i].status = "skipped";
        }
        
        // Set current step to the end
        this.plan.currentStepIndex = this.plan.steps.length;
        this.plan.status = "completed";
        break;
        
      case "question":
        // Agent has a question for another agent
        if (isLoggingEnabled()) {
          log(`[WorkflowEngine] Agent ${this.plan.steps[this.plan.currentStepIndex].role} has a question for ${nextAction.targetRole}`);
        }
        
        // Insert a new step for the target role to answer the question
        this.plan.steps.splice(this.plan.currentStepIndex + 1, 0, {
          role: nextAction.targetRole,
          input: {
            type: "question",
            question: nextAction.question,
            askedBy: this.plan.steps[this.plan.currentStepIndex].role
          },
          status: "pending"
        });
        
        // And another step for the original agent to continue after getting the answer
        this.plan.steps.splice(this.plan.currentStepIndex + 2, 0, {
          role: this.plan.steps[this.plan.currentStepIndex].role,
          input: {
            type: "continue_after_question",
            originalInput: this.plan.steps[this.plan.currentStepIndex].input
          },
          status: "pending"
        });
        
        // Move to the question step
        this.plan.currentStepIndex++;
        break;
    }
  }

  /**
   * Attempts to recover from a failed step
   */
  private async attemptRecovery(error: unknown): Promise<void> {
    if (isLoggingEnabled()) {
      log(`[WorkflowEngine] Attempting recovery from error: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    const orchestrator = this.agents.get(AgentRole.ORCHESTRATOR);
    if (!orchestrator) {
      this.plan.status = "failed";
      return;
    }
    
    try {
      // Ask orchestrator for recovery plan
      const response = await orchestrator.process({
        type: "recovery",
        error: error instanceof Error ? error.message : String(error),
        failedStep: this.plan.steps[this.plan.currentStepIndex]
      }, this.context);
      
      if (response.nextAction.type === "continue" && response.output?.recoveryPlan) {
        // Replace current plan with recovery plan
        const currentIndex = this.plan.currentStepIndex;
        
        // Replace remaining steps with recovery plan
        this.plan.steps.splice(
          currentIndex + 1,
          this.plan.steps.length - currentIndex - 1,
          ...response.output.recoveryPlan.map((step: any) => ({
            role: step.role,
            input: {
              type: "recovery_task",
              description: step.action,
              originalError: error instanceof Error ? error.message : String(error)
            },
            status: "pending"
          }))
        );
        
        // Move to the first recovery step
        this.plan.currentStepIndex++;
        
        if (this.options.onPlanUpdated) {
          this.options.onPlanUpdated(this.plan);
        }
      } else {
        // No recovery plan, mark as failed
        this.plan.status = "failed";
      }
    } catch (recoveryError) {
      // Recovery itself failed
      if (isLoggingEnabled()) {
        log(`[WorkflowEngine] Recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
      }
      this.plan.status = "failed";
    }
  }
}