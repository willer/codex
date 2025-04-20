// Agent Interface for the Multi-Agent architecture
import { AgentRole } from "./agent-registry";

/**
 * Interface for agent context that is passed between agents
 */
export interface AgentContext {
  userInput: string;
  conversationHistory: Array<Message>;
  taskState: TaskState;
  repoContext: RepoContext;
  roleSpecificContext: Record<string, any>;
}

/**
 * Context slice for a specific agent - only includes the 
 * information needed for that specific agent's task
 */
export interface ContextSlice {
  userRequest: string;
  relevantFiles: Array<FileContext>;
  previousActions: Array<AgentAction>;
  additionalContext: Record<string, any>;
}

/**
 * Represents a message in the conversation history
 */
export interface Message {
  role: string;
  content: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

/**
 * Represents the current state of the task
 */
export interface TaskState {
  status: "planning" | "executing" | "completed" | "failed";
  currentStep: number;
  totalSteps: number;
  plan?: AgentPlan;
  results?: Array<AgentResult>;
  errors?: Array<string>;
}

/**
 * Contains context about the repository
 */
export interface RepoContext {
  rootPath: string;
  fileStructure: Array<string>;
  gitInfo: GitInfo;
}

/**
 * Information about a specific file
 */
export interface FileContext {
  path: string;
  content: string;
  summary?: string;
}

/**
 * Contains git-related information about the repository
 */
export interface GitInfo {
  currentBranch: string;
  isClean: boolean;
  lastCommit?: {
    hash: string;
    message: string;
    author: string;
    date: string;
  };
}

/**
 * Represents a planned sequence of steps
 */
export interface AgentPlan {
  steps: Array<PlannedStep>;
}

/**
 * A step in an agent plan
 */
export interface PlannedStep {
  role: AgentRole;
  action: string;
  description: string;
  expectedOutput?: string;
}

/**
 * Result of an agent's action
 */
export interface AgentResult {
  role: AgentRole;
  actionTaken: string;
  output: string;
  status: "success" | "failure" | "partial";
  metadata?: Record<string, any>;
}

/**
 * Action taken by an agent
 */
export interface AgentAction {
  kind: "edit" | "command" | "message";
  role: AgentRole;
  details: EditAction | CommandAction | MessageAction;
  timestamp: number;
}

/**
 * Represents a file edit action
 */
export interface EditAction {
  file: string;
  description: string;
  hints?: string;
  diff?: string;
}

/**
 * Represents a command execution action
 */
export interface CommandAction {
  cmd: string;
  expect: "pass" | "fail" | "unknown";
  output?: string;
  exitCode?: number;
}

/**
 * Represents a message action
 */
export interface MessageAction {
  content: string;
  type: "question" | "answer" | "instruction" | "observation";
  targetRole?: AgentRole;
}

/**
 * Possible next actions an agent can take
 */
export type NextAction =
  | { type: "continue"; nextRole?: AgentRole }
  | { type: "reject"; reason: string; suggestedRole: AgentRole }
  | { type: "complete"; finalOutput: string }
  | { type: "question"; question: string; targetRole: AgentRole };

/**
 * Response from an agent after processing input
 */
export interface AgentResponse {
  output: any;
  nextAction: NextAction;
  metadata: Record<string, any>;
}

/**
 * Core agent interface that all agent implementations must implement
 */
export interface Agent {
  role: AgentRole;
  process(input: any, context: AgentContext): Promise<AgentResponse>;
}

/**
 * Builds the appropriate context slice for a specific agent role
 */
export function buildContextForAgent(
  role: AgentRole, 
  context: AgentContext
): ContextSlice {
  // Base context that all roles get
  const baseContext: ContextSlice = {
    userRequest: context.userInput,
    relevantFiles: [],
    previousActions: [],
    additionalContext: {}
  };
  
  // Add role-specific context
  switch (role) {
    case AgentRole.ORCHESTRATOR:
      // Orchestrator needs high-level overview
      return {
        ...baseContext,
        additionalContext: {
          taskOverview: true,
          projectStructure: true
        }
      };
      
    case AgentRole.ARCHITECT:
      // Architect needs detailed system architecture
      return {
        ...baseContext,
        relevantFiles: getRelevantArchitectureFiles(context),
        additionalContext: {
          architecturalPatterns: true,
          systemConstraints: true
        }
      };
      
    case AgentRole.CODER:
      // Coder needs specific file contents
      return {
        ...baseContext,
        relevantFiles: getRelevantCodeFiles(context),
        additionalContext: {
          implementationDetails: true
        }
      };
      
    case AgentRole.TESTER:
      // Tester needs test requirements and code changes
      return {
        ...baseContext,
        relevantFiles: getRelevantTestFiles(context),
        additionalContext: {
          testRequirements: true,
          codeChanges: true
        }
      };
      
    case AgentRole.REVIEWER:
      // Reviewer needs comprehensive view of changes
      return {
        ...baseContext,
        relevantFiles: getAllChangedFiles(context),
        additionalContext: {
          reviewGuidelines: true,
          codeStandards: true
        }
      };
      
    default:
      return baseContext;
  }
}

// Helper functions to get relevant files for each agent role
// These would be implemented with real logic to find the right files
function getRelevantArchitectureFiles(context: AgentContext): Array<FileContext> {
  // In a real implementation, this would analyze the repo and find
  // architecture-relevant files like design docs, main components, etc.
  return [];
}

function getRelevantCodeFiles(context: AgentContext): Array<FileContext> {
  // In a real implementation, this would find files relevant to the
  // specific coding task based on the user's request
  return [];
}

function getRelevantTestFiles(context: AgentContext): Array<FileContext> {
  // In a real implementation, this would find test files related to
  // the code being changed or created
  return [];
}

function getAllChangedFiles(context: AgentContext): Array<FileContext> {
  // In a real implementation, this would track all files that have been
  // modified during the current task
  return [];
}