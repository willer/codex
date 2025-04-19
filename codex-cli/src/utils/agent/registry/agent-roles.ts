/**
 * Defines the available agent roles in the multi-agent system
 */
export enum AgentRole {
  ORCHESTRATOR = "orchestrator",
  ARCHITECT = "architect", 
  CODER = "coder",
  TESTER = "tester",
  REVIEWER = "reviewer"
}

/**
 * Configuration for a specific agent
 */
export interface AgentConfig {
  role: AgentRole;
  model: string;
  temperature: number;
  promptPath: string;
  enabled: boolean;
}

/**
 * Default configurations for each agent role
 */
export const defaultAgentConfigs: Record<AgentRole, AgentConfig> = {
  [AgentRole.ORCHESTRATOR]: { 
    role: AgentRole.ORCHESTRATOR, 
    model: "o4-mini", 
    temperature: 0.3,
    promptPath: "prompts/orchestrator.md",
    enabled: true
  },
  [AgentRole.ARCHITECT]: {
    role: AgentRole.ARCHITECT,
    model: "o3",
    temperature: 0.7,
    promptPath: "prompts/architect.md",
    enabled: true
  },
  [AgentRole.CODER]: {
    role: AgentRole.CODER,
    model: "o4-mini",
    temperature: 0.2,
    promptPath: "prompts/coder.md",
    enabled: true
  },
  [AgentRole.TESTER]: {
    role: AgentRole.TESTER,
    model: "o4-mini",
    temperature: 0.4,
    promptPath: "prompts/tester.md",
    enabled: true
  },
  [AgentRole.REVIEWER]: {
    role: AgentRole.REVIEWER,
    model: "o3",
    temperature: 0.5,
    promptPath: "prompts/reviewer.md",
    enabled: true
  }
};