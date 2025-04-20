// Agent implementations for the Multi-Agent architecture
import { log, isLoggingEnabled } from "../log.js";
import { OPENAI_BASE_URL, OPENAI_TIMEOUT_MS } from "../../config.js";
import { Agent, AgentContext, AgentResponse, NextAction } from "./agent-interface";
import { AgentConfig, AgentRole } from "./agent-registry";
import { randomUUID } from "node:crypto";
import OpenAI, { APIConnectionTimeoutError } from "openai";
import fs from "fs";
import path from "path";
import { CLI_VERSION, ORIGIN } from "../../session.js";

/**
 * Base class for all agent implementations
 */
export abstract class BaseAgent implements Agent {
  public readonly role: AgentRole;
  protected config: AgentConfig;
  protected oai: OpenAI;
  protected sessionId: string;
  protected prompt: string;

  constructor(config: AgentConfig, apiKey: string, sessionId?: string) {
    this.role = config.role;
    this.config = config;
    this.sessionId = sessionId || randomUUID().replaceAll("-", "");
    
    // Load prompt file
    this.prompt = this.loadPrompt(config.promptPath);

    // Initialize OpenAI client
    const timeoutMs = OPENAI_TIMEOUT_MS;
    this.oai = new OpenAI({
      ...(apiKey ? { apiKey } : {}),
      baseURL: OPENAI_BASE_URL,
      defaultHeaders: {
        originator: ORIGIN,
        version: CLI_VERSION,
        session_id: this.sessionId,
      },
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
    });
  }

  /**
   * Process input and return a response
   */
  abstract process(input: any, context: AgentContext): Promise<AgentResponse>;

  /**
   * Load prompt from file
   */
  protected loadPrompt(promptPath: string): string {
    try {
      // Try to load from the configured path
      const promptFile = path.isAbsolute(promptPath) 
        ? promptPath 
        : path.join(process.cwd(), promptPath);
      
      if (fs.existsSync(promptFile)) {
        return fs.readFileSync(promptFile, 'utf-8');
      }
      
      // If not found, check in a few standard locations
      const alternativePaths = [
        path.join(process.cwd(), 'prompts', `${this.role}.md`),
        path.join(process.cwd(), 'codex-cli', 'prompts', `${this.role}.md`),
        path.join(process.cwd(), 'src', 'prompts', `${this.role}.md`)
      ];
      
      for (const altPath of alternativePaths) {
        if (fs.existsSync(altPath)) {
          return fs.readFileSync(altPath, 'utf-8');
        }
      }
      
      // If no prompt file found, log warning and return empty string
      if (isLoggingEnabled()) {
        log(`[BaseAgent] Warning: Could not find prompt file at ${promptPath} or alternative locations`);
      }
      
      return "";
    } catch (error) {
      if (isLoggingEnabled()) {
        log(`[BaseAgent] Error loading prompt: ${error instanceof Error ? error.message : String(error)}`);
      }
      return "";
    }
  }

  /**
   * Call OpenAI API with retry logic
   */
  protected async callOpenAI(messages: Array<any>, tools?: Array<any>): Promise<any> {
    const MAX_RETRIES = 5;
    const RATE_LIMIT_RETRY_WAIT_MS = 2500;
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Check if the model supports custom temperature (not all do)
        // This is a workaround for models that don't support custom temperature
        const useDefaultTemperature = 
          this.config.model === "o4-mini" || 
          this.config.model === "o3" || 
          this.config.model.startsWith("o");
        
        const response = await this.oai.chat.completions.create({
          model: this.config.model,
          messages,
          ...(useDefaultTemperature ? {} : { temperature: this.config.temperature }),
          tools,
          stream: false
        });
        
        return response;
      } catch (error) {
        const isTimeout = error instanceof APIConnectionTimeoutError;
        const isServerError = this.isServerError(error);
        const isConnectionError = this.isConnectionError(error);
        
        // Retry for timeout, server error, or connection error
        if ((isTimeout || isServerError || isConnectionError) && attempt < MAX_RETRIES) {
          if (isLoggingEnabled()) {
            log(`[${this.role}] API request failed (attempt ${attempt}/${MAX_RETRIES}), retrying...`);
          }
          continue;
        }
        
        // Handle rate limit errors with exponential backoff
        if (this.isRateLimitError(error) && attempt < MAX_RETRIES) {
          let delayMs = RATE_LIMIT_RETRY_WAIT_MS * 2 ** (attempt - 1);
          
          const message = this.getErrorMessage(error);
          const rateLimitMatch = /(?:retry|try) again in ([\d.]+)s/i.exec(message);
          if (rateLimitMatch && rateLimitMatch[1]) {
            const suggested = parseFloat(rateLimitMatch[1]) * 1000;
            if (!Number.isNaN(suggested)) {
              delayMs = suggested;
            }
          }
          
          if (isLoggingEnabled()) {
            log(`[${this.role}] Rate limit exceeded (attempt ${attempt}/${MAX_RETRIES}), retrying in ${Math.round(delayMs)} ms...`);
          }
          
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        
        // If we've exhausted all retries or it's a non-retryable error, throw
        throw error;
      }
    }
    
