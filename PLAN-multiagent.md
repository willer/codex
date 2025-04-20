# Multi–Agent Architecture Plan for Codex‑CLI

This document outlines how to evolve the current single‑agent Codex‑CLI into a
**multi‑stage "Architect / Coder" pipeline**.  The goals are to (1) reduce cost by
delegating most code‑generation turns to a smaller model, (2) increase
determinism by separating planning from patching, and (3) provide clearer
traceability of **why** each diff was produced.

The plan is intentionally *implementation‑focused*; no calendar estimates are
attached.

-------------------------------------------------------------------------------
## 1  High‑Level Design

1. The **Architect / Checker** model (o3 — *≈5× the cost of o4‑mini*) is only
   invoked at three strategic moments per user turn:
     a. **Planning** – translates the natural‑language request plus repo context
      into a structured **Change Plan**.
     b. **Mid‑flight Re‑plan** – *only* if the cheap model reports an
      unrecoverable failure.
     c. **Final Verification** – audits the completed diff & test log to ensure
      it meets the original intent and global rules.*

2. The **Orchestrator** (local Node/TS code in Codex‑CLI):
     a. Validates the Architect plan.
     b. Streams each `edit`/`command` item to the **Coder** model (o4‑mini).
     c. Applies patches, runs fast health‑checks, and decides whether to
      continue, self‑heal (retry), or escalate back to o3.

3. The **Coder** model (o4‑mini, cheap) receives *one* atomic action at a time
   with a **minimal context slice** (usually the target file + hints) and
   returns an `apply_patch` diff or command output.

This design amortises the expensive o3 calls across many cheap o4‑mini
iterations while still ensuring a high‑quality end‑state that is formally
signed‑off by o3.

-------------------------------------------------------------------------------
## 2  Key Components & Files

| Area | New/Updated Files | Notes |
|------|-------------------|-------|
| **Prompts** | `prompts/architect.md`, `prompts/coder.md` | System & user prompts for each role. |
| **Schema** | `src/utils/agent/change_plan.ts` | TS types + zod validation for Architect output. |
| **Orchestrator** | `src/utils/agent/orchestrator.ts` | Finite‑state machine controlling the loop. |
| **Model Wrappers** | `src/utils/agent/models.ts` | Helper to call OpenAI with role‑specific defaults. |
| **Context Builder** | `src/utils/agent/context.ts` | Generates per‑role context slices, summaries, etc. |
| **CLI Wiring** | `cli.tsx`, `cli_singlepass.tsx` | Gate behind `--multi-agent` flag; preserve legacy path. |
| **Config** | `codex.toml` additions | `architect_model`, `coder_model`, `coder_max_context`. |
| **Tests** | `tests/multi_agent/*.test.ts` | Unit tests for plan validation, orchestrator logic. |

-------------------------------------------------------------------------------
## 3  Change Plan JSON Schema (draft)

```jsonc
// Top‑level object returned by Architect
{
  "actions": [
    {
      "kind": "edit",          // or "command" or "message"
      "file": "src/foo.ts",    // required for kind == edit
      "description": "Add foo() helper to reuse logic",
      "hints": "Implement with recursion; keep exports stable"
    },
    {
      "kind": "command",
      "cmd": "npm test -- src/foo.spec.ts",
      "expect": "pass"          // optional hint to orchestrator
    }
  ]
}
```

Validation: Use `zod` to keep runtime overhead minimal and error messages clear.

-------------------------------------------------------------------------------
## 4  Prompt Engineering

Architect prompt essentials:
* Receives: user message, repo overview, recent diff summary, known test
  failures.
* Must **output only JSON** that conforms to the schema.

Coder prompt essentials:
* Receives: single action object (`edit`), full contents of target file, any
  hints from Architect.
* Must output an RFC‑8259 compliant apply_patch diff.

Include "You are only allowed to touch the specified file" instruction to
prevent cross‑file hallucinations.

-------------------------------------------------------------------------------
## 5  Orchestrator State Machine (pseudo‑code)

```
START → ARCHITECT_CALL → VALIDATE_PLAN →
  for action in plan.actions:
      if action.kind == 'edit':
          patch = coder_call(action)
          apply_patch(patch)
      elif action.kind == 'command':
          exec(action.cmd)
      # after each step: run health_checks()
      if health_checks_fail:
          send_failure_to(coder or architect)
          maybe_replan()
DONE
```

Health checks = unit tests, type‑checks, prettier/ESLint, etc.  Fast ones run
every step; slow ones after the entire plan.

-------------------------------------------------------------------------------
## 6  Context Management & Summarization

Why: keep Coder within o4‑mini's token window.  Although o4‑mini is cheaper
than o3, flooding it with full‑repo context still wastes tokens and latency.

