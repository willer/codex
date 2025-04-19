import { Agent, AgentContext, AgentResponse, ContextSlice, buildContextForAgent } from "../registry/agent-interface";
import { AgentRole } from "../registry/agent-roles";
import { log } from "../log";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

/**
 * The Tester agent is responsible for verifying code changes and
 * ensuring they meet the requirements
 */
export class TesterAgent implements Agent {
  role = AgentRole.TESTER;
  private openai: OpenAI;
  
  constructor(openai: OpenAI) {
    this.openai = openai;
  }
  
  /**
   * Process a request to test code changes
   */
  async process(input: any, context: AgentContext): Promise<AgentResponse> {
    // Build the context slice specific to the Tester
    const contextSlice = buildContextForAgent(this.role, context);
    
    try {
      // Load the tester prompt
      const promptPath = path.join(process.cwd(), "prompts", "tester.md");
      let prompt = fs.existsSync(promptPath) 
        ? fs.readFileSync(promptPath, "utf-8")
        : "You are the Tester in a multi-agent software development system.";
      
      // Extract the modified files and implementation details
      const { modifiedFiles, implementation, testCommands } = this.extractTestDetails(input, contextSlice);
      
      // Run tests if test commands are available
      const testResults = await this.runTests(testCommands);
      
      // If tests failed, we need to analyze the issues
      if (!testResults.success) {
        // Call the model to analyze test failures
        const analysisResponse = await this.openai.chat.completions.create({
          model: "o4-mini",
          messages: [
            { role: "system", content: prompt },
            { 
              role: "user", 
              content: `The following test(s) failed:\n\n${testResults.output}\n\nPlease analyze the test failures and suggest fixes.` 
            }
          ],
          temperature: 0.3
        });
        
        const analysis = analysisResponse.choices[0]?.message?.content || "";
        
        // Return test failure with analysis
        return {
          output: {
            success: false,
            testOutput: testResults.output,
            analysis,
            recommendations: this.extractRecommendations(analysis)
          },
          nextAction: { 
            type: "reject", 
            reason: "Tests failed", 
            suggestedRole: AgentRole.CODER 
          },
          metadata: { 
            modifiedFiles,
            testsFailed: true,
            errorMessages: this.extractErrorMessages(testResults.output)
          }
        };
      }
      
      // Tests passed, generate a test report
      const reportResponse = await this.openai.chat.completions.create({
        model: "o4-mini",
        messages: [
          { role: "system", content: prompt },
          { 
            role: "user", 
            content: `The following tests passed:\n\n${testResults.output}\n\nPlease generate a concise test report.` 
          }
        ],
        temperature: 0.3
      });
      
      const report = reportResponse.choices[0]?.message?.content || "";
      
      // Tests passed, continue to reviewer
      return {
        output: {
          success: true,
          testOutput: testResults.output,
          report
        },
        nextAction: { 
          type: "continue", 
          nextRole: AgentRole.REVIEWER 
        },
        metadata: { 
          modifiedFiles,
          testsSucceeded: true
        }
      };
    } catch (error) {
      log(`Error in Tester agent: ${error}`);
      
      return {
        output: { error: `Failed to run tests: ${error}` },
        nextAction: { 
          type: "reject", 
          reason: `Tester encountered an error: ${error}`, 
          suggestedRole: AgentRole.ORCHESTRATOR 
        },
        metadata: { error: true }
      };
    }
  }
  