    throw new Error(`Failed to call OpenAI API after ${MAX_RETRIES} attempts`);
  }

  /**
   * Check if an error is a server error
   */
  private isServerError(error: any): boolean {
    const status = error?.status ?? error?.httpStatus ?? error?.statusCode;
    return typeof status === "number" && status >= 500;
  }

  /**
   * Check if an error is a connection error
   */
  private isConnectionError(error: any): boolean {
    const ApiConnErrCtor = (OpenAI as any).APIConnectionError as
      | (new (...args: any) => Error)
      | undefined;
    return ApiConnErrCtor ? error instanceof ApiConnErrCtor : false;
  }

  /**
   * Check if an error is a rate limit error
   */
  private isRateLimitError(error: any): boolean {
    const status = error?.status ?? error?.httpStatus ?? error?.statusCode;
    return (
      status === 429 ||
      error?.code === "rate_limit_exceeded" ||
      error?.type === "rate_limit_exceeded" ||
      /rate limit/i.test(this.getErrorMessage(error))
    );
  }

  /**
   * Get error message from error object
   */
  private getErrorMessage(error: any): string {
    return error?.message || "Unknown error";
  }
}

/**
 * Implementation of the Orchestrator agent
 */
export class OrchestratorAgent extends BaseAgent {
  constructor(config: AgentConfig, apiKey: string, sessionId?: string) {
    super(config, apiKey, sessionId);
  }