Strategy:
1. Give Coder **only** the file contents + action + per‑file rolling summary.
2. Use **lazy loading** approach - only fetch file contents when an agent explicitly needs them
3. Let each agent make its own tool calls (View, Glob, etc.) rather than preloading context
4. Maintain a `summaries.json` mapping file → short natural‑language summary to avoid redundant fetches
5. Store summaries in `.codex/cache/` so reruns are instant.

Key principle: No file access until explicitly needed by a task. For simple conversational queries like "how are you", repository context should be skipped entirely.

-------------------------------------------------------------------------------
## 7  Failure & Recovery Logic

* **Coder patch fails to apply** → retry **max 2 times** (first with raw file,
  second with Git reject hunks context).  Escalate to Architect/Checker only if
  both retries fail.
* **Tests fail**:
  - If the stack‑trace is localised to the edited file(s), give Coder one
    self‑healing attempt using the failure log as additional context.
  - Escalate to Architect/Checker if the failure spans multiple untouched
    files or persists after the retry.
* **Architect JSON invalid** → call Architect again with validation error
  message prepended.

-------------------------------------------------------------------------------
## 8  Configuration Surface

Add to existing `config.ts` loader:

```toml
multi_agent    = true            # opt‑in
architect_model = "o3"
coder_model     = "o4-mini"
coder_temp      = 0.2
```

CLI flag `--multi-agent` overrides config file.

-------------------------------------------------------------------------------
## 9  Telemetry & Cost Tracking

* Record tokens, latency, cost per model call.
* JSONL log per session: `{ ts, role, model, tokens_in, tokens_out, cost_usd }`.
* Surface a **cost‑savings report** at the end of the session that compares the
  actual spend against a hypothetical "all‑o3" baseline.  This makes the
  5× difference between o3 and o4‑mini tangible.

-------------------------------------------------------------------------------
## 10  Security Considerations

* Coder never sees secrets hidden by the sandbox.
* Architect sees full repo; ensure redact secrets if necessary.
* Limit `command` actions to a whitelist (`npm test`, `pytest`, etc.).

-------------------------------------------------------------------------------
## 11  Testing Strategy

1. Unit test orchestrator transitions w/ mocked Architect & Coder.
2. Contract tests: feed canned Architect plan → expect exact Coder diff.
3. Integration test against a toy repo (see `tests/fixtures/multiagent-project`).
4. Regression: ensure legacy single‑agent flow remains identical when
   `multi_agent=false`.

-------------------------------------------------------------------------------
## 12  Rollout / Migration Steps (functional)

1. Land schema & dummy orchestrator behind feature flag.
2. Wire prompts + model wrappers.
3. Enable basic happy‑path flow (edit + test pass).
4. Harden with retries, summaries, telemetry.
5. Mark feature as stable and flip default.

-------------------------------------------------------------------------------
## 13  Non‑Goals for Phase 1

* Automatic prompt summarization for very large monorepos.
* Fine‑grained cost optimisation across different OpenAI regions.
* Multi‑coder parallelism (out of scope until thread‑safety is proven).

-------------------------------------------------------------------------------
## 14  Open Questions

1. Do we allow the Architect to specify *new* files, or restrict to edits only?
2. Should `command` support arbitrary shell or a curated set of "runners"?
3. Where to persist partial session state if CLI crashes mid‑plan?

-------------------------------------------------------------------------------
## 15  Multi-Agent Architecture Implementation

We are evolving the current implementation to a true multi-agent architecture with AI-driven orchestration:

### 15.1 True Multi-Agent System

In this redesigned architecture, we shift from our initial "two-agent mode" to a true multi-agent system where:

1. **All agents are AI-driven roles**, including the Orchestrator
2. **Every interaction flows through the Orchestrator first**
3. **Dynamic coordination pattern** with intelligent workflow planning

Core roles in the system:
- **Orchestrator**: First point of contact, processes user input, coordinates workflow (uses o4-mini)
- **Architect**: Plans technical implementation, makes architectural decisions (uses o3)
- **Coder**: Implements specific coding tasks from the plan (uses o4-mini)
- **Tester**: Verifies code changes against requirements (uses o4-mini)
- **Reviewer**: Performs code reviews, ensures alignment with architecture and SDLC (uses o3)

Additional specialist roles can be added as needed (DevOps, Security, Data Scientist, etc.).

### 15.2 Agent Interaction Model

The system supports sophisticated agent interactions:
- **Continue**: Agent completes its task and suggests the next agent to involve
- **Reject**: Agent rejects a task and suggests which agent should handle it instead
- **Question**: Agent can ask questions of other agents to resolve uncertainties
- **Complete**: Agent indicates the overall task is complete

This allows for a flexible workflow that adapts to the specific needs of each task.

### 15.3 Core Components

