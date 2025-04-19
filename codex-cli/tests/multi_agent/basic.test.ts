import { test, expect } from "vitest";
import { validateChangePlan } from "../../src/utils/agent/change_plan";

test("Can import the new multi-agent modules", () => {
  // This test simply verifies that we can import the new modules without errors
  expect(validateChangePlan).toBeDefined();
});

test("Can validate a basic change plan", () => {
  const plan = {
    actions: [
      {
        kind: "message",
        content: "Test message"
      }
    ]
  };
  
  const validatedPlan = validateChangePlan(plan);
  expect(validatedPlan.actions).toHaveLength(1);
  expect(validatedPlan.actions[0].kind).toBe("message");
});