  /**
   * Process input and return a response
   */
  async process(input: any, context: AgentContext): Promise<AgentResponse> {
    if (isLoggingEnabled()) {
      log(`[Orchestrator] Processing input: ${JSON.stringify(input)}`);
    }

    // Prepare messages for the orchestrator
    const messages = [
      { role: "system", content: this.prompt },
      { role: "user", content: this.formatUserInput(input, context) }
    ];

    // Define tools for the orchestrator
    const tools = [
      {
        type: "function",
        function: {
          name: "create_workflow_plan",
          description: "Create a workflow plan with steps assigned to different agents",
          parameters: {
            type: "object",
            properties: {
              steps: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    role: {
                      type: "string",
                      enum: Object.values(AgentRole)
                    },
                    action: {
                      type: "string",
                      description: "The action for the agent to perform"
                    },
                    description: {
                      type: "string",
                      description: "Description of why this step is needed"
                    }
                  },
                  required: ["role", "action"]
                }
              },
              reasoning: {
                type: "string",
                description: "Explanation of why this plan was chosen"
              }
            },
            required: ["steps"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "create_recovery_plan",
          description: "Create a recovery plan when a step fails",
          parameters: {
            type: "object",
            properties: {
              recoverySteps: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    role: {
                      type: "string",
                      enum: Object.values(AgentRole)
                    },
                    action: {
                      type: "string",
                      description: "The recovery action for the agent to perform"
                    },
                    reason: {
                      type: "string",
                      description: "Reason for this recovery step"
                    }
                  },
                  required: ["role", "action"]
                }
              },
              analysis: {
                type: "string",
                description: "Analysis of what went wrong"
              }
            },
            required: ["recoverySteps"]
          }
        }
      }
    ];

    try {
      const response = await this.callOpenAI(messages, tools);
      
      // Process the response
      const toolCalls = response.choices[0]?.message?.tool_calls || [];
      if (toolCalls.length > 0) {
        const toolCall = toolCalls[0];
        const functionName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        
        if (functionName === "create_workflow_plan") {
          return {
            output: {
              plan: {
                steps: args.steps,
                reasoning: args.reasoning
              }
            },
            nextAction: { type: "continue" },
            metadata: { model: this.config.model }
          };
        } else if (functionName === "create_recovery_plan") {
          return {
            output: {
              recoveryPlan: args.recoverySteps,
              analysis: args.analysis
            },
            nextAction: { type: "continue" },
            metadata: { model: this.config.model }
          };
        }
      }
      
      // Fallback if no tool call was made
      return {
        output: {
          message: response.choices[0]?.message?.content || "No response generated"
        },
        nextAction: { type: "complete", finalOutput: "Task completed with default response" },
        metadata: { model: this.config.model }
      };
    } catch (error) {
      if (isLoggingEnabled()) {
        log(`[Orchestrator] Error: ${error instanceof Error ? error.message : String(error)}`);
      }
      
      throw error;
    }
  }

  /**
   * Format user input for the orchestrator
   */
  private formatUserInput(input: any, context: AgentContext): string {
    let formattedInput = "";
    
    if (input.type === "plan_request") {
      formattedInput = `User Request: ${context.userInput}\n\nPlease create a workflow plan to address this request. Determine which agents need to be involved and in what order.`;
    } else if (input.type === "recovery") {
      formattedInput = `Error occurred: ${input.error}\nFailed step: ${JSON.stringify(input.failedStep)}\n\nPlease create a recovery plan to address this error.`;
    } else {
      formattedInput = `Request: ${JSON.stringify(input)}\n\nContext: ${context.userInput}\n\nPlease analyze this input and create an appropriate workflow.`;
    }
    
    return formattedInput;
  }
}

/**
 * Implementation of the Architect agent
 */
export class ArchitectAgent extends BaseAgent {
  constructor(config: AgentConfig, apiKey: string, sessionId?: string) {
    super(config, apiKey, sessionId);
  }

