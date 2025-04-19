import type { ApplyPatchCommand, ApprovalPolicy } from "../../approvals.js";
import type { CommandConfirmation } from "../../utils/agent/agent-loop.js";
import type { AppConfig } from "../../utils/config.js";
import type { ColorName } from "chalk";
import type { ResponseItem } from "openai/resources/responses/responses.mjs";

import TerminalChatInput from "./terminal-chat-input.js";
import { TerminalChatToolCallCommand } from "./terminal-chat-tool-call-item.js";
import {
  calculateContextPercentRemaining,
  uniqueById,
} from "./terminal-chat-utils.js";
import TerminalMessageHistory from "./terminal-message-history.js";
import { formatCommandForDisplay } from "../../format-command.js";
import { useConfirmation } from "../../hooks/use-confirmation.js";
import { useTerminalSize } from "../../hooks/use-terminal-size.js";
import { AgentLoop } from "../../utils/agent/agent-loop.js";
import { isLoggingEnabled, log } from "../../utils/agent/log.js";
import { ReviewDecision } from "../../utils/agent/review.js";
import { generateCompactSummary } from "../../utils/compact-summary.js";
import { OPENAI_BASE_URL } from "../../utils/config.js";
import { createInputItem } from "../../utils/input-utils.js";
import { getAvailableModels } from "../../utils/model-utils.js";
import { CLI_VERSION } from "../../utils/session.js";
import { shortCwd } from "../../utils/short-path.js";
import { saveRollout } from "../../utils/storage/save-rollout.js";
import ApprovalModeOverlay from "../approval-mode-overlay.js";
import HelpOverlay from "../help-overlay.js";
import HistoryOverlay from "../history-overlay.js";
import ModelOverlay from "../model-overlay.js";
import { Box, Text } from "ink";
import { exec } from "node:child_process";
import OpenAI from "openai";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { inspect } from "util";

type Props = {
  config: AppConfig;
  prompt?: string;
  imagePaths?: Array<string>;
  approvalPolicy: ApprovalPolicy;
  additionalWritableRoots: ReadonlyArray<string>;
  fullStdout: boolean;
};

const colorsByPolicy: Record<ApprovalPolicy, ColorName | undefined> = {
  "suggest": undefined,
  "auto-edit": "greenBright",
  "full-auto": "green",
};

/**
 * Generates an explanation for a shell command using the OpenAI API.
 *
 * @param command The command to explain
 * @param model The model to use for generating the explanation
 * @returns A human-readable explanation of what the command does
 */
async function generateCommandExplanation(
  command: Array<string>,
  model: string,
): Promise<string> {
  try {
    // Create a temporary OpenAI client
    const oai = new OpenAI({
      apiKey: process.env["OPENAI_API_KEY"],
      baseURL: OPENAI_BASE_URL,
    });

    // Format the command for display
    const commandForDisplay = formatCommandForDisplay(command);

    // Create a prompt that asks for an explanation with a more detailed system prompt
    const response = await oai.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are an expert in shell commands and terminal operations. Your task is to provide detailed, accurate explanations of shell commands that users are considering executing. Break down each part of the command, explain what it does, identify any potential risks or side effects, and explain why someone might want to run it. Be specific about what files or systems will be affected. If the command could potentially be harmful, make sure to clearly highlight those risks.",
        },
        {
          role: "user",
          content: `Please explain this shell command in detail: \`${commandForDisplay}\`\n\nProvide a structured explanation that includes:\n1. A brief overview of what the command does\n2. A breakdown of each part of the command (flags, arguments, etc.)\n3. What files, directories, or systems will be affected\n4. Any potential risks or side effects\n5. Why someone might want to run this command\n\nBe specific and technical - this explanation will help the user decide whether to approve or reject the command.`,
        },
      ],
    });

    // Extract the explanation from the response
    const explanation =
      response.choices[0]?.message.content || "Unable to generate explanation.";
    return explanation;
  } catch (error) {
    log(`Error generating command explanation: ${error}`);

    // Improved error handling with more specific error information
    let errorMessage = "Unable to generate explanation due to an error.";

    if (error instanceof Error) {
      // Include specific error message for better debugging
      errorMessage += ` (${error.message})`;
    }

    return errorMessage;
  }
}

