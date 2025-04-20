#!/usr/bin/env node
import "dotenv/config";

// Hack to suppress deprecation warnings (punycode)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process as any).noDeprecation = true;

import type { AppRollout } from "./app";
import type { ApprovalPolicy } from "./approvals";
import type { CommandConfirmation } from "./utils/agent/agent-loop";
import type { AppConfig } from "./utils/config";
import type { ResponseItem } from "openai/resources/responses/responses";

import App from "./app";
import { runSinglePass } from "./cli-singlepass";
import { runMultiAgent } from "./cli-multiagent";
import { AgentLoop } from "./utils/agent/agent-loop";
import { initLogger } from "./utils/agent/log";
import { ReviewDecision } from "./utils/agent/review";
import { AutoApprovalMode } from "./utils/auto-approval-mode";
import { checkForUpdates } from "./utils/check-updates";
import {
  loadConfig,
  PRETTY_PRINT,
  INSTRUCTIONS_FILEPATH,
} from "./utils/config";
import { createInputItem } from "./utils/input-utils";
import {
  isModelSupportedForResponses,
  preloadModels,
} from "./utils/model-utils.js";
import { parseToolCall } from "./utils/parsers";
import { onExit, setInkRenderer } from "./utils/terminal";
import chalk from "chalk";
import { spawnSync } from "child_process";
import fs from "fs";
import { render } from "ink";
import meow from "meow";
import path from "path";
import React from "react";

// Call this early so `tail -F "$TMPDIR/oai-codex/codex-cli-latest.log"` works
// immediately. This must be run with DEBUG=1 for logging to work.
initLogger();

// TODO: migrate to new versions of quiet mode
//
//     -q, --quiet    Non-interactive quiet mode that only prints final message
//     -j, --json     Non-interactive JSON output mode that prints JSON messages