  /**
   * Process input and return a response
   */
  async process(input: any, context: AgentContext): Promise<AgentResponse> {
    if (isLoggingEnabled()) {
      log(`[Architect] Processing input: ${JSON.stringify(input)}`);
    }

    // Prepare messages for the architect
    const messages = [
      { role: "system", content: this.prompt },
      { role: "user", content: this.formatUserInput(input, context) }
    ];

    // Define tools for the architect
    const tools = [
      {
        type: "function",
        function: {
          name: "create_architecture_plan",
          description: "Create a detailed architecture plan",
          parameters: {
            type: "object",
            properties: {
              actions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    kind: {
                      type: "string",
                      enum: ["edit", "command", "message"]
                    },
                    file: {
                      type: "string",
                      description: "File path for edits"
                    },
                    description: {
                      type: "string",
                      description: "Description of the change"
                    },
                    hints: {
                      type: "string",
                      description: "Implementation hints for the coder"
                    },
                    cmd: {
                      type: "string",
                      description: "Command to execute"
                    },
                    expect: {
                      type: "string",
                      enum: ["pass", "fail", "unknown"],
                      description: "Expected outcome of the command"
                    }
                  },
                  required: ["kind"]
                }
              },
              architecturalDecisions: {
                type: "string",
                description: "Explanation of key architectural decisions"
              }
            },
            required: ["actions"]
          }
        }
      }
    ];

    try {
      const response = await this.callOpenAI(messages, tools);
      
      // Process the response
      const toolCalls = response.choices[0]?.message?.tool_calls || [];
      if (toolCalls.length > 0) {
        const toolCall = toolCalls[0];
        const functionName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        
        if (functionName === "create_architecture_plan") {
          return {
            output: {
              plan: args.actions,
              decisions: args.architecturalDecisions
            },
            nextAction: { type: "continue", nextRole: AgentRole.CODER },
            metadata: { model: this.config.model }
          };
        }
      }
      
      // Fallback if no tool call was made
      return {
        output: {
          message: response.choices[0]?.message?.content || "No response generated"
        },
        nextAction: { type: "continue", nextRole: AgentRole.CODER },
        metadata: { model: this.config.model }
      };
    } catch (error) {
      if (isLoggingEnabled()) {
        log(`[Architect] Error: ${error instanceof Error ? error.message : String(error)}`);
      }
      
      throw error;
    }
  }

  /**
   * Format user input for the architect
   */
  private formatUserInput(input: any, context: AgentContext): string {
    // Include repository context and user request
    let formattedInput = `User Request: ${context.userInput}\n\n`;
    
    // Add file structure information
    formattedInput += "Repository Structure:\n";
    context.repoContext.fileStructure.slice(0, 20).forEach(file => {
      formattedInput += `- ${file}\n`;
    });
    
    if (context.repoContext.fileStructure.length > 20) {
      formattedInput += `... and ${context.repoContext.fileStructure.length - 20} more files\n`;
    }
    
    // Add input specific information
    if (input.type === "task") {
      formattedInput += `\nTask: ${input.description}\n\nPlease create an architectural plan to implement this task. Include file edits, commands, and any necessary architectural decisions.`;
    } else if (input.type === "question") {
      formattedInput += `\nQuestion from ${input.askedBy}: ${input.question}\n\nPlease provide an architectural perspective on this question.`;
    } else {
      formattedInput += `\nInput: ${JSON.stringify(input)}\n\nPlease analyze this input from an architectural perspective and create an appropriate plan.`;
    }
    
    return formattedInput;
  }
}

/**
 * Implementation of the Coder agent
 */
export class CoderAgent extends BaseAgent {
  constructor(config: AgentConfig, apiKey: string, sessionId?: string) {
    super(config, apiKey, sessionId);
  }

