// Agent Registry for the Multi-Agent architecture
import path from "path";

/**
 * Defines the possible roles in the multi-agent system
 */
export enum AgentRole {
  ORCHESTRATOR = "orchestrator",
  ARCHITECT = "architect",
  CODER = "coder",
  TESTER = "tester",
  REVIEWER = "reviewer"
}

/**
 * Configuration for a single agent
 */
export interface AgentConfig {
  role: AgentRole;
  model: string;
  temperature: number;
  promptPath: string;
}

/**
 * Default configuration for each agent role
 */
export const defaultAgentConfigs: Record<AgentRole, AgentConfig> = {
  [AgentRole.ORCHESTRATOR]: {
    role: AgentRole.ORCHESTRATOR,
    model: "o4-mini",
    temperature: 1.0, // Use default temperature for OpenAI models
    promptPath: path.join("prompts", "orchestrator.md")
  },
  [AgentRole.ARCHITECT]: {
    role: AgentRole.ARCHITECT,
    model: "o3",
    temperature: 1.0, // Use default temperature for OpenAI models
    promptPath: path.join("prompts", "architect.md")
  },
  [AgentRole.CODER]: {
    role: AgentRole.CODER,
    model: "o4-mini",
    temperature: 1.0, // Use default temperature for OpenAI models
    promptPath: path.join("prompts", "coder.md")
  },
  [AgentRole.TESTER]: {
    role: AgentRole.TESTER,
    model: "o4-mini",
    temperature: 1.0, // Use default temperature for OpenAI models
    promptPath: path.join("prompts", "tester.md")
  },
  [AgentRole.REVIEWER]: {
    role: AgentRole.REVIEWER,
    model: "o3",
    temperature: 1.0, // Use default temperature for OpenAI models
    promptPath: path.join("prompts", "reviewer.md")
  }
};

/**
 * Configuration for the multi-agent system
 */
export interface MultiAgentConfig {
  enabled: boolean;
  models: Record<AgentRole, string>;
  enabledRoles: Record<AgentRole, boolean>;
}

/**
 * Default configuration for the multi-agent system
 */
export const defaultMultiAgentConfig: MultiAgentConfig = {
  enabled: false,
  models: {
    [AgentRole.ORCHESTRATOR]: "o4-mini",
    [AgentRole.ARCHITECT]: "o3",
    [AgentRole.CODER]: "o4-mini",
    [AgentRole.TESTER]: "o4-mini",
    [AgentRole.REVIEWER]: "o3"
  },
  enabledRoles: {
    [AgentRole.ORCHESTRATOR]: true,
    [AgentRole.ARCHITECT]: true,
    [AgentRole.CODER]: true,
    [AgentRole.TESTER]: true,
    [AgentRole.REVIEWER]: true
  }
};