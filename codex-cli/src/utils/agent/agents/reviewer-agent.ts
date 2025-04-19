import { Agent, AgentContext, AgentResponse, ContextSlice, buildContextForAgent } from "../registry/agent-interface";
import { AgentRole } from "../registry/agent-roles";
import { log } from "../log";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

/**
 * The Reviewer agent performs code reviews and ensures the implementation
 * aligns with architecture and best practices
 */
export class ReviewerAgent implements Agent {
  role = AgentRole.REVIEWER;
  private openai: OpenAI;
  
  constructor(openai: OpenAI) {
    this.openai = openai;
  }
  
  /**
   * Process a request to review code changes
   */
  async process(input: any, context: AgentContext): Promise<AgentResponse> {
    // Build the context slice specific to the Reviewer
    const contextSlice = buildContextForAgent(this.role, context);
    
    try {
      // Load the reviewer prompt
      const promptPath = path.join(process.cwd(), "prompts", "reviewer.md");
      let prompt = fs.existsSync(promptPath) 
        ? fs.readFileSync(promptPath, "utf-8")
        : "You are the Reviewer in a multi-agent software development system.";
      
      // Extract the files to review and test results
      const { modifiedFiles, initialRequest, testResults } = this.extractReviewDetails(input, contextSlice);
      
      // Build file content for review
      const filesToReview = this.prepareFilesForReview(modifiedFiles, contextSlice);
      
      // Build the review request
      const reviewRequest = this.buildReviewRequest(initialRequest, filesToReview, testResults);
      
      // Call the model to perform the code review
      const response = await this.openai.chat.completions.create({
        model: "o3", // Use a powerful model for thorough code review
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: reviewRequest }
        ],
        temperature: 0.5 // Balanced temperature for review judgments
      });
      
      const reviewContent = response.choices[0]?.message?.content || "";
      
      // Parse the review to determine if changes are approved
      const { approved, issues, recommendations } = this.parseReview(reviewContent);
      