  /**
   * Process input and return a response
   */
  async process(input: any, context: AgentContext): Promise<AgentResponse> {
    if (isLoggingEnabled()) {
      log(`[Coder] Processing input: ${JSON.stringify(input)}`);
    }

    // Prepare messages for the coder
    const messages = [
      { role: "system", content: this.prompt },
      { role: "user", content: this.formatUserInput(input, context) }
    ];

    // Define tools for the coder
    const tools = [
      {
        type: "function",
        function: {
          name: "apply_patch",
          description: "Create a patch to apply to a file",
          parameters: {
            type: "object",
            properties: {
              file: {
                type: "string",
                description: "File path to modify"
              },
              patch: {
                type: "string",
                description: "Unified diff patch content"
              },
              explanation: {
                type: "string",
                description: "Explanation of what this patch does"
              }
            },
            required: ["file", "patch"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "request_clarification",
          description: "Request clarification from the architect",
          parameters: {
            type: "object",
            properties: {
              question: {
                type: "string",
                description: "Question about implementation details"
              },
              context: {
                type: "string",
                description: "Context about what you're trying to implement"
              }
            },
            required: ["question"]
          }
        }
      }
    ];

    try {
      const response = await this.callOpenAI(messages, tools);
      
      // Process the response
      const toolCalls = response.choices[0]?.message?.tool_calls || [];
      if (toolCalls.length > 0) {
        const toolCall = toolCalls[0];
        const functionName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        
        if (functionName === "apply_patch") {
          return {
            output: {
              file: args.file,
              patch: args.patch,
              explanation: args.explanation
            },
            nextAction: { type: "continue", nextRole: AgentRole.TESTER },
            metadata: { model: this.config.model }
          };
        } else if (functionName === "request_clarification") {
          return {
            output: {
              question: args.question,
              context: args.context
            },
            nextAction: {
              type: "question",
              question: args.question,
              targetRole: AgentRole.ARCHITECT
            },
            metadata: { model: this.config.model }
          };
        }
      }
      
      // Fallback if no tool call was made
      return {
        output: {
          message: response.choices[0]?.message?.content || "No response generated"
        },
        nextAction: { type: "continue", nextRole: AgentRole.TESTER },
        metadata: { model: this.config.model }
      };
    } catch (error) {
      if (isLoggingEnabled()) {
        log(`[Coder] Error: ${error instanceof Error ? error.message : String(error)}`);
      }
      
      throw error;
    }
  }

  /**
   * Format user input for the coder
   */
  private formatUserInput(input: any, context: AgentContext): string {
    let formattedInput = "";
    
    if (input.type === "task") {
      formattedInput = `Task: ${input.description}\n\n`;
      
      // Add file content for the relevant files
      if (context.roleSpecificContext.relevantFiles?.length > 0) {
        context.roleSpecificContext.relevantFiles.forEach((file: any) => {
          formattedInput += `File: ${file.path}\n\`\`\`\n${file.content}\n\`\`\`\n\n`;
        });
      }
      
      formattedInput += "Implement the necessary changes for this task. Create patches for each file that needs modification.";
    } else if (input.type === "continue_after_question") {
      // Include the answer from the architect
      const previousAnswers = context.conversationHistory
        .filter(msg => msg.role === AgentRole.ARCHITECT)
        .slice(-1);
      
      formattedInput = `Original task: ${input.originalInput.description}\n\n`;
      
      if (previousAnswers.length > 0) {
        formattedInput += `Architect's answer: ${previousAnswers[0].content}\n\n`;
      }
      
      formattedInput += "Now that you have this information, please implement the necessary changes.";
    } else {
      formattedInput = `Input: ${JSON.stringify(input)}\n\nContext: ${context.userInput}\n\nPlease implement the necessary code changes.`;
    }
    
    return formattedInput;
  }
}

/**
 * Implementation of the Tester agent
 */
export class TesterAgent extends BaseAgent {
  constructor(config: AgentConfig, apiKey: string, sessionId?: string) {
    super(config, apiKey, sessionId);
  }

  /**
   * Process input and return a response
   */
  async process(input: any, context: AgentContext): Promise<AgentResponse> {
    if (isLoggingEnabled()) {
      log(`[Tester] Processing input: ${JSON.stringify(input)}`);
    }

    // Prepare messages for the tester
    const messages = [
      { role: "system", content: this.prompt },
      { role: "user", content: this.formatUserInput(input, context) }
    ];

    // Define tools for the tester
    const tools = [
      {
        type: "function",
        function: {
          name: "test_report",
          description: "Report on test results",
          parameters: {
            type: "object",
            properties: {
              passed: {
                type: "boolean",
                description: "Whether the tests passed"
              },
              issues: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    file: {
                      type: "string",
                      description: "File with issues"
                    },
                    issue: {
                      type: "string",
                      description: "Description of the issue"
                    },
                    suggestion: {
                      type: "string",
                      description: "Suggestion to fix the issue"
                    }
                  },
                  required: ["issue"]
                }
              },
              testCommands: {
                type: "array",
                items: {
                  type: "string",
                  description: "Test commands that were run"
                }
              },
              summary: {
                type: "string",
                description: "Summary of test results"
              }
            },
            required: ["passed", "summary"]
          }
        }
      }
    ];

