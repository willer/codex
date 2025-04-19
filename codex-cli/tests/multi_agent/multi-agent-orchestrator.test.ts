import { test, expect, vi, beforeEach } from "vitest";
import { MultiAgentOrchestrator, MultiAgentOrchestratorState } from "../../src/utils/agent/multi-agent-orchestrator";
import { AgentRole } from "../../src/utils/agent/registry/agent-roles";
import { ReviewDecision } from "../../src/utils/agent/review";
import { AutoApprovalMode } from "../../src/utils/auto-approval-mode";

// Mock required modules
vi.mock("openai", async () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: "implementation" } }]
          })
        }
      }
    }))
  };
});

// Mock fs
vi.mock("fs", () => ({
  default: {
    readFileSync: vi.fn().mockReturnValue("mock prompt content"),
    existsSync: vi.fn().mockReturnValue(true)
  },
  readFileSync: vi.fn().mockReturnValue("mock prompt content"),
  existsSync: vi.fn().mockReturnValue(true)
}));

// Sample config and handlers for testing
const mockConfig = {
  model: "gpt-4o-mini",
  architectModel: "o3",
  coderModel: "gpt-3.5-turbo",
  coderTemp: 0.2,
  instructions: "Test instructions",
  multiAgent: true,
  notify: false
};

const mockHandlers = {
  onItem: vi.fn(),
  onLoading: vi.fn(),
  getCommandConfirmation: vi.fn().mockResolvedValue({ review: ReviewDecision.YES }),
  onLastResponseId: vi.fn()
};

// Reset mocks before each test
beforeEach(() => {
  vi.resetAllMocks();
  global.multiAgentTelemetry = [];
});

test("MultiAgentOrchestrator initializes correctly", () => {
  const orchestrator = new MultiAgentOrchestrator({
    config: mockConfig,
    approvalPolicy: AutoApprovalMode.SUGGEST,
    ...mockHandlers
  });
  
  // Initial state should be IDLE
  expect((orchestrator as any).state).toBe(MultiAgentOrchestratorState.IDLE);
});

test("MultiAgentOrchestrator handles a simple request", async () => {
  const orchestrator = new MultiAgentOrchestrator({
    config: mockConfig,
    approvalPolicy: AutoApprovalMode.SUGGEST,
    ...mockHandlers
  });
  
  // Create a simple input
  const mockInput = [
    {
      content: [
        {
          type: "input_text",
          text: "Create a simple function"
        }
      ],
      role: "user"
    }
  ];
  
  // Run with the input
  await orchestrator.run(mockInput);
  
  // Should call onLoading at least twice (start and end)
  expect(mockHandlers.onLoading).toHaveBeenCalledTimes(2);
  
  // Should call onItem for system startup message
  expect(mockHandlers.onItem).toHaveBeenCalled();
  
  // Check that we displayed the system intro message
  const introCall = mockHandlers.onItem.mock.calls.find(call => {
    const item = call[0];
    return item.role === 'system' && 
           item.content?.[0]?.text?.includes('multi-agent mode');
  });
  
  expect(introCall).toBeDefined();
});