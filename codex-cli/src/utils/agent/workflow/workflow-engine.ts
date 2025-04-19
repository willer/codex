import { AgentRole } from "../registry/agent-roles";
import { TaskState } from "../registry/agent-interface";

/**
 * Represents a step in the workflow
 */
export interface WorkflowStep {
  role: AgentRole;
  input: any;
  output?: any;
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
}

/**
 * Represents the overall workflow plan
 */
export interface WorkflowPlan {
  id: string;
  steps: Array<WorkflowStep>;
  currentStepIndex: number;
  status: "planning" | "executing" | "completed" | "failed";
  userInput: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Engine for creating and managing workflow plans
 */
export class WorkflowEngine {
  /**
   * Creates an initial workflow plan based on user input
   */
  createInitialPlan(userInput: string): WorkflowPlan {
    // Default workflow: Orchestrator -> Architect -> Coder -> Tester -> Reviewer
    const initialSteps: Array<WorkflowStep> = [
      {
        role: AgentRole.ORCHESTRATOR,
        input: {
          type: "initial_request",
          request: userInput
        },
        status: "pending"
      }
    ];
    
    return {
      id: `workflow_${Date.now()}`,
      steps: initialSteps,
      currentStepIndex: 0,
      status: "planning",
      userInput,
      createdAt: new Date(),
      updatedAt: new Date()
    };
  }
  
  /**
   * Determines the next agent to use based on the current state and workflow
   */
  determineNextAgent(currentState: TaskState, currentRole: AgentRole): AgentRole | null {
    // If the task failed, we need to handle it differently
    if (currentState.status === "failed") {
      return this.handleFailure(currentState, currentRole);
    }
    
    // Default sequence for implementation tasks
    const defaultSequence = [
      AgentRole.ORCHESTRATOR,
      AgentRole.ARCHITECT,
      AgentRole.CODER,
      AgentRole.TESTER,
      AgentRole.REVIEWER
    ];
    
    // Find the current role in the sequence
    const currentIndex = defaultSequence.indexOf(currentRole);
    
    // If we're at the end of the sequence or not found, return null
    if (currentIndex === -1 || currentIndex === defaultSequence.length - 1) {
      return null;
    }
    
    // Otherwise, return the next role in the sequence
    return defaultSequence[currentIndex + 1];
  }
  
  /**
   * Handles failure states by determining which agent should fix the issue
   */
  private handleFailure(state: TaskState, currentRole: AgentRole): AgentRole {
    // If there are syntax errors or type errors, send to Coder
    if (state.errors?.some(e => 
      e.message.includes("syntax") || 
      e.message.includes("type") ||
      e.message.includes("undefined variable")
    )) {
      return AgentRole.CODER;
    }
    
    // If there are test failures, send to Tester
    if (state.testResults && Object.values(state.testResults).some(result => !result)) {
      return AgentRole.TESTER;
    }
    
    // For architectural issues or more complex problems, escalate to Architect
    return AgentRole.ARCHITECT;
  }
  
  /**
   * Revises a workflow plan based on new information
   */
  reviseWorkflowPlan(plan: WorkflowPlan, reason: string, suggestedRole?: AgentRole): WorkflowPlan {
    // Create a copy of the plan
    const revisedPlan: WorkflowPlan = {
      ...plan,
      updatedAt: new Date()
    };
    
    // Mark the current step as failed
    const currentStep = revisedPlan.steps[revisedPlan.currentStepIndex];
    currentStep.status = "failed";
    
    // Add a new step with the suggested role, or default to Orchestrator
    const nextRole = suggestedRole || AgentRole.ORCHESTRATOR;
    
    revisedPlan.steps.splice(revisedPlan.currentStepIndex + 1, 0, {
      role: nextRole,
      input: {
        type: "revision",
        reason,
        previousStep: currentStep
      },
      status: "pending"
    });
    
    // Move to the new step
    revisedPlan.currentStepIndex++;
    
    return revisedPlan;
  }
}