    try {
      const response = await this.callOpenAI(messages, tools);
      
      // Process the response
      const toolCalls = response.choices[0]?.message?.tool_calls || [];
      if (toolCalls.length > 0) {
        const toolCall = toolCalls[0];
        const functionName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        
        if (functionName === "test_report") {
          // Determine next action based on test results
          let nextAction: NextAction;
          if (args.passed) {
            nextAction = { type: "continue", nextRole: AgentRole.REVIEWER };
          } else {
            // If tests failed, go back to the coder
            nextAction = { 
              type: "reject", 
              reason: "Tests failed: " + args.summary, 
              suggestedRole: AgentRole.CODER 
            };
          }
          
          return {
            output: {
              passed: args.passed,
              issues: args.issues,
              testCommands: args.testCommands,
              summary: args.summary
            },
            nextAction,
            metadata: { model: this.config.model }
          };
        }
      }
      
      // Fallback if no tool call was made
      return {
        output: {
          message: response.choices[0]?.message?.content || "No response generated",
          passed: false
        },
        nextAction: { type: "continue", nextRole: AgentRole.REVIEWER },
        metadata: { model: this.config.model }
      };
    } catch (error) {
      if (isLoggingEnabled()) {
        log(`[Tester] Error: ${error instanceof Error ? error.message : String(error)}`);
      }
      
      throw error;
    }
  }

  /**
   * Format user input for the tester
   */
  private formatUserInput(input: any, context: AgentContext): string {
    let formattedInput = "";
    
    // Find the most recent coder output with file changes
    const recentChanges = context.conversationHistory
      .filter(msg => msg.role === AgentRole.CODER && msg.metadata?.output?.file)
      .slice(-3);
    
    formattedInput = `User Request: ${context.userInput}\n\n`;
    
    if (recentChanges.length > 0) {
      formattedInput += "Recent Changes:\n";
      recentChanges.forEach(change => {
        const output = change.metadata?.output;
        if (output) {
          formattedInput += `File: ${output.file}\n`;
          formattedInput += `Patch:\n\`\`\`\n${output.patch}\n\`\`\`\n\n`;
          if (output.explanation) {
            formattedInput += `Explanation: ${output.explanation}\n\n`;
          }
        }
      });
    }
    
    formattedInput += "Please test these changes and provide a detailed report. Consider what tests should be run and what potential issues might arise.";
    
    return formattedInput;
  }
}

/**
 * Implementation of the Reviewer agent
 */
export class ReviewerAgent extends BaseAgent {
  constructor(config: AgentConfig, apiKey: string, sessionId?: string) {
    super(config, apiKey, sessionId);
  }

