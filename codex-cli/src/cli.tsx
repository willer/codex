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
import { runSinglePass } from "./cli_singlepass";
import { AgentLoop } from "./utils/agent/agent-loop";
import { initLogger } from "./utils/agent/log";
import { ReviewDecision } from "./utils/agent/review";
import { AutoApprovalMode } from "./utils/auto-approval-mode";
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
    -h, --help                 Show usage and exit
    -m, --model <model>        Model to use for completions (default: o4-mini)
    -i, --image <path>         Path(s) to image files to include as input
    -v, --view <rollout>       Inspect a previously saved rollout instead of starting a session
    -q, --quiet                Non-interactive mode that only prints the assistant's final output
    -c, --config               Open the instructions file in your editor
    -a, --approval-mode <mode> Override the approval policy: 'suggest', 'auto-edit', or 'full-auto'

    --auto-edit                Automatically approve file edits; still prompt for commands
    --full-auto                Automatically approve edits and commands when executed in the sandbox

    --no-project-doc           Do not automatically include the repository's 'codex.md'
    --project-doc <file>       Include an additional markdown file at <file> as context
    --full-stdout              Do not truncate stdout/stderr from command outputs

  Dangerous options
    --dangerously-auto-approve-everything
                               Skip all confirmation prompts and execute commands without
                               sandboxing. Intended solely for ephemeral local testing.

  Experimental options
    -f, --full-context         Launch in "full-context" mode which loads the entire repository
                               into context and applies a batch of edits in one go. Incompatible
                               with all other flags, except for --model.
    
    --two-agent                Use the two-agent architecture with separate Architect and Coder
                               models for improved cost efficiency and determinism.

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
      noProjectDoc: {
        type: "boolean",
        description: "Disable automatic inclusion of project‑level codex.md",
      },
      projectDoc: {
        type: "string",
        description: "Path to a markdown file to include as project doc",
      },
      fullStdout: {
        type: "boolean",
        description:
          "Disable truncation of command stdout/stderr messages (show everything)",
        aliases: ["no-truncate"],
      },

      // Experimental mode where whole directory is loaded in context and model is requested
      // to make code edits in a single pass.
      fullContext: {
        type: "boolean",
        aliases: ["f"],
        description: `Run in full-context editing approach. The model is given the whole code
          directory as context and performs changes in one go without acting.`,
      },
      
      // Two-agent mode with Architect and Coder
      twoAgent: {
        type: "boolean", 
        description: "Use the two-agent architecture with separate Architect and Coder models",
        negatable: true, // allows --no-two-agent to disable it
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
const twoAgentMode = Boolean(cli.flags.twoAgent);
// Load the configuration from file
let config = loadConfig(undefined, undefined, {
  cwd: process.cwd(),
  disableProjectDoc: Boolean(cli.flags.noProjectDoc),
  projectDocPath: cli.flags.projectDoc as string | undefined,
  isFullContext: fullContextMode,
});

// IMPORTANT: Make a deep copy to preserve the original values from loadConfig
const originalConfig = { ...config };

// Debug logging removed

// Parse command line arguments
const prompt = cli.input[0];
const model = cli.flags.model;
const imagePaths = cli.flags.image as Array<string> | undefined;
const modelExplicitlySet = model !== undefined;

// No debug statements in production code

// Important: Check if the --no-two-agent flag was actually passed on the command line
const rawArgs = process.argv.slice(2);
const noTwoAgentExplicitlyPassed = rawArgs.includes("--no-two-agent");
const twoAgentExplicitlyPassed = rawArgs.includes("--two-agent");

// Careful detection of explicit flags
// ONLY consider explicitly passed flags, not default values from meow
const twoAgentExplicitlyEnabled = twoAgentExplicitlyPassed;
const twoAgentExplicitlyDisabled = noTwoAgentExplicitlyPassed;

// Apply configuration logic based on command line flags
// 1. If explicit model is provided, disable two-agent mode
if (modelExplicitlySet) {
  config = {
    ...config,
    model: model as string,
    architectModel: undefined,
    coderModel: undefined,
    twoAgent: false
  };
} 
// 2. Handle explicit two-agent flags
else if (twoAgentExplicitlyEnabled) {
  config.twoAgent = true;
} 
else if (twoAgentExplicitlyDisabled) {
  config.twoAgent = false;
}
// 3. No flags specified - use value from config file (already set by loadConfig)
else {
  // Explicitly set to the original value from loadConfig
  config.twoAgent = originalConfig.twoAgent;
}

// Debug logging removed

// Add API key to config
config = {
  ...config,
  apiKey
};

// This safety check is no longer needed since we check raw command line args

// Debug logging removed

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

// If we are running in --quiet mode, do that and exit.
const quietMode = Boolean(cli.flags.quiet);
const autoApproveEverything = Boolean(
  cli.flags.dangerouslyAutoApproveEverything,
);
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
  await runQuietMode({
    prompt: prompt as string,
    imagePaths: imagePaths || [],
    approvalPolicy: autoApproveEverything
      ? AutoApprovalMode.FULL_AUTO
      : AutoApprovalMode.SUGGEST,
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
// 4. Default – suggest mode (prompt for everything).

const approvalPolicy: ApprovalPolicy =
  cli.flags.fullAuto || cli.flags.approvalMode === "full-auto"
    ? AutoApprovalMode.FULL_AUTO
    : cli.flags.autoEdit || cli.flags.approvalMode === "auto-edit"
    ? AutoApprovalMode.AUTO_EDIT
    : AutoApprovalMode.SUGGEST;

preloadModels();

const instance = render(
  <App
    prompt={prompt}
    config={config}
    rollout={rollout}
    imagePaths={imagePaths}
    approvalPolicy={approvalPolicy}
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
  config,
}: {
  prompt: string;
  imagePaths: Array<string>;
  approvalPolicy: ApprovalPolicy;
  config: AppConfig;
}): Promise<void> {
  const inputItem = await createInputItem(prompt, imagePaths);
  
  // Use two-agent mode if enabled
  if (config.twoAgent) {
    // Import here to avoid circular dependencies
    const { Orchestrator } = await import("./utils/agent/orchestrator.js");
    
    const orchestrator = new Orchestrator({
      config,
      approvalPolicy,
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
        return Promise.resolve({ review: ReviewDecision.NO_CONTINUE });
      },
      onLastResponseId: () => {
        /* intentionally ignored in quiet mode */
      },
    });
    
    await orchestrator.run([inputItem]);
    return;
  }
  
  // Default single-agent mode
  const agent = new AgentLoop({
    model: config.model,
    config: config,
    instructions: config.instructions,
    approvalPolicy,
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
      return Promise.resolve({ review: ReviewDecision.NO_CONTINUE });
    },
    onLastResponseId: () => {
      /* intentionally ignored in quiet mode */
    },
  });

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