      if (approved) {
        // Review passed, return completion
        return {
          output: {
            approved: true,
            review: reviewContent,
            summary: this.generateReviewSummary(reviewContent, true)
          },
          nextAction: { 
            type: "complete", 
            finalOutput: `✅ Code review passed. ${recommendations.length > 0 ? "Recommendations: " + recommendations.join(", ") : ""}` 
          },
          metadata: { 
            modifiedFiles,
            reviewPassed: true,
            recommendations
          }
        };
      } else {
        // Review found issues, reject and suggest fixes
        return {
          output: {
            approved: false,
            review: reviewContent,
            issues,
            recommendations,
            summary: this.generateReviewSummary(reviewContent, false)
          },
          nextAction: { 
            type: "reject", 
            reason: "Code review found issues", 
            suggestedRole: AgentRole.CODER 
          },
          metadata: { 
            modifiedFiles,
            reviewFailed: true,
            issues,
            recommendations
          }
        };
      }
    } catch (error) {
      log(`Error in Reviewer agent: ${error}`);
      
      return {
        output: { error: `Failed to perform code review: ${error}` },
        nextAction: { 
          type: "reject", 
          reason: `Reviewer encountered an error: ${error}`, 
          suggestedRole: AgentRole.ORCHESTRATOR 
        },
        metadata: { error: true }
      };
    }
  }
  
  /**
   * Extract review details from the input and context
   */
  private extractReviewDetails(input: any, contextSlice: ContextSlice): { 
    modifiedFiles: string[], 
    initialRequest: string, 
    testResults: string 
  } {
    let modifiedFiles: string[] = [];
    let initialRequest = "";
    let testResults = "";
    
    // Extract modified files from context
    if (contextSlice.taskState.modifiedFiles) {
      modifiedFiles = contextSlice.taskState.modifiedFiles;
    }
    
    // Extract the initial request from context
    initialRequest = contextSlice.userInput || "";
    
    // Extract test results from previous output
    if (input.type === "workflow_step" && input.previousOutput) {
      const previousOutput = input.previousOutput;
      
      if (previousOutput.testOutput) {
        testResults = previousOutput.testOutput;
      }
    }
    
    return { modifiedFiles, initialRequest, testResults };
  }
  
  /**
   * Prepare files for review by getting their content
   */
  private prepareFilesForReview(files: string[], contextSlice: ContextSlice): Array<{ file: string, content: string }> {
    const filesToReview: Array<{ file: string, content: string }> = [];
    
    // Get content for each file
    for (const file of files) {
      let content = "";
      
      // Try to get file content from context
      if (contextSlice.relevantRepoContext.fileContents && contextSlice.relevantRepoContext.fileContents[file]) {
        content = contextSlice.relevantRepoContext.fileContents[file];
      } else {
        // Try to read the file directly
        try {
          if (fs.existsSync(file)) {
            content = fs.readFileSync(file, "utf-8");
          }
        } catch (error) {
          log(`Error reading file ${file}: ${error}`);
        }
      }
      
      if (content) {
        filesToReview.push({ file, content });
      }
    }
    
    return filesToReview;
  }
  
  /**
   * Build a structured review request for the model
   */
  private buildReviewRequest(initialRequest: string, filesToReview: Array<{ file: string, content: string }>, testResults: string): string {
    let request = `Initial Request: ${initialRequest}\n\n`;
    
    request += "Files to Review:\n\n";
    
    for (const { file, content } of filesToReview) {
      request += `File: ${file}\n\`\`\`\n${content}\n\`\`\`\n\n`;
    }
    
    if (testResults) {
      request += `Test Results:\n\n${testResults}\n\n`;
    }
    
    request += "Please perform a thorough code review of the implementation based on the initial request. " +
      "Evaluate code quality, correctness, maintainability, and alignment with best practices.";
    
    return request;
  }
  
  /**
   * Parse the review to extract approval, issues, and recommendations
   */
  private parseReview(review: string): { approved: boolean, issues: string[], recommendations: string[] } {
    // Default to not approved
    let approved = false;
    const issues: string[] = [];
    const recommendations: string[] = [];
    
    // Check for explicit approval/rejection patterns
    const approvalPatterns = [
      /\bapproved?\b/i,
      /\bpasses\b/i,
      /\bno issues\b/i,
      /\blgtm\b/i,
      /\bships\b/i,
      /\breview passed\b/i
    ];
    
    for (const pattern of approvalPatterns) {
      if (pattern.test(review)) {
        approved = true;
        break;
      }
    }
    
    // Look for rejection patterns that override approval
    const rejectionPatterns = [
      /\breject\b/i,
      /\bfail\b/i,
      /\bcritical issues\b/i,
      /\bmust be fixed\b/i,
      /\bdo not merge\b/i,
      /\bblocking issues\b/i
    ];
    
    for (const pattern of rejectionPatterns) {
      if (pattern.test(review)) {
        approved = false;
        break;
      }
    }
    
    // Extract issues
    const issuesSectionRegex = /Issues?:(.*?)(?:Recommendations?:|$)/si;
    const issuesMatch = issuesSectionRegex.exec(review);
    
    if (issuesMatch && issuesMatch[1]) {
      // Split by numbered or bulleted list items
      const items = issuesMatch[1].split(/(?:\r?\n|\r)(?:[0-9]+\.|\*)\s+/);
      
      for (const item of items) {
        const trimmed = item.trim();
        if (trimmed) {
          issues.push(trimmed);
        }
      }
    }
    
    // Extract recommendations
    const recommendationsSectionRegex = /Recommendations?:(.*?)(?:\n\n|$)/si;
    const recommendationsMatch = recommendationsSectionRegex.exec(review);
    
    if (recommendationsMatch && recommendationsMatch[1]) {
      // Split by numbered or bulleted list items
      const items = recommendationsMatch[1].split(/(?:\r?\n|\r)(?:[0-9]+\.|\*)\s+/);
      
      for (const item of items) {
        const trimmed = item.trim();
        if (trimmed) {
          recommendations.push(trimmed);
        }
      }
    }
    
    // If there are issues, but the model still approved, make a judgment call
    if (approved && issues.length > 0) {
      // If more than 2 issues, or any issue containing specific keywords, override to not approved
      const criticalKeywords = ["critical", "error", "crash", "security", "vulnerability", "data loss"];
      const hasCriticalIssue = issues.some(issue => 
        criticalKeywords.some(keyword => issue.toLowerCase().includes(keyword))
      );
      
      if (issues.length > 2 || hasCriticalIssue) {
        approved = false;
      }
    }
    
    return { approved, issues, recommendations };
  }
  
  /**
   * Generate a concise summary of the review
   */
  private generateReviewSummary(review: string, approved: boolean): string {
    if (approved) {
      return "✅ Code review passed. The implementation meets quality standards and requirements.";
    } else {
      return "❌ Code review found issues that need to be addressed before approval.";
    }
  }
}