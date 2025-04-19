import { Agent, AgentContext, AgentResponse, ContextSlice, buildContextForAgent } from "../registry/agent-interface";
import { AgentRole } from "../registry/agent-roles";
import { log } from "../log";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

/**
 * The Architect agent is responsible for planning technical implementations
 * and making architectural decisions
 */
export class ArchitectAgent implements Agent {
  role = AgentRole.ARCHITECT;
  private openai: OpenAI;
  
  constructor(openai: OpenAI) {
    this.openai = openai;
  }
  
  /**
   * Process a request and generate a detailed implementation plan
   */
  async process(input: any, context: AgentContext): Promise<AgentResponse> {
    // Build the context slice specific to the Architect
    const contextSlice = buildContextForAgent(this.role, context);
    
    try {
      // Load the architect prompt
      const promptPath = path.join(process.cwd(), "prompts", "architect.md");
      let prompt = fs.existsSync(promptPath) 
        ? fs.readFileSync(promptPath, "utf-8")
        : "You are the Architect in a multi-agent software development system.";
      
      // Extract request from input
      const request = this.extractRequest(input, contextSlice);
      
      // Call the model to generate a plan
      const response = await this.openai.chat.completions.create({
        model: "o3", // Use a powerful model for architectural decisions
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: request }
        ],
        response_format: { type: "json_object" }, // Ensure response is valid JSON
        temperature: 0.7 // Allow some creativity in architecture planning
      });
      
      // Parse the response
      const rawResponse = response.choices[0]?.message?.content || "{}";
      const plan = this.parseResponse(rawResponse);
      
      // Return the plan with next action
      return {
        output: plan,
        nextAction: { 
          type: "continue", 
          nextRole: AgentRole.CODER 
        },
        metadata: { 
          requiredFiles: this.extractRequiredFiles(plan),
          estimatedComplexity: this.estimateComplexity(plan)
        }
      };
    } catch (error) {
      log(`Error in Architect agent: ${error}`);
      
      return {
        output: { error: `Failed to create architecture plan: ${error}` },
        nextAction: { 
          type: "reject", 
          reason: `Architect encountered an error: ${error}`, 
          suggestedRole: AgentRole.ORCHESTRATOR 
        },
        metadata: { error: true }
      };
    }
  }
  
  /**
   * Extract the relevant request from the input and context
   */
  private extractRequest(input: any, contextSlice: ContextSlice): string {
    // If we have a direct request, use that
    if (input.request) {
      return input.request;
    }
    
    // If we have a workflow step, use its input
    if (input.type === "workflow_step") {
      return input.previousOutput?.request || contextSlice.userInput;
    }
    
    // Default to the user input from context
    return contextSlice.userInput;
  }
  
  /**
   * Parse the response from the model into a structured plan
   */
  private parseResponse(rawResponse: string): any {
    try {
      // Parse the JSON response
      const plan = JSON.parse(rawResponse);
      
      // Validate that we have actions
      if (!plan.actions || !Array.isArray(plan.actions)) {
        return {
          error: "Invalid plan format - missing actions array",
          rawResponse
        };
      }
      
      return plan;
    } catch (error) {
      log(`Error parsing Architect response: ${error}`);
      return {
        error: `Failed to parse architecture plan: ${error}`,
        rawResponse
      };
    }
  }
  
  /**
   * Extract the files that will be required for implementation
   */
  private extractRequiredFiles(plan: any): string[] {
    // Extract unique file paths from the plan actions
    const files: Set<string> = new Set();
    
    if (plan.actions && Array.isArray(plan.actions)) {
      for (const action of plan.actions) {
        if (action.kind === "edit" && action.file) {
          files.add(action.file);
        }
      }
    }
    
    return Array.from(files);
  }
  
  /**
   * Estimate the complexity of the plan
   */
  private estimateComplexity(plan: any): string {
    // Count the number of actions
    const actionCount = plan.actions?.length || 0;
    
    // Determine complexity based on action count
    if (actionCount === 0) {
      return "unknown";
    } else if (actionCount <= 3) {
      return "low";
    } else if (actionCount <= 7) {
      return "medium";
    } else {
      return "high";
    }
  }
}