  /**
   * Process input and return a response
   */
  async process(input: any, context: AgentContext): Promise<AgentResponse> {
    if (isLoggingEnabled()) {
      log(`[Reviewer] Processing input: ${JSON.stringify(input)}`);
    }

    // Prepare messages for the reviewer
    const messages = [
      { role: "system", content: this.prompt },
      { role: "user", content: this.formatUserInput(input, context) }
    ];

    // Define tools for the reviewer
    const tools = [
      {
        type: "function",
        function: {
          name: "review_report",
          description: "Provide a code review report",
          parameters: {
            type: "object",
            properties: {
              approved: {
                type: "boolean",
                description: "Whether the changes are approved"
              },
              feedback: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    file: {
                      type: "string",
                      description: "File being reviewed"
                    },
                    comments: {
                      type: "array",
                      items: {
                        type: "string",
                        description: "Review comment"
                      }
                    }
                  },
                  required: ["file", "comments"]
                }
              },
              summary: {
                type: "string",
                description: "Summary of the review"
              },
              finalResponse: {
                type: "string",
                description: "Final response to the user"
              }
            },
            required: ["approved", "summary", "finalResponse"]
          }
        }
      }
    ];

    try {
      const response = await this.callOpenAI(messages, tools);
      
      // Process the response
      const toolCalls = response.choices[0]?.message?.tool_calls || [];
      if (toolCalls.length > 0) {
        const toolCall = toolCalls[0];
        const functionName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        
        if (functionName === "review_report") {
          // Determine next action based on review results
          let nextAction: NextAction;
          if (args.approved) {
            nextAction = { 
              type: "complete", 
              finalOutput: args.finalResponse 
            };
          } else {
            // If review failed, suggest going back to the appropriate agent
            // Typically this would be the coder, but could be the architect
            // if architectural issues were found
            nextAction = { 
              type: "reject", 
              reason: "Review found issues: " + args.summary, 
              suggestedRole: AgentRole.CODER
            };
          }
          
          return {
            output: {
              approved: args.approved,
              feedback: args.feedback,
              summary: args.summary,
              finalResponse: args.finalResponse
            },
            nextAction,
            metadata: { model: this.config.model }
          };
        }
      }
      
      // Fallback if no tool call was made
      return {
        output: {
          message: response.choices[0]?.message?.content || "No response generated",
          approved: true,
          finalResponse: response.choices[0]?.message?.content || "Task completed successfully."
        },
        nextAction: { 
          type: "complete", 
          finalOutput: response.choices[0]?.message?.content || "Task completed successfully." 
        },
        metadata: { model: this.config.model }
      };
    } catch (error) {
      if (isLoggingEnabled()) {
        log(`[Reviewer] Error: ${error instanceof Error ? error.message : String(error)}`);
      }
      
      throw error;
    }
  }

  /**
   * Format user input for the reviewer
   */
  private formatUserInput(input: any, context: AgentContext): string {
    let formattedInput = "";
    
    // Compile all the information needed for a comprehensive review
    formattedInput = `User Request: ${context.userInput}\n\n`;
    
    // Include architect's plan
    const architectPlan = context.conversationHistory
      .filter(msg => msg.role === AgentRole.ARCHITECT && msg.metadata?.output?.plan)
      .slice(-1)[0];
    
    if (architectPlan) {
      formattedInput += "Architecture Plan:\n";
      const plan = architectPlan.metadata?.output?.plan;
      if (Array.isArray(plan)) {
        plan.forEach((item: any, index: number) => {
          formattedInput += `${index + 1}. ${item.kind}: ${item.file || item.cmd || 'N/A'}\n`;
          if (item.description) {
            formattedInput += `   Description: ${item.description}\n`;
          }
        });
      }
      formattedInput += "\n";
    }
    
    // Include coder's changes
    const coderChanges = context.conversationHistory
      .filter(msg => msg.role === AgentRole.CODER && msg.metadata?.output?.file)
      .slice(-5);
    
    if (coderChanges.length > 0) {
      formattedInput += "Code Changes:\n";
      coderChanges.forEach(change => {
        const output = change.metadata?.output;
        if (output) {
          formattedInput += `File: ${output.file}\n`;
          formattedInput += `Patch:\n\`\`\`\n${output.patch}\n\`\`\`\n\n`;
          if (output.explanation) {
            formattedInput += `Explanation: ${output.explanation}\n\n`;
          }
        }
      });
    }
    
    // Include test results
    const testResults = context.conversationHistory
      .filter(msg => msg.role === AgentRole.TESTER && msg.metadata?.output?.summary)
      .slice(-1)[0];
    
    if (testResults) {
      const output = testResults.metadata?.output;
      formattedInput += "Test Results:\n";
      formattedInput += `Status: ${output.passed ? 'PASSED' : 'FAILED'}\n`;
      formattedInput += `Summary: ${output.summary}\n\n`;
      
      if (output.issues && output.issues.length > 0) {
        formattedInput += "Issues:\n";
        output.issues.forEach((issue: any) => {
          formattedInput += `- ${issue.file || 'General'}: ${issue.issue}\n`;
          if (issue.suggestion) {
            formattedInput += `  Suggestion: ${issue.suggestion}\n`;
          }
        });
        formattedInput += "\n";
      }
    }
    
    formattedInput += "Please review all the changes and provide a comprehensive code review. Consider code quality, adherence to the user's request, architectural decisions, and test coverage. Approve the changes if they satisfy the requirements or suggest improvements.";
    
    return formattedInput;
  }
}

/**
 * Factory function to create agent instances
 */
export function createAgent(
  role: AgentRole, 
  config: AgentConfig, 
  apiKey: string, 
  sessionId?: string
): Agent {
  switch (role) {
    case AgentRole.ORCHESTRATOR:
      return new OrchestratorAgent(config, apiKey, sessionId);
    case AgentRole.ARCHITECT:
      return new ArchitectAgent(config, apiKey, sessionId);
    case AgentRole.CODER:
      return new CoderAgent(config, apiKey, sessionId);
    case AgentRole.TESTER:
      return new TesterAgent(config, apiKey, sessionId);
    case AgentRole.REVIEWER:
      return new ReviewerAgent(config, apiKey, sessionId);
    default:
      throw new Error(`Unknown agent role: ${role}`);
  }
}