const cli = meow(
  `
  Usage
    $ codex [options] <prompt>
    $ codex completion <bash|zsh|fish>

  Options
    -h, --help                      Show usage and exit
    -m, --model <model>             Model to use for completions (default: o4-mini)
    -i, --image <path>              Path(s) to image files to include as input
    -v, --view <rollout>            Inspect a previously saved rollout instead of starting a session
    -q, --quiet                     Non-interactive mode that only prints the assistant's final output
    -c, --config                    Open the instructions file in your editor
    -w, --writable-root <path>      Writable folder for sandbox in full-auto mode (can be specified multiple times)
    -a, --approval-mode <mode>      Override the approval policy: 'suggest', 'auto-edit', or 'full-auto'

    --auto-edit                Automatically approve file edits; still prompt for commands
    --full-auto                Automatically approve edits and commands when executed in the sandbox

    --no-project-doc           Do not automatically include the repository's 'codex.md'
    --project-doc <file>       Include an additional markdown file at <file> as context
    --full-stdout              Do not truncate stdout/stderr from command outputs
    --notify                   Enable desktop notifications for responses

    --flex-mode               Use "flex-mode" processing mode for the request (only supported
                              with models o3 and o4-mini)

    --multi-agent             Enable multi-agent mode which uses multiple specialized agents
                              with different models for different tasks.
    --architect-model <model> Specify model to use for the architect agent
    --coder-model <model>     Specify model to use for the coder agent
    --disable-architect       Disable the architect agent
    --disable-coder           Disable the coder agent
    --disable-tester          Disable the tester agent
    --disable-reviewer        Disable the reviewer agent

  Dangerous options
    --dangerously-auto-approve-everything
                               Skip all confirmation prompts and execute commands without
                               sandboxing. Intended solely for ephemeral local testing.

  Experimental options
    -f, --full-context         Launch in "full-context" mode which loads the entire repository
                               into context and applies a batch of edits in one go. Incompatible
                               with all other flags, except for --model.

  Examples
    $ codex "Write and run a python program that prints ASCII art"
    $ codex -q "fix build issues"
    $ codex completion bash
`,
  {
    importMeta: import.meta,
    autoHelp: true,
    flags: {
      // misc
      help: { type: "boolean", aliases: ["h"] },
      view: { type: "string" },
      model: { type: "string", aliases: ["m"] },
      image: { type: "string", isMultiple: true, aliases: ["i"] },
      quiet: {
        type: "boolean",
        aliases: ["q"],
        description: "Non-interactive quiet mode",
      },
      config: {
        type: "boolean",
        aliases: ["c"],
        description: "Open the instructions file in your editor",
      },
      dangerouslyAutoApproveEverything: {
        type: "boolean",
        description:
          "Automatically approve all commands without prompting. This is EXTREMELY DANGEROUS and should only be used in trusted environments.",
      },
      autoEdit: {
        type: "boolean",
        description: "Automatically approve edits; prompt for commands.",
      },
      fullAuto: {
        type: "boolean",
        description:
          "Automatically run commands in a sandbox; only prompt for failures.",
      },
      approvalMode: {
        type: "string",
        aliases: ["a"],
        description:
          "Determine the approval mode for Codex (default: suggest) Values: suggest, auto-edit, full-auto",
      },
      writableRoot: {
        type: "string",
        isMultiple: true,
        aliases: ["w"],
        description:
          "Writable folder for sandbox in full-auto mode (can be specified multiple times)",
      },
      noProjectDoc: {
        type: "boolean",
        description: "Disable automatic inclusion of project‑level codex.md",
      },
      projectDoc: {
        type: "string",
        description: "Path to a markdown file to include as project doc",
      },
      flexMode: {
        type: "boolean",
        description:
          "Enable the flex-mode service tier (only supported by models o3 and o4-mini)",
      },
      multiAgent: {
        type: "boolean", 
        description:
          "Enable multi-agent mode which uses multiple specialized agents with different models",
      },
      architectModel: {
        type: "string",
        description: "Model to use for the architect agent",
      },
      coderModel: {
        type: "string", 
        description: "Model to use for the coder agent",
      },
      testerModel: {
        type: "string",
        description: "Model to use for the tester agent", 
      },
      reviewerModel: {
        type: "string",
        description: "Model to use for the reviewer agent",
      },
      disableArchitect: {
        type: "boolean",
        description: "Disable the architect agent", 
      },
      disableCoder: {
        type: "boolean",
        description: "Disable the coder agent",
      },
      disableTester: {
        type: "boolean", 
        description: "Disable the tester agent",
      },
      disableReviewer: {
        type: "boolean",
        description: "Disable the reviewer agent",
      },
      fullStdout: {
        type: "boolean",
        description:
          "Disable truncation of command stdout/stderr messages (show everything)",
        aliases: ["no-truncate"],
      },
      // Notification
      notify: {
        type: "boolean",
        description: "Enable desktop notifications for responses",
      },

      // Experimental mode where whole directory is loaded in context and model is requested
      // to make code edits in a single pass.
      fullContext: {
        type: "boolean",
        aliases: ["f"],
        description: `Run in full-context editing approach. The model is given the whole code
          directory as context and performs changes in one go without acting.`,
      },
    },
  },
);

