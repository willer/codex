import { AgentRole, defaultAgentConfigs, defaultMultiAgentConfig } from "../../src/utils/agent/multi-agent/agent-registry";

describe("Agent Registry", () => {
  test("AgentRole enum contains expected roles", () => {
    expect(Object.values(AgentRole)).toContain(AgentRole.ORCHESTRATOR);
    expect(Object.values(AgentRole)).toContain(AgentRole.ARCHITECT);
    expect(Object.values(AgentRole)).toContain(AgentRole.CODER);
    expect(Object.values(AgentRole)).toContain(AgentRole.TESTER);
    expect(Object.values(AgentRole)).toContain(AgentRole.REVIEWER);
  });

  test("defaultAgentConfigs contains configuration for all roles", () => {
    expect(defaultAgentConfigs).toHaveProperty(AgentRole.ORCHESTRATOR);
    expect(defaultAgentConfigs).toHaveProperty(AgentRole.ARCHITECT);
    expect(defaultAgentConfigs).toHaveProperty(AgentRole.CODER);
    expect(defaultAgentConfigs).toHaveProperty(AgentRole.TESTER);
    expect(defaultAgentConfigs).toHaveProperty(AgentRole.REVIEWER);
  });

  test("defaultAgentConfigs has correct structure for each role", () => {
    Object.values(AgentRole).forEach(role => {
      const config = defaultAgentConfigs[role];
      expect(config).toHaveProperty("role", role);
      expect(config).toHaveProperty("model");
      expect(config).toHaveProperty("temperature");
      expect(config).toHaveProperty("promptPath");
    });
  });

  test("defaultMultiAgentConfig has correct structure", () => {
    expect(defaultMultiAgentConfig).toHaveProperty("enabled", false);
    expect(defaultMultiAgentConfig).toHaveProperty("models");
    expect(defaultMultiAgentConfig).toHaveProperty("enabledRoles");
    
    // Check models property
    Object.values(AgentRole).forEach(role => {
      expect(defaultMultiAgentConfig.models).toHaveProperty(role);
    });
    
    // Check enabledRoles property
    Object.values(AgentRole).forEach(role => {
      expect(defaultMultiAgentConfig.enabledRoles).toHaveProperty(role);
    });
  });
});