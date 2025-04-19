import { test, expect } from "vitest";
import { validateChangePlan } from "../../src/utils/agent/change_plan";

test("validates a valid change plan", () => {
  const validPlan = {
    actions: [
      {
        kind: "edit",
        file: "src/foo.ts",
        description: "Add helper function",
      },
      {
        kind: "command",
        cmd: "npm test",
      },
      {
        kind: "message",
        content: "This is a message to the user",
      },
    ],
  };
  
  expect(() => validateChangePlan(validPlan)).not.toThrow();
  
  const result = validateChangePlan(validPlan);
  expect(result.actions).toHaveLength(3);
  expect(result.actions[0].kind).toBe("edit");
  expect(result.actions[1].kind).toBe("command");
  expect(result.actions[2].kind).toBe("message");
});

test("rejects invalid change plans", () => {
  // Missing file in edit action
  const missingFile = {
    actions: [
      {
        kind: "edit",
        description: "Add helper function",
      },
    ],
  };
  
  expect(() => validateChangePlan(missingFile)).toThrow();
  
  // Missing content in message action
  const missingContent = {
    actions: [
      {
        kind: "message",
      },
    ],
  };
  
  expect(() => validateChangePlan(missingContent)).toThrow();
  
  // Invalid action kind
  const invalidKind = {
    actions: [
      {
        kind: "invalid",
        something: "value",
      },
    ],
  };
  
  expect(() => validateChangePlan(invalidKind)).toThrow();
  
  // Empty actions array
  const emptyActions = {
    actions: [],
  };
  
  // Empty actions is valid, just doesn't do anything
  expect(() => validateChangePlan(emptyActions)).not.toThrow();
  
  // Missing actions property
  const missingActions = {};
  
  expect(() => validateChangePlan(missingActions)).toThrow();
});

test("handles optional fields correctly", () => {
  const planWithOptionals = {
    actions: [
      {
        kind: "edit",
        file: "src/foo.ts",
        description: "Add helper function",
        hints: "Use recursion",
      },
      {
        kind: "command",
        cmd: "npm test",
        expect: "pass",
      },
    ],
  };
  
  const result = validateChangePlan(planWithOptionals);
  expect(result.actions[0].hints).toBe("Use recursion");
  expect((result.actions[1] as any).expect).toBe("pass");
  
  // Invalid enum value
  const invalidEnum = {
    actions: [
      {
        kind: "command",
        cmd: "npm test",
        expect: "invalid",
      },
    ],
  };
  
  expect(() => validateChangePlan(invalidEnum)).toThrow();
});