import { z } from "zod";

/**
 * Represents an action to be taken by the Coder agent
 */
export const ActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("edit"),
    file: z.string(),
    description: z.string(),
    hints: z.string().optional(),
  }),
  z.object({
    kind: z.literal("command"),
    cmd: z.string(),
    expect: z.enum(["pass", "fail"]).optional(),
  }),
  z.object({
    kind: z.literal("message"),
    content: z.string(),
  }),
]);

/**
 * The full Change Plan schema returned by the Architect model
 */
export const ChangePlanSchema = z.object({
  actions: z.array(ActionSchema),
});

/**
 * Types derived from the schemas
 */
export type Action = z.infer<typeof ActionSchema>;
export type EditAction = Extract<Action, { kind: "edit" }>;
export type CommandAction = Extract<Action, { kind: "command" }>;
export type MessageAction = Extract<Action, { kind: "message" }>;
export type ChangePlan = z.infer<typeof ChangePlanSchema>;

/**
 * Validates a Change Plan against the schema
 * @param input The raw input to validate as a Change Plan
 * @returns A validated ChangePlan object or throws an error
 */
export function validateChangePlan(input: unknown): ChangePlan {
  return ChangePlanSchema.parse(input);
}