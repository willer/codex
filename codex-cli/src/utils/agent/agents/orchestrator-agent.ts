import { Agent, AgentContext, AgentResponse, buildContextForAgent } from "../registry/agent-interface";
import { AgentRole } from "../registry/agent-roles";
import { WorkflowEngine } from "../workflow/workflow-engine";
import { log } from "../log";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

/**
 * The Orchestrator agent coordinates the entire multi-agent workflow
 */
export class OrchestratorAgent implements Agent {
  role = AgentRole.ORCHESTRATOR;
  private openai: OpenAI;
  private workflowEngine: WorkflowEngine;
  
  constructor(openai: OpenAI) {
    this.openai = openai;
    this.workflowEngine = new WorkflowEngine();
  }
  
  /**
   * Process a request and determine the next steps in the workflow
   */
  async process(input: any, context: AgentContext): Promise<AgentResponse> {
    // Build the context slice specific to the Orchestrator
    buildContextForAgent(this.role, context);
    
    // Determine the type of request
    if (input.type === "initial_request") {
      return this.handleInitialRequest(input);
    } else if (input.type === "workflow_step") {
      return this.handleWorkflowStep(input);
    } else {
      return {
        output: { error: "Unknown input type" },
        nextAction: { 
          type: "reject", 
          reason: "Orchestrator received unknown input type", 
          suggestedRole: AgentRole.ORCHESTRATOR 
        },
        metadata: { inputType: input.type }
      };
    }
  }
  
  /**
   * Handle an initial request from the user
   */
  private async handleInitialRequest(input: any): Promise<AgentResponse> {
    const userRequest = input.request as string;
    
    // Analyze the request to determine what type of task it is
    const taskType = await this.analyzeRequest(userRequest);
    
    // Create a workflow plan based on the task type
    const workflowPlan = this.createWorkflowPlan(userRequest);
    
    // Determine which agent should handle this first
    let nextRole: AgentRole;
    
    switch (taskType) {
      case "simple_question":
        // For simple questions, the Orchestrator might just answer directly
        return {
          output: { response: await this.answerSimpleQuestion(userRequest) },
          nextAction: { type: "complete", finalOutput: "Simple question answered by Orchestrator." },
          metadata: { taskType }
        };
        
      case "implementation":
        // For implementation tasks, start with the Architect
        nextRole = AgentRole.ARCHITECT;
        break;
        
      case "bug_fix":
        // For bug fixes, might start with Coder directly
        nextRole = AgentRole.CODER;
        break;
        
      case "review":
        // For code reviews, start with the Reviewer
        nextRole = AgentRole.REVIEWER;
        break;
        
      default:
        // Default to Architect for anything unclear
        nextRole = AgentRole.ARCHITECT;
    }
    
    return {
      output: { 
        workflowPlan,
        taskType
      },
      nextAction: { type: "continue", nextRole },
      metadata: { 
        initialTask: true,
        taskType 
      }
    };
  }
  
  /**
   * Handle a workflow step from another agent
   */
  private async handleWorkflowStep(input: any): Promise<AgentResponse> {
    const { previousAgent, previousOutput, workflowPlan } = input;
    
    // Update the workflow plan
    const updatedPlan = { ...workflowPlan };
    updatedPlan.currentStepIndex++;
    
    // Determine the next agent based on the previous output
    let nextRole: AgentRole | null = null;
    
    if (previousOutput.nextAction?.type === "continue") {
      // Use suggested role if provided
      nextRole = previousOutput.nextAction.nextRole || 
        this.workflowEngine.determineNextAgent({
          taskId: "dummy",
          status: "executing",
          createdFiles: [],
          modifiedFiles: []
        }, previousAgent);
    } else if (previousOutput.nextAction?.type === "reject") {
      // Handle rejection by revising the workflow
      const revisedPlan = this.workflowEngine.reviseWorkflowPlan(
        updatedPlan,
        previousOutput.nextAction.reason,
        previousOutput.nextAction.suggestedRole
      );
      
      return {
        output: { revisedPlan },
        nextAction: { 
          type: "continue", 
          nextRole: previousOutput.nextAction.suggestedRole 
        },
        metadata: { 
          workflowRevised: true,
          rejectionReason: previousOutput.nextAction.reason
        }
      };
    } else if (previousOutput.nextAction?.type === "question") {
      // Handle question by routing to the appropriate agent
      return {
        output: { 
          question: previousOutput.nextAction.question,
          targetRole: previousOutput.nextAction.targetRole
        },
        nextAction: { 
          type: "continue", 
          nextRole: previousOutput.nextAction.targetRole 
        },
        metadata: { 
          handlingQuestion: true,
          fromAgent: previousAgent
        }
      };
    } else if (previousOutput.nextAction?.type === "complete") {
      // Task is complete, return the final output
      return {
        output: { finalOutput: previousOutput.nextAction.finalOutput },
        nextAction: { type: "complete", finalOutput: previousOutput.nextAction.finalOutput },
        metadata: { 
          taskCompleted: true,
          completedBy: previousAgent
        }
      };
    }
    
    // If we couldn't determine a next role, or we've reached the end of the workflow
    if (!nextRole) {
      // Task is complete
      return {
        output: { workflowComplete: true },
        nextAction: { type: "complete", finalOutput: "Workflow completed successfully." },
        metadata: { 
          workflowComplete: true
        }
      };
    }
    
    return {
      output: { updatedPlan },
      nextAction: { type: "continue", nextRole },
      metadata: { 
        workflowUpdated: true,
        previousAgent
      }
    };
  }
  
  /**
   * Analyze a user request to determine what type of task it is
   */
  private async analyzeRequest(request: string): Promise<string> {
    try {
      // Load the orchestrator prompt
      const promptPath = path.join(process.cwd(), "prompts", "orchestrator-analyze.md");
      let prompt = fs.existsSync(promptPath) 
        ? fs.readFileSync(promptPath, "utf-8")
        : "You are an orchestrator that analyzes user requests and categorizes them as: simple_question, implementation, bug_fix, or review.";
      
      const response = await this.openai.chat.completions.create({
        model: "o4-mini",
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: `Analyze this request and respond with one of the task types (simple_question, implementation, bug_fix, review): "${request}"` }
        ],
        max_tokens: 50,
        temperature: 0.2
      });
      
      // Safely access the content with multiple null checks
      const messageContent = response.choices[0]?.message?.content;
      const result = messageContent ? messageContent.trim().toLowerCase() : "implementation";
      
      // Validate the result is one of our expected types
      if (["simple_question", "implementation", "bug_fix", "review"].includes(result)) {
        return result;
      }
      
      // Default to implementation if we got an unexpected response
      return "implementation";
    } catch (error) {
      log(`Error analyzing request: ${error}`);
      // Default to implementation on error
      return "implementation";
    }
  }
  
  /**
   * Create a workflow plan based on a user request
   */
  private createWorkflowPlan(request: string): any {
    return this.workflowEngine.createInitialPlan(request);
  }
  
  /**
   * Answer a simple question directly without involving other agents
   */
  private async answerSimpleQuestion(question: string): Promise<string> {
    try {
      // For simple questions, we'll just use the model directly
      const response = await this.openai.chat.completions.create({
        model: "o4-mini",
        messages: [
          { role: "system", content: "You are a helpful assistant. Answer the user's question concisely." },
          { role: "user", content: question }
        ],
        max_tokens: 500
      });
      
      return response.choices[0]?.message?.content || "I couldn't generate an answer to your question.";
    } catch (error) {
      log(`Error answering simple question: ${error}`);
      return "I encountered an error while trying to answer your question.";
    }
  }
}