// Handle 'completion' subcommand before any prompting or API calls
if (cli.input[0] === "completion") {
  const shell = cli.input[1] || "bash";
  const scripts: Record<string, string> = {
    bash: `# bash completion for codex
_codex_completion() {
  local cur
  cur="\${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=( $(compgen -o default -o filenames -- "\${cur}") )
}
complete -F _codex_completion codex`,
    zsh: `# zsh completion for codex
#compdef codex

_codex() {
  _arguments '*:filename:_files'
}
_codex`,
    fish: `# fish completion for codex
complete -c codex -a '(_fish_complete_path)' -d 'file path'`,
  };
  const script = scripts[shell];
  if (!script) {
    // eslint-disable-next-line no-console
    console.error(`Unsupported shell: ${shell}`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(script);
  process.exit(0);
}
// Show help if requested
if (cli.flags.help) {
  cli.showHelp();
}

// Handle config flag: open instructions file in editor and exit
if (cli.flags.config) {
  // Ensure configuration and instructions file exist
  try {
    loadConfig();
  } catch {
    // ignore errors
  }
  const filePath = INSTRUCTIONS_FILEPATH;
  const editor =
    process.env["EDITOR"] || (process.platform === "win32" ? "notepad" : "vi");
  spawnSync(editor, [filePath], { stdio: "inherit" });
  process.exit(0);
}

// ---------------------------------------------------------------------------
// API key handling
// ---------------------------------------------------------------------------

const apiKey = process.env["OPENAI_API_KEY"];

if (!apiKey) {
  // eslint-disable-next-line no-console
  console.error(
    `\n${chalk.red("Missing OpenAI API key.")}\n\n` +
      `Set the environment variable ${chalk.bold("OPENAI_API_KEY")} ` +
      `and re-run this command.\n` +
      `You can create a key here: ${chalk.bold(
        chalk.underline("https://platform.openai.com/account/api-keys"),
      )}\n`,
  );
  process.exit(1);
}

const fullContextMode = Boolean(cli.flags.fullContext);
let config = loadConfig(undefined, undefined, {
  cwd: process.cwd(),
  disableProjectDoc: Boolean(cli.flags.noProjectDoc),
  projectDocPath: cli.flags.projectDoc as string | undefined,
  isFullContext: fullContextMode,
});

const prompt = cli.input[0];
const model = cli.flags.model;
const imagePaths = cli.flags.image as Array<string> | undefined;

config = {
  apiKey,
  ...config,
  model: model ?? config.model,
  flexMode: Boolean(cli.flags.flexMode),
  notify: Boolean(cli.flags.notify),
};

// Handle multi-agent mode configuration
const multiAgentEnabled = Boolean(cli.flags.multiAgent);
if (multiAgentEnabled || (config.multiAgent && config.multiAgent.enabled)) {
  // Initialize multi-agent config if not present
  if (!config.multiAgent) {
    config.multiAgent = {
      enabled: true,
      models: {},
      enabledRoles: {
        orchestrator: true,
        architect: true,
        coder: true,
        tester: true,
        reviewer: true
      }
    };
  } else {
    // Ensure it's enabled if the flag is set
    config.multiAgent.enabled = true;
  }
  
  // Override models from CLI flags
  if (cli.flags.architectModel) {
    config.multiAgent.models.architect = String(cli.flags.architectModel);
  }
  if (cli.flags.coderModel) {
    config.multiAgent.models.coder = String(cli.flags.coderModel);
  }
  if (cli.flags.testerModel) {
    config.multiAgent.models.tester = String(cli.flags.testerModel);
  }
  if (cli.flags.reviewerModel) {
    config.multiAgent.models.reviewer = String(cli.flags.reviewerModel);
  }
  
  // Handle agent disabling
  if (cli.flags.disableArchitect) {
    config.multiAgent.enabledRoles.architect = false;
  }
  if (cli.flags.disableCoder) {
    config.multiAgent.enabledRoles.coder = false;
  }
  if (cli.flags.disableTester) {
    config.multiAgent.enabledRoles.tester = false;
  }
  if (cli.flags.disableReviewer) {
    config.multiAgent.enabledRoles.reviewer = false;
  }
}

// Check for updates after loading config
// This is important because we write state file in the config dir
await checkForUpdates().catch();
// ---------------------------------------------------------------------------
// --flex-mode validation (only allowed for o3 and o4-mini)
// ---------------------------------------------------------------------------

if (cli.flags.flexMode) {
  const allowedFlexModels = new Set(["o3", "o4-mini"]);
  if (!allowedFlexModels.has(config.model)) {
    // eslint-disable-next-line no-console
    console.error(
      `The --flex-mode option is only supported when using the 'o3' or 'o4-mini' models. ` +
        `Current model: '${config.model}'.`,
    );
    process.exit(1);
  }
}

if (!(await isModelSupportedForResponses(config.model))) {
  // eslint-disable-next-line no-console
  console.error(
    `The model "${config.model}" does not appear in the list of models ` +
      `available to your account. Double‑check the spelling (use\n` +
      `  openai models list\n` +
      `to see the full list) or choose another model with the --model flag.`,
  );
  process.exit(1);
}

let rollout: AppRollout | undefined;

if (cli.flags.view) {
  const viewPath = cli.flags.view;
  const absolutePath = path.isAbsolute(viewPath)
    ? viewPath
    : path.join(process.cwd(), viewPath);
  try {
    const content = fs.readFileSync(absolutePath, "utf-8");
    rollout = JSON.parse(content) as AppRollout;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Error reading rollout file:", error);
    process.exit(1);
  }
}

// If we are running in --fullcontext mode, do that and exit.
if (fullContextMode) {
  await runSinglePass({
    originalPrompt: prompt,
    config,
    rootPath: process.cwd(),
  });
  onExit();
  process.exit(0);
}

// For multi-agent mode, we don't need to exit early - it's integrated into terminal-chat

// Ensure that all values in additionalWritableRoots are absolute paths.
const additionalWritableRoots: ReadonlyArray<string> = (
  cli.flags.writableRoot ?? []
).map((p) => path.resolve(p));

// If we are running in --quiet mode, do that and exit.
const quietMode = Boolean(cli.flags.quiet);
const fullStdout = Boolean(cli.flags.fullStdout);

if (quietMode) {
  process.env["CODEX_QUIET_MODE"] = "1";
  if (!prompt || prompt.trim() === "") {
    // eslint-disable-next-line no-console
    console.error(
      'Quiet mode requires a prompt string, e.g.,: codex -q "Fix bug #123 in the foobar project"',
    );
    process.exit(1);
  }

  // Determine approval policy for quiet mode based on flags
  const quietApprovalPolicy: ApprovalPolicy =
    cli.flags.fullAuto || cli.flags.approvalMode === "full-auto"
      ? AutoApprovalMode.FULL_AUTO
      : cli.flags.autoEdit || cli.flags.approvalMode === "auto-edit"
      ? AutoApprovalMode.AUTO_EDIT
      : config.approvalMode || AutoApprovalMode.SUGGEST;

  await runQuietMode({
    prompt: prompt as string,
    imagePaths: imagePaths || [],
    approvalPolicy: quietApprovalPolicy,
    additionalWritableRoots,
    config,
  });
  onExit();
  process.exit(0);
}

// Default to the "suggest" policy.
// Determine the approval policy to use in interactive mode.
//
// Priority (highest → lowest):
// 1. --fullAuto – run everything automatically in a sandbox.
// 2. --dangerouslyAutoApproveEverything – run everything **without** a sandbox
//    or prompts.  This is intended for completely trusted environments.  Since
//    it is more dangerous than --fullAuto we deliberately give it lower
//    priority so a user specifying both flags still gets the safer behaviour.
// 3. --autoEdit – automatically approve edits, but prompt for commands.
// 4. config.approvalMode - use the approvalMode setting from ~/.codex/config.json.
// 5. Default – suggest mode (prompt for everything).

const approvalPolicy: ApprovalPolicy =
  cli.flags.fullAuto || cli.flags.approvalMode === "full-auto"
    ? AutoApprovalMode.FULL_AUTO
    : cli.flags.autoEdit || cli.flags.approvalMode === "auto-edit"
    ? AutoApprovalMode.AUTO_EDIT
    : config.approvalMode || AutoApprovalMode.SUGGEST;

preloadModels();

const instance = render(
  <App
    prompt={prompt}
    config={config}
    rollout={rollout}
    imagePaths={imagePaths}
    approvalPolicy={approvalPolicy}
    additionalWritableRoots={additionalWritableRoots}
    fullStdout={fullStdout}
  />,
  {
    patchConsole: process.env["DEBUG"] ? false : true,
  },
);
setInkRenderer(instance);

function formatResponseItemForQuietMode(item: ResponseItem): string {
  if (!PRETTY_PRINT) {
    return JSON.stringify(item);
  }
  switch (item.type) {
    case "message": {
      const role = item.role === "assistant" ? "assistant" : item.role;
      const txt = item.content
        .map((c) => {
          if (c.type === "output_text" || c.type === "input_text") {
            return c.text;
          }
          if (c.type === "input_image") {
            return "<Image>";
          }
          if (c.type === "input_file") {
            return c.filename;
          }
          if (c.type === "refusal") {
            return c.refusal;
          }
          return "?";
        })
        .join(" ");
      return `${role}: ${txt}`;
    }
    case "function_call": {
      const details = parseToolCall(item);
      return `$ ${details?.cmdReadableText ?? item.name}`;
    }
    case "function_call_output": {
      // @ts-expect-error metadata unknown on ResponseFunctionToolCallOutputItem
      const meta = item.metadata as ExecOutputMetadata;
      const parts: Array<string> = [];
      if (typeof meta?.exit_code === "number") {
        parts.push(`code: ${meta.exit_code}`);
      }
      if (typeof meta?.duration_seconds === "number") {
        parts.push(`duration: ${meta.duration_seconds}s`);
      }
      const header = parts.length > 0 ? ` (${parts.join(", ")})` : "";
      return `command.stdout${header}\n${item.output}`;
    }
    default: {
      return JSON.stringify(item);
    }
  }
}

async function runQuietMode({
  prompt,
  imagePaths,
  approvalPolicy,
  additionalWritableRoots,
  config,
}: {
  prompt: string;
  imagePaths: Array<string>;
  approvalPolicy: ApprovalPolicy;
  additionalWritableRoots: ReadonlyArray<string>;
  config: AppConfig;
}): Promise<void> {
  const agent = new AgentLoop({
    model: config.model,
    config: config,
    instructions: config.instructions,
    approvalPolicy,
    additionalWritableRoots,
    onItem: (item: ResponseItem) => {
      // eslint-disable-next-line no-console
      console.log(formatResponseItemForQuietMode(item));
    },
    onLoading: () => {
      /* intentionally ignored in quiet mode */
    },
    getCommandConfirmation: (
      _command: Array<string>,
    ): Promise<CommandConfirmation> => {
      // In quiet mode, default to NO_CONTINUE, except when in full-auto mode
      const reviewDecision =
        approvalPolicy === AutoApprovalMode.FULL_AUTO
          ? ReviewDecision.YES
          : ReviewDecision.NO_CONTINUE;
      return Promise.resolve({ review: reviewDecision });
    },
    onLastResponseId: () => {
      /* intentionally ignored in quiet mode */
    },
  });

  const inputItem = await createInputItem(prompt, imagePaths);
  await agent.run([inputItem]);
}

const exit = () => {
  onExit();
  process.exit(0);
};

process.on("SIGINT", exit);
process.on("SIGQUIT", exit);
process.on("SIGTERM", exit);

// ---------------------------------------------------------------------------
// Fallback for Ctrl‑C when stdin is in raw‑mode
// ---------------------------------------------------------------------------

if (process.stdin.isTTY) {
  // Ensure we do not leave the terminal in raw mode if the user presses
  // Ctrl‑C while some other component has focus and Ink is intercepting
  // input. Node does *not* emit a SIGINT in raw‑mode, so we listen for the
  // corresponding byte (0x03) ourselves and trigger a graceful shutdown.
  const onRawData = (data: Buffer | string): void => {
    const str = Buffer.isBuffer(data) ? data.toString("utf8") : data;
    if (str === "\u0003") {
      exit();
    }
  };
  process.stdin.on("data", onRawData);
}

// Ensure terminal clean‑up always runs, even when other code calls
// `process.exit()` directly.
process.once("exit", onExit);
