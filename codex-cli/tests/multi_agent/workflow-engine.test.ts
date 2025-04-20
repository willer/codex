import { WorkflowEngine, WorkflowStep, WorkflowPlan } from "../../src/utils/agent/multi-agent/workflow-engine";
import { AgentRole } from "../../src/utils/agent/multi-agent/agent-registry";
import { Agent, AgentContext, AgentResponse } from "../../src/utils/agent/multi-agent/agent-interface";

// Mock agent implementation
class MockAgent implements Agent {
  constructor(public role: AgentRole, private response: AgentResponse) {}
  
  async process(input: any, context: AgentContext): Promise<AgentResponse> {
    return this.response;
  }
}

describe("Workflow Engine", () => {
  // Create mock context
  const mockContext: AgentContext = {
    userInput: "Test request",
    conversationHistory: [],
    taskState: {
      status: "planning",
      currentStep: 0,
      totalSteps: 0
    },
    repoContext: {
      rootPath: "/test",
      fileStructure: [],
      gitInfo: {
        currentBranch: "main",
        isClean: true
      }
    },
    roleSpecificContext: {}
  };
  
  test("createPlan should generate a plan from orchestrator output", async () => {
    // Create mock agents
    const mockAgents = new Map<AgentRole, Agent>();
    
    // Mock orchestrator that returns a plan
    mockAgents.set(AgentRole.ORCHESTRATOR, new MockAgent(
      AgentRole.ORCHESTRATOR,
      {
        output: {
          plan: {
            steps: [
              { role: AgentRole.ARCHITECT, action: "Design solution" },
              { role: AgentRole.CODER, action: "Implement code" }
            ]
          }
        },
        nextAction: { type: "continue" },
        metadata: {}
      }
    ));
    
    // Mock step completion callback
    const onStepCompleted = jest.fn();
    const onPlanUpdated = jest.fn();
    
    // Create workflow engine
    const workflowEngine = new WorkflowEngine(
      mockAgents,
      mockContext,
      {
        onStepCompleted,
        onPlanUpdated
      }
    );
    
    // Create plan
    const plan = await workflowEngine.createPlan();
    
    // Verify plan
    expect(plan).toBeDefined();
    expect(plan.steps.length).toBe(2);
    expect(plan.steps[0].role).toBe(AgentRole.ARCHITECT);
    expect(plan.steps[1].role).toBe(AgentRole.CODER);
    expect(plan.status).toBe("executing");
    expect(plan.currentStepIndex).toBe(0);
    
    // Verify callback was called
    expect(onPlanUpdated).toHaveBeenCalledWith(plan);
  });
  
  test("execute should process steps in order", async () => {
    // Create mock agents
    const mockAgents = new Map<AgentRole, Agent>();
    
    // Mock orchestrator that returns a plan
    mockAgents.set(AgentRole.ORCHESTRATOR, new MockAgent(
      AgentRole.ORCHESTRATOR,
      {
        output: {
          plan: {
            steps: [
              { role: AgentRole.ARCHITECT, action: "Design solution" },
              { role: AgentRole.CODER, action: "Implement code" }
            ]
          }
        },
        nextAction: { type: "continue" },
        metadata: {}
      }
    ));
    
    // Mock architect
    mockAgents.set(AgentRole.ARCHITECT, new MockAgent(
      AgentRole.ARCHITECT,
      {
        output: { design: "Test design" },
        nextAction: { type: "continue" },
        metadata: {}
      }
    ));
    
    // Mock coder
    mockAgents.set(AgentRole.CODER, new MockAgent(
      AgentRole.CODER,
      {
        output: { implementation: "Test implementation" },
        nextAction: { type: "complete", finalOutput: "Task completed" },
        metadata: {}
      }
    ));
    
    // Mock callbacks
    const onStepCompleted = jest.fn();
    const onPlanUpdated = jest.fn();
    
    // Create workflow engine
    const workflowEngine = new WorkflowEngine(
      mockAgents,
      mockContext,
      {
        onStepCompleted,
        onPlanUpdated
      }
    );
    
    // Execute workflow
    await workflowEngine.execute();
    
    // Verify steps were completed
    expect(onStepCompleted).toHaveBeenCalledTimes(2);
    
    // Verify plan was updated
    expect(onPlanUpdated).toHaveBeenCalled();
    const finalPlanCall = onPlanUpdated.mock.calls[onPlanUpdated.mock.calls.length - 1][0];
    expect(finalPlanCall.status).toBe("completed");
  });
});