  /**
   * Extract test details from the input and context
   */
  private extractTestDetails(input: any, contextSlice: ContextSlice): { 
    modifiedFiles: string[], 
    implementation: string, 
    testCommands: string[] 
  } {
    let modifiedFiles: string[] = [];
    let implementation = "";
    let testCommands: string[] = [];
    
    // Extract modified files from context
    if (contextSlice.taskState.modifiedFiles) {
      modifiedFiles = contextSlice.taskState.modifiedFiles;
    }
    
    // Extract implementation details from previous output
    if (input.type === "workflow_step" && input.previousOutput) {
      const previousOutput = input.previousOutput;
      
      if (previousOutput.patch) {
        implementation = previousOutput.patch;
      }
      
      if (previousOutput.file && !modifiedFiles.includes(previousOutput.file)) {
        modifiedFiles.push(previousOutput.file);
      }
    }
    
    // Try to determine test commands based on the project
    if (fs.existsSync("package.json")) {
      try {
        const packageJson = JSON.parse(fs.readFileSync("package.json", "utf-8"));
        if (packageJson.scripts && packageJson.scripts.test) {
          testCommands.push("npm test");
        }
      } catch (error) {
        log(`Error parsing package.json: ${error}`);
      }
    }
    
    // Check for pytest
    if (fs.existsSync("pytest.ini") || fs.existsSync("pyproject.toml")) {
      testCommands.push("pytest");
    }
    
    // Look for specific test files related to modified files
    for (const file of modifiedFiles) {
      const baseName = path.basename(file, path.extname(file));
      const dir = path.dirname(file);
      const potentialTestFiles = [
        path.join(dir, `test_${baseName}${path.extname(file)}`),
        path.join(dir, `${baseName}_test${path.extname(file)}`),
        path.join("tests", `test_${baseName}${path.extname(file)}`),
        path.join("tests", `${baseName}_test${path.extname(file)}`)
      ];
      
      for (const testFile of potentialTestFiles) {
        if (fs.existsSync(testFile)) {
          // Add a specific test command for this file
          if (file.endsWith(".py")) {
            testCommands.push(`pytest ${testFile}`);
          } else if (file.endsWith(".js") || file.endsWith(".ts")) {
            testCommands.push(`npm test -- ${testFile}`);
          }
        }
      }
    }
    
    // If no test commands were determined, add a generic one
    if (testCommands.length === 0) {
      testCommands.push("npm test");
    }
    
    return { modifiedFiles, implementation, testCommands };
  }
  
  /**
   * Run tests using the provided test commands
   */
  private async runTests(testCommands: string[]): Promise<{ success: boolean, output: string }> {
    let success = true;
    let output = "";
    
    for (const command of testCommands) {
      try {
        log(`Running test command: ${command}`);
        const result = execSync(command, { encoding: "utf-8", stdio: "pipe" });
        output += `Command: ${command}\nOutput:\n${result}\n\n`;
      } catch (error: any) {
        success = false;
        
        // Capture the error output
        output += `Command: ${command}\nError:\n${error.message}\n`;
        if (error.stdout) {
          output += `Stdout:\n${error.stdout}\n`;
        }
        if (error.stderr) {
          output += `Stderr:\n${error.stderr}\n`;
        }
        output += "\n";
      }
    }
    
    return { success, output };
  }
  
  /**
   * Extract error messages from test output
   */
  private extractErrorMessages(output: string): string[] {
    const errorMessages: string[] = [];
    
    // Look for common error patterns in test output
    const errorPatterns = [
      /Error: (.+?)(?:\n|$)/g,
      /AssertionError: (.+?)(?:\n|$)/g,
      /FAIL: (.+?)(?:\n|$)/g,
      /FAILED (.+?)(?:\n|$)/g,
      /Exception: (.+?)(?:\n|$)/g
    ];
    
    for (const pattern of errorPatterns) {
      let match;
      while ((match = pattern.exec(output)) !== null) {
        errorMessages.push(match[1].trim());
      }
    }
    
    return errorMessages;
  }
  
  /**
   * Extract recommendations from the analysis
   */
  private extractRecommendations(analysis: string): string[] {
    const recommendations: string[] = [];
    
    // Look for recommendation patterns
    const recommendationsSectionRegex = /Recommendations?:(.*?)(?:\n\n|$)/si;
    const recommendationMatch = recommendationsSectionRegex.exec(analysis);
    
    if (recommendationMatch && recommendationMatch[1]) {
      // Split by numbered or bulleted list items
      const items = recommendationMatch[1].split(/(?:\r?\n|\r)(?:[0-9]+\.|\*)\s+/);
      
      for (const item of items) {
        const trimmed = item.trim();
        if (trimmed) {
          recommendations.push(trimmed);
        }
      }
    }
    
    // If no recommendations section was found, look for suggestive language
    if (recommendations.length === 0) {
      const suggestivePatterns = [
        /should (.*?)(?:\.|$)/gi,
        /need to (.*?)(?:\.|$)/gi,
        /try (.*?)(?:\.|$)/gi,
        /consider (.*?)(?:\.|$)/gi
      ];
      
      for (const pattern of suggestivePatterns) {
        let match;
        while ((match = pattern.exec(analysis)) !== null) {
          recommendations.push(match[1].trim());
        }
      }
    }
    
    return recommendations;
  }
}