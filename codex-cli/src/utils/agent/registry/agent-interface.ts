import { AgentRole } from "./agent-roles";

/**
 * Message in the conversation history
 */
export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: Record<string, any>;
}

/**
 * Repository context for agents
 */
export interface RepoContext {
  repositoryRoot: string;
  currentDirectory: string;
  projectStructure: string;
  relevantFiles: Array<string>;
  fileContents: Record<string, string>;
}

/**
 * Current state of the task being worked on
 */
export interface TaskState {
  taskId: string;
  status: "planning" | "executing" | "reviewing" | "testing" | "completed" | "failed";
  createdFiles: Array<string>;
  modifiedFiles: Array<string>;
  testResults?: Record<string, any>;
  errors?: Array<{
    message: string;
    file?: string;
    lineNumber?: number;
  }>;
}

/**
 * Context provided to agents for processing
 */
export interface AgentContext {
  userInput: string;
  conversationHistory: Array<Message>;
  taskState: TaskState;
  repoContext: RepoContext;
  roleSpecificContext: Record<string, any>;
}

/**
 * Slice of context tailored for a specific agent role
 */
export interface ContextSlice {
  userInput: string;
  relevantHistory: Array<Message>;
  relevantRepoContext: Partial<RepoContext>;
  taskState: Partial<TaskState>;
  roleSpecificContext: Record<string, any>;
}

/**
 * Type for the different actions an agent can suggest after processing
 */
export type NextAction = 
  | { type: "continue", nextRole?: AgentRole }
  | { type: "reject", reason: string, suggestedRole: AgentRole }
  | { type: "complete", finalOutput: string }
  | { type: "question", question: string, targetRole: AgentRole };

/**
 * Response from an agent after processing
 */
export interface AgentResponse {
  output: any;
  nextAction: NextAction;
  metadata: Record<string, any>;
}

/**
 * Interface that all agents must implement
 */
export interface Agent {
  role: AgentRole;
  process(input: any, context: AgentContext): Promise<AgentResponse>;
}

/**
 * Creates a context slice tailored for a specific agent role
 * 
 * This function extracts just the information needed by a particular
 * agent role to minimize token usage and context pollution
 */
export function buildContextForAgent(role: AgentRole, context: AgentContext): ContextSlice {
  // Base context that all agents receive
  const baseContext: ContextSlice = {
    userInput: context.userInput,
    relevantHistory: [],
    relevantRepoContext: {
      repositoryRoot: context.repoContext.repositoryRoot,
      currentDirectory: context.repoContext.currentDirectory,
    },
    taskState: {
      taskId: context.taskState.taskId,
      status: context.taskState.status,
    },
    roleSpecificContext: {},
  };
  
  // Add role-specific context
  switch (role) {
    case AgentRole.ORCHESTRATOR:
      // Orchestrator needs access to the full conversation history
      baseContext.relevantHistory = context.conversationHistory;
      baseContext.relevantRepoContext.projectStructure = context.repoContext.projectStructure;
      baseContext.taskState = context.taskState;
      break;
      
    case AgentRole.ARCHITECT:
      // Architect needs project structure and file info
      baseContext.relevantHistory = context.conversationHistory.slice(-5); // Last 5 messages
      baseContext.relevantRepoContext.projectStructure = context.repoContext.projectStructure;
      baseContext.relevantRepoContext.relevantFiles = context.repoContext.relevantFiles;
      baseContext.taskState = context.taskState;
      break;
      
    case AgentRole.CODER:
      // Coder needs specific file contents
      baseContext.relevantHistory = context.conversationHistory.filter(
        msg => msg.role === "system" || msg.metadata?.["fromRole"] === AgentRole.ARCHITECT
      );
      baseContext.relevantRepoContext.relevantFiles = context.repoContext.relevantFiles;
      baseContext.relevantRepoContext.fileContents = context.repoContext.fileContents;
      baseContext.taskState = {
        taskId: context.taskState.taskId,
        status: context.taskState.status,
        modifiedFiles: context.taskState.modifiedFiles,
        createdFiles: context.taskState.createdFiles,
      };
      break;
      
    case AgentRole.TESTER:
      // Tester needs modified files and test context
      baseContext.relevantHistory = context.conversationHistory.filter(
        msg => msg.role === "system" || 
               msg.metadata?.["fromRole"] === AgentRole.ARCHITECT ||
               msg.metadata?.["fromRole"] === AgentRole.CODER
      );
      baseContext.relevantRepoContext.relevantFiles = context.repoContext.relevantFiles;
      baseContext.relevantRepoContext.fileContents = context.repoContext.fileContents;
      baseContext.taskState = {
        taskId: context.taskState.taskId,
        status: context.taskState.status,
        modifiedFiles: context.taskState.modifiedFiles,
        createdFiles: context.taskState.createdFiles,
      };
      break;
      
    case AgentRole.REVIEWER:
      // Reviewer needs comprehensive view
      baseContext.relevantHistory = context.conversationHistory;
      baseContext.relevantRepoContext = context.repoContext;
      baseContext.taskState = context.taskState;
      break;
  }
  
  return baseContext;
}