/**
 * Terminal chat component that manages inputs, messages, history, etc.
 */
export default function TerminalChat({
  config,
  prompt,
  imagePaths,
  approvalPolicy: initialApprovalPolicy,
  additionalWritableRoots,
  fullStdout,
}: Props): JSX.Element {
  const [items, setItems] = useState<Array<ResponseItem>>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [thinkingTimeSec, setThinkingTimeSec] = useState<number>(0);
  const [overlayMode, setOverlayMode] = useState<
    "none" | "history" | "model" | "help" | "approval" | "onboarding"
  >("none");
  const [model, setModel] = useState<string>(() => config.model);
  const [availableModels, setAvailableModels] = useState<Array<string>>([]);
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>(
    initialApprovalPolicy,
  );
  const [lastResponseId, setLastResponseId] = useState<string | null>(null);
  const { terminalRows } = useTerminalSize();
  const agentRef = useRef<any>();
  const [, forceUpdate] = useState<unknown>();

  const agent = agentRef.current;

  const { confirm: requestConfirmation } = useConfirmation();

  // Only show this when displaying in full-detail mode
  const contextPercentRemaining = useMemo(() => {
    const mostRecentItems = items.slice(-20);
    return calculateContextPercentRemaining(mostRecentItems) * 100;
  }, [items]);

  useEffect(() => {
    getAvailableModels().then((models) => {
      // TS Validation: models must be string[] per the function signature
      setAvailableModels(models || []);
    });
  }, []);

  useEffect(() => {
    if (prompt) {
      (async () => {
        log(`Processing prompt: ${prompt}`);
        const item = await createInputItem(prompt, imagePaths);
        agentRef.current?.run([item]);
      })();
    }
  }, [prompt, imagePaths]);

  useEffect(() => {
    if (isLoggingEnabled()) {
      log("creating NEW AgentLoop");
      log(
        `model=${model} instructions=${Boolean(
          config.instructions,
        )} approvalPolicy=${approvalPolicy}`,
      );
    }

    // Tear down any existing loop before creating a new one
    agentRef.current?.terminate();

    const initializeAgent = async () => {
      try {
        // Check if multi-agent mode is enabled
        if (config.multiAgent) {
          try {
            // Import MultiAgentOrchestrator dynamically
            const { MultiAgentOrchestrator } = await import("../../utils/agent/multi-agent-orchestrator.js");
            
            // Create MultiAgentOrchestrator instance
            agentRef.current = new MultiAgentOrchestrator({
              config,
              approvalPolicy,
              onLastResponseId: setLastResponseId,
              onItem: (item) => {
                log(`onItem: ${JSON.stringify(item)}`);
                setItems((prev) => {
                  const updated = uniqueById([...prev, item as ResponseItem]);
                  saveRollout(updated);
                  return updated;
                });
              },
              onLoading: setLoading,
              getCommandConfirmation: async (
                command: Array<string>,
                applyPatch: ApplyPatchCommand | undefined,
              ): Promise<CommandConfirmation> => {
                log(`getCommandConfirmation: ${command}`);
                const commandForDisplay = formatCommandForDisplay(command);
  
                // First request for confirmation
                let { decision: review, customDenyMessage } = await requestConfirmation(
                  <TerminalChatToolCallCommand commandForDisplay={commandForDisplay} />,
                );
  
                // If the user wants an explanation, generate one and ask again
                if (review === ReviewDecision.EXPLAIN) {
                  log(`Generating explanation for command: ${commandForDisplay}`);
  
                  // Generate an explanation using the same model
                  const explanation = await generateCommandExplanation(command, model);
                  log(`Generated explanation: ${explanation}`);
  
                  // Ask for confirmation again, but with the explanation
                  const confirmResult = await requestConfirmation(
                    <TerminalChatToolCallCommand
                      commandForDisplay={commandForDisplay}
                      explanation={explanation}
                    />,
                  );
  
                  // Update the decision based on the second confirmation
                  review = confirmResult.decision;
                  customDenyMessage = confirmResult.customDenyMessage;
  
                  // Return the final decision with the explanation
                  return { review, customDenyMessage, applyPatch, explanation };
                }
  
                return { review, customDenyMessage, applyPatch };
              },
            });
          } catch (error) {
            // Log error and fall back to legacy AgentLoop
            log(`Error initializing MultiAgentOrchestrator: ${error}, falling back to legacy mode`);
            
            createLegacyAgentLoop();
          }
        } else {
          // Legacy single-agent mode
          createLegacyAgentLoop();
        }
        
        // Force a render so JSX below can "see" the freshly created agent
        forceUpdate({});
      } catch (error) {
        log(`Error initializing agent: ${error}`);
      }
    };
    
    // Helper function to create the legacy AgentLoop
    function createLegacyAgentLoop() {
      agentRef.current = new AgentLoop({
        model,
        config,
        instructions: config.instructions,
        approvalPolicy,
        additionalWritableRoots,
        onLastResponseId: setLastResponseId,
        onItem: (item) => {
          log(`onItem: ${JSON.stringify(item)}`);
          setItems((prev) => {
            const updated = uniqueById([...prev, item as ResponseItem]);
            saveRollout(updated);
            return updated;
          });
        },
        onLoading: setLoading,
        getCommandConfirmation: async (
          command: Array<string>,
          applyPatch: ApplyPatchCommand | undefined,
        ): Promise<CommandConfirmation> => {
          log(`getCommandConfirmation: ${command}`);
          const commandForDisplay = formatCommandForDisplay(command);

          // First request for confirmation
          let { decision: review, customDenyMessage } = await requestConfirmation(
            <TerminalChatToolCallCommand commandForDisplay={commandForDisplay} />,
          );

          // If the user wants an explanation, generate one and ask again
          if (review === ReviewDecision.EXPLAIN) {
            log(`Generating explanation for command: ${commandForDisplay}`);

            // Generate an explanation using the same model
            const explanation = await generateCommandExplanation(command, model);
            log(`Generated explanation: ${explanation}`);

            // Ask for confirmation again, but with the explanation
            const confirmResult = await requestConfirmation(
              <TerminalChatToolCallCommand
                commandForDisplay={commandForDisplay}
                explanation={explanation}
              />,
            );

            // Update the decision based on the second confirmation
            review = confirmResult.decision;
            customDenyMessage = confirmResult.customDenyMessage;

            // Return the final decision with the explanation
            return { review, customDenyMessage, applyPatch, explanation };
          }

          return { review, customDenyMessage, applyPatch };
        },
      });
    }
    
    // Initialize the agent
    initializeAgent();

    if (isLoggingEnabled()) {
      log(`AgentLoop created: ${inspect(agentRef.current, { depth: 1 })}`);
    }

    return () => {
      if (isLoggingEnabled()) {
        log("terminating AgentLoop");
      }
      agentRef.current?.terminate();
      agentRef.current = undefined;
      forceUpdate({}); // re‑render after teardown too
    };
  }, [
    model,
    config,
    approvalPolicy,
    requestConfirmation,
    additionalWritableRoots,
  ]);

  // whenever loading starts/stops, reset or start a timer — but pause the
  // timer while a confirmation overlay is displayed so we don't trigger a
  // re‑render every second during apply_patch reviews.
  useEffect(() => {
    let handle: ReturnType<typeof setInterval> | null = null;
    // Only tick the "thinking…" timer when the agent is actually processing
    if (loading) {
      handle = setInterval(() => {
        setThinkingTimeSec((prev) => prev + 1);
      }, 1000);
    } else {
      // clear the timer when loading is done
      setThinkingTimeSec(0);
    }

    return () => {
      if (handle) {
        clearInterval(handle);
      }
    };
  }, [loading]);

  const [PWD, inGitRepo] = useMemo(
    () => [shortCwd(process.cwd()), checkInGit(process.cwd())],
    [],
  );

  const compactMode = terminalRows < 10;

  if (!agent) {
    return (
      <>
        <Box padding={1}>
          <Text>Starting CLI…</Text>
        </Box>
      </>
    );
  }

  return (
    <>
      <Box flexDirection="column">
        <TerminalMessageHistory
          items={items}
          fullStdout={fullStdout}
          size={terminalRows - 4}
        />
        {loading ? (
          <>
            <Box padding={1} paddingBottom={0}>
              <Text>
                {compactMode ? (
                  <Text color="blueBright">Thinking...</Text>
                ) : (
                  <>
                    <Text>Agent is</Text>{" "}
                    <Text color="blueBright">
                      thinking... {thinkingTimeSec ? `(${thinkingTimeSec}s)` : ""}
                    </Text>{" "}
                    <Text color="gray">—</Text>{" "}
                    <Text dimColor>
                      context remaining:{" "}
                      <Text color="blueBright">
                        {contextPercentRemaining.toFixed(0)}%
                      </Text>
                    </Text>
                  </>
                )}
              </Text>
            </Box>
          </>
        ) : (
          <TerminalChatInput
            colorsByPolicy={colorsByPolicy}
            version={CLI_VERSION}
            PWD={PWD}
            model={model}
            approvalPolicy={approvalPolicy}
            agent={agent}
            hasLastResponse={Boolean(lastResponseId)}
            imagePaths={imagePaths}
            loading={loading}
            terminalRows={terminalRows}
            modelChoices={availableModels}
            config={config}
            onSelectHistory={() => setOverlayMode("history")}
            onSelectModel={() => setOverlayMode("model")}
            onSelectHelp={() => setOverlayMode("help")}
            onSelectApprovalMode={() => setOverlayMode("approval")}
            onInterruptAgent={() => {
              if (isLoggingEnabled()) {
                log(
                  "TerminalChatInput: interruptAgent invoked – calling agent.cancel()",
                );
                if (!agent) {
                  log("TerminalChatInput: agent is not ready yet");
                }
              }
              agent.cancel();
              setLoading(false);

              // Add a system message to indicate the interruption
              setItems((prev) => [
                ...prev,
                {
                  id: `interrupt-${Date.now()}`,
                  type: "message",
                  role: "system",
                  content: [
                    {
                      type: "input_text",
                      text: "⏹️  Execution interrupted by user. You can continue typing.",
                    },
                  ],
                },
              ]);
            }}
            submitInput={(inputs) => {
              agent.run(inputs, lastResponseId || "");
              return {};
            }}
          />
        )}
        {overlayMode === "history" && (
          <HistoryOverlay items={items} onExit={() => setOverlayMode("none")} />
        )}
        {overlayMode === "model" && (
          <ModelOverlay
            currentModel={model}
            hasLastResponse={Boolean(lastResponseId)}
            onSelect={(newModel) => {
              if (isLoggingEnabled()) {
                log(
                  "TerminalChat: interruptAgent invoked – calling agent.cancel()",
                );
                if (!agent) {
                  log("TerminalChat: agent is not ready yet");
                }
              }
              agent?.cancel();
              setLoading(false);

              setModel(newModel);
              setLastResponseId((prev) =>
                prev && newModel !== model ? null : prev,
              );

              setItems((prev) => [
                ...prev,
                {
                  id: `switch-model-${Date.now()}`,
                  type: "message",
                  role: "system",
                  content: [
                    {
                      type: "input_text",
                      text: `Switched model to ${newModel}`,
                    },
                  ],
                },
              ]);

              setOverlayMode("none");
            }}
            onExit={() => setOverlayMode("none")}
          />
        )}

        {overlayMode === "approval" && (
          <ApprovalModeOverlay
            currentMode={approvalPolicy}
            onSelect={(newMode) => {
              agent?.cancel();
              setLoading(false);
              if (newMode === approvalPolicy) {
                return;
              }
              setApprovalPolicy(newMode as ApprovalPolicy);
              setItems((prev) => [
                ...prev,
                {
                  id: `switch-approval-${Date.now()}`,
                  type: "message",
                  role: "system",
                  content: [
                    {
                      type: "input_text",
                      text: `Switched approval mode to ${newMode}`,
                    },
                  ],
                },
              ]);

              setOverlayMode("none");
            }}
            onExit={() => setOverlayMode("none")}
          />
        )}

        {overlayMode === "help" && (
          <HelpOverlay onExit={() => setOverlayMode("none")} />
        )}
      </Box>
    </>
  );
}

/**
 * Parses a git directory/repo (used in the header only)
 */
const checkInGit = (pwd: string): boolean => {
  try {
    const result = exec("git rev-parse --git-dir", {
      cwd: pwd,
      encoding: "utf8",
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
};