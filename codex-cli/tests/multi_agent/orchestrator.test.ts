import { MultiAgentOrchestrator } from "../../src/utils/agent/multi-agent/orchestrator";
import { AgentRole } from "../../src/utils/agent/multi-agent/agent-registry";
import { AppConfig } from "../../src/utils/config";

// Mock AppConfig
const mockConfig: AppConfig = {
  model: "o4-mini",
  instructions: "",
  notify: false,
  multiAgent: {
    enabled: true,
    models: {
      orchestrator: "o4-mini",
      architect: "o3",
      coder: "o4-mini",
      tester: "o4-mini",
      reviewer: "o3"
    },
    enabledRoles: {
      orchestrator: true,
      architect: true,
      coder: true,
      tester: true,
      reviewer: true
    }
  }
};

// Mock the OpenAI client and other external dependencies
jest.mock("openai", () => {
  return {
    __esModule: true,
    default: class MockOpenAI {
      constructor() {}
      
      chat = {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{
              message: {
                content: "Mock response",
                tool_calls: [{
                  function: {
                    name: "create_workflow_plan",
                    arguments: JSON.stringify({
                      steps: [
                        { role: "architect", action: "Design solution", description: "Plan the implementation" },
                        { role: "coder", action: "Implement code", description: "Write the code" }
                      ],
                      reasoning: "Mock reasoning"
                    })
                  }
                }]
              }
            }]
          })
        }
      }
    },
    APIConnectionTimeoutError: class MockTimeoutError extends Error {}
  };
});

describe("MultiAgentOrchestrator", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  
  test("initialize should create agents for all roles", () => {
    const orchestrator = new MultiAgentOrchestrator({
      config: mockConfig
    });
    
    // Mock the initialization of agents
    const spyInitialize = jest.spyOn(orchestrator as any, "initialize");
    
    orchestrator.initialize();
    
    expect(spyInitialize).toHaveBeenCalled();
  });
  
  test("setRepoContext should update the context", () => {
    const orchestrator = new MultiAgentOrchestrator({
      config: mockConfig
    });
    
    const repoContext = {
      rootPath: "/test",
      fileStructure: ["file1.ts", "file2.ts"],
      gitInfo: {
        currentBranch: "main",
        isClean: true
      }
    };
    
    orchestrator.setRepoContext(repoContext);
    
    // Verify context was updated
    expect((orchestrator as any).context.repoContext).toEqual(repoContext);
  });
  
  test("executeRequest should call appropriate callbacks", async () => {
    // Mock callbacks
    const onResponse = jest.fn();
    const onStateChange = jest.fn();
    const onStepCompleted = jest.fn();
    
    // Mock the agent implementations
    const mockExecute = jest.fn().mockResolvedValue({});
    jest.spyOn(MultiAgentOrchestrator.prototype as any, "initialize").mockImplementation(() => {});
    
    // Create orchestrator with mocked dependencies
    const orchestrator = new MultiAgentOrchestrator({
      config: mockConfig,
      onResponse,
      onStateChange,
      onStepCompleted
    });
    
    // Mock the workflow engine
    (orchestrator as any).workflowEngine = {
      execute: mockExecute,
      createPlan: jest.fn().mockResolvedValue({
        steps: [],
        currentStepIndex: 0,
        status: "completed"
      })
    };
    
    // Execute request
    await orchestrator.executeRequest("Test request");
    
    // Verify execution
    expect(mockExecute).toHaveBeenCalled();
    expect(onStateChange).toHaveBeenCalled();
  });
});