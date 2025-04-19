import { Agent, AgentContext, AgentResponse, ContextSlice, buildContextForAgent } from "../registry/agent-interface";
import { AgentRole } from "../registry/agent-roles";
import { log } from "../log";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

/**
 * The Coder agent is responsible for implementing specific coding tasks
 * based on the Architect's plan
 */
export class CoderAgent implements Agent {
  role = AgentRole.CODER;
  private openai: OpenAI;
  
  constructor(openai: OpenAI) {
    this.openai = openai;
  }
  
  /**
   * Process a request to implement code based on architectural guidance
   */
  async process(input: any, context: AgentContext): Promise<AgentResponse> {
    // Build the context slice specific to the Coder
    const contextSlice = buildContextForAgent(this.role, context);
    
    try {
      // Load the coder prompt
      const promptPath = path.join(process.cwd(), "prompts", "coder.md");
      let prompt = fs.existsSync(promptPath) 
        ? fs.readFileSync(promptPath, "utf-8")
        : "You are the Coder in a multi-agent software development system.";
      
      // Extract the task and file information
      const { task, file, fileContent } = this.extractTaskDetails(input, contextSlice);
      
      // Build the full request for the model
      const request = this.buildRequest(task, file, fileContent);
      
      // Call the model to generate code implementation
      const response = await this.openai.chat.completions.create({
        model: "o4-mini", // Use a cost-effective model for implementation
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: request }
        ],
        temperature: 0.2 // Lower temperature for more deterministic code
      });
      
      // Extract the code implementation
      const implementation = response.choices[0]?.message?.content || "";
      
      // Parse the implementation to extract a proper patch
      const patch = this.extractPatch(implementation, file);
      
      // Decide the next step based on the task and plan
      const nextRole = this.determineNextRole(input);
      
      return {
        output: {
          patch,
          file,
          message: `Implemented code changes for ${file}`
        },
        nextAction: { 
          type: "continue", 
          nextRole
        },
        metadata: { 
          modifiedFiles: [file]
        }
      };
    } catch (error) {
      log(`Error in Coder agent: ${error}`);
      
      return {
        output: { error: `Failed to implement code: ${error}` },
        nextAction: { 
          type: "reject", 
          reason: `Coder encountered an error: ${error}`, 
          suggestedRole: AgentRole.ARCHITECT 
        },
        metadata: { error: true }
      };
    }
  }
  
  /**
   * Extract the task details from the input and context
   */
  private extractTaskDetails(input: any, contextSlice: ContextSlice): { task: string, file: string, fileContent: string } {
    let task = "";
    let file = "";
    let fileContent = "";
    
    // If we have a plan action, extract details from it
    if (input.action && input.action.kind === "edit") {
      task = input.action.description || "";
      file = input.action.file || "";
      
      // Get file content from context if available
      if (contextSlice.relevantRepoContext.fileContents && file) {
        fileContent = contextSlice.relevantRepoContext.fileContents[file] || "";
      }
      
      // Add any hints from the action
      if (input.action.hints) {
        task += `\n\nHints: ${input.action.hints}`;
      }
    } else if (input.type === "workflow_step" && input.previousOutput) {
      // Extract from workflow step
      const previousOutput = input.previousOutput;
      
      if (previousOutput.plan && previousOutput.plan.actions) {
        // Find the first edit action
        const editAction = previousOutput.plan.actions.find((a: any) => a.kind === "edit");
        if (editAction) {
          task = editAction.description || "";
          file = editAction.file || "";
          
          // Add any hints
          if (editAction.hints) {
            task += `\n\nHints: ${editAction.hints}`;
          }
        }
      }
      
      // Get file content from context if available
      if (contextSlice.relevantRepoContext.fileContents && file) {
        fileContent = contextSlice.relevantRepoContext.fileContents[file] || "";
      }
    }
    
    // If we couldn't extract details, use generic values
    if (!task) {
      task = contextSlice.userInput || "Implement the requested code changes";
    }
    
    return { task, file, fileContent };
  }
  
  /**
   * Build a structured request for the model
   */
  private buildRequest(task: string, file: string, fileContent: string): string {
    let request = `Task: ${task}\n\n`;
    
    if (file) {
      request += `File to edit: ${file}\n\n`;
    }
    
    if (fileContent) {
      request += `Current file content:\n\`\`\`\n${fileContent}\n\`\`\`\n\n`;
    } else {
      request += "This is a new file to be created.\n\n";
    }
    
    request += "Please implement the requested changes and provide your response in the format of an RFC-8259 compliant apply_patch diff.";
    
    return request;
  }
  
  /**
   * Extract a proper patch from the model's response
   */
  private extractPatch(implementation: string, file: string): string {
    // Check if the implementation already contains a proper patch format
    if (implementation.includes("*** Begin Patch") && implementation.includes("*** End Patch")) {
      return implementation;
    }
    
    // If not, try to extract code blocks
    const codeBlockRegex = /```(?:[\w-]+)?\n([\s\S]*?)```/g;
    const codeBlocks: string[] = [];
    let match;
    
    while ((match = codeBlockRegex.exec(implementation)) !== null) {
      codeBlocks.push(match[1]);
    }
    
    // If we found code blocks, use the largest one
    let codeContent = "";
    if (codeBlocks.length > 0) {
      codeContent = codeBlocks.reduce((longest, current) => 
        current.length > longest.length ? current : longest, "");
    } else {
      // If no code blocks, use the whole response
      codeContent = implementation;
    }
    
    // Format as a patch
    return `*** Begin Patch
*** Update File: ${file}
@@ -1,1 +1,${codeContent.split('\n').length} @@
${codeContent}
*** End Patch`;
  }
  
  /**
   * Determine the next role based on the task and plan
   */
  private determineNextRole(input: any): AgentRole {
    // If we have specific next role in the input, use that
    if (input.nextRole) {
      return input.nextRole;
    }
    
    // Default flow is to go to tester after implementation
    return AgentRole.TESTER;
  }
}