#### Agent Registry
```typescript
export enum AgentRole {
  ORCHESTRATOR = "orchestrator",
  ARCHITECT = "architect", 
  CODER = "coder",
  TESTER = "tester",
  REVIEWER = "reviewer"
}

export interface AgentConfig {
  role: AgentRole;
  model: string;
  temperature: number;
  promptPath: string;
}

export const defaultAgentConfigs: Record<AgentRole, AgentConfig> = {
  [AgentRole.ORCHESTRATOR]: { 
    role: AgentRole.ORCHESTRATOR, 
    model: "o4-mini", 
    temperature: 0.3,
    promptPath: "prompts/orchestrator.md" 
  },
  // Other agent configs
}
```

#### Agent Interface
```typescript
export interface Agent {
  role: AgentRole;
  process(input: any, context: AgentContext): Promise<AgentResponse>;
}

export interface AgentResponse {
  output: any;
  nextAction: NextAction;
  metadata: Record<string, any>;
}

export type NextAction = 
  | { type: "continue", nextRole?: AgentRole }
  | { type: "reject", reason: string, suggestedRole: AgentRole }
  | { type: "complete", finalOutput: string }
  | { type: "question", question: string, targetRole: AgentRole }
```

#### Workflow Engine
```typescript
export interface WorkflowStep {
  role: AgentRole;
  input: any;
  output?: any;
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
}

export interface WorkflowPlan {
  steps: Array<WorkflowStep>;
  currentStepIndex: number;
  status: "planning" | "executing" | "completed" | "failed";
}
```

### 15.4 Context Management - Lazy Loading Approach

Each role requests only the context it needs, when it needs it:
- **Orchestrator**: Only user history and high-level task info, no repo context unless necessary
- **Architect**: Makes its own tool calls for specific architectural patterns only when needed
- **Coder**: Uses View tool to access only files it needs to modify, not full context
- **Tester**: Accesses only test files and changed code necessary for verification
- **Reviewer**: Only reads files that were changed, not the entire repository

```typescript
export interface AgentContext {
  userInput: string;
  conversationHistory: Array<Message>;
  taskState: TaskState;
  // No pre-loaded repository context - let agents request what they need
  toolProvider: ToolProvider; // Gives agents access to tools like View, Glob, etc.
}

// Each agent gets access to tools, not pre-loaded context
export interface ToolProvider {
  view(file: string): Promise<string>;
  glob(pattern: string): Promise<string[]>;
  grep(pattern: string): Promise<Record<string, string[]>>;
  // Other tools as needed
}
```

Key improvements:
1. No eager loading of repository context - lazy loading only
2. Agents trigger their own tool calls to access files only as needed
3. Simple conversational queries bypass file system access entirely
4. Each agent maintains its own minimal context, reducing token usage
5. Coordinate through shared task state without duplicating file content

### 15.5 Agent Selection Logic

The Orchestrator intelligently determines which agents to involve based on:
1. **Task type analysis**: Questions, implementation tasks, bug fixes, reviews
2. **Complexity assessment**: Simple tasks may skip certain agents
3. **User preferences**: Explicit requests for specific agent involvement
4. **Previous interactions**: Continuation of ongoing conversations

The system supports different workflows for different scenarios:
- Simple questions might involve just the Orchestrator
- Code implementations typically follow Orchestrator → Architect → Coder → Tester → Reviewer
- Bug fixes might go directly from Orchestrator → Coder → Tester

### 15.6 Configuration Surface

```toml
[multi_agent]
enabled = true

[multi_agent.models]
orchestrator = "o4-mini"
architect = "o3"
coder = "o4-mini"
tester = "o4-mini"
reviewer = "o3"

[multi_agent.enabled_roles]
orchestrator = true
architect = true
coder = true
tester = true
reviewer = true
```

CLI support:
```bash
# Enable or disable specific agents
codex --multi-agent --disable-reviewer "Implement a simple feature"

# Override specific agent models
codex --multi-agent --architect-model=o4-mini "Create a web scraper"
```

### 15.7 Implementation Status

✅ 1. **Create agent registry and configuration system**
   - Define agent roles and default configurations
   - Add configuration options to config.ts

✅ 2. **Develop base agent interface and context management**
   - Create agent context structure
   - Implement context slicing for efficient token usage

✅ 3. **Implement workflow engine**
   - Create workflow planning and revision logic
   - Design decision points for agent selection

✅ 4. **Build specialized agent implementations**
   - Implement each agent role with specialized prompts
   - Develop logic for inter-agent communication

✅ 5. **Enhance orchestrator for dynamic workflows**
   - Implement flexible agent selection
   - Add handling for agent interactions (questions, rejections, etc.)

✅ 6. **Add CLI options for multi-agent mode**
   - Add command-line options for agent configuration
   - Support selective agent enabling/disabling

✅ 7. **Create tests for multi-agent components**
   - Unit tests for agent registry
   - Tests for workflow engine
   - Tests for orchestrator

🔄 8. **Add telemetry and performance tracking**
   - Track token usage by agent
   - Calculate cost savings metrics

-------------------------------------------------------------------------------
*End of file*