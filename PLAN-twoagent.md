# Two–Agent Architecture Plan for Codex‑CLI

This document outlines how to evolve the current single‑agent Codex‑CLI into a
**two‑stage “Architect / Coder” pipeline**.  The goals are to (1) reduce cost by
delegating most code‑generation turns to a smaller model, (2) increase
determinism by separating planning from patching, and (3) provide clearer
traceability of **why** each diff was produced.

The plan is intentionally *implementation‑focused*; no calendar estimates are
attached.

-------------------------------------------------------------------------------
## 1  High‑Level Design

1. The **Architect / Checker** model (o3 — *≈5× the cost of o4‑mini*) is only
   invoked at three strategic moments per user turn:
     a. **Planning** – translates the natural‑language request plus repo context
      into a structured **Change Plan**.
     b. **Mid‑flight Re‑plan** – *only* if the cheap model reports an
      unrecoverable failure.
     c. **Final Verification** – audits the completed diff & test log to ensure
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
## 2  Key Components & Files

| Area | New/Updated Files | Notes |
|------|-------------------|-------|
| **Prompts** | `prompts/architect.md`, `prompts/coder.md` | System & user prompts for each role. |
| **Schema** | `src/utils/agent/change_plan.ts` | TS types + zod validation for Architect output. |
| **Orchestrator** | `src/utils/agent/orchestrator.ts` | Finite‑state machine controlling the loop. |
| **Model Wrappers** | `src/utils/agent/models.ts` | Helper to call OpenAI with role‑specific defaults. |
| **Context Builder** | `src/utils/agent/context.ts` | Generates per‑role context slices, summaries, etc. |
| **CLI Wiring** | `cli.tsx`, `cli_singlepass.tsx` | Gate behind `--two-agent` flag; preserve legacy path. |
| **Config** | `codex.toml` additions | `architect_model`, `coder_model`, `coder_max_context`. |
| **Tests** | `tests/two_agent/*.test.ts` | Unit tests for plan validation, orchestrator logic. |

-------------------------------------------------------------------------------
## 3  Change Plan JSON Schema (draft)

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
## 4  Prompt Engineering

Architect prompt essentials:
* Receives: user message, repo overview, recent diff summary, known test
  failures.
* Must **output only JSON** that conforms to the schema.

Coder prompt essentials:
* Receives: single action object (`edit`), full contents of target file, any
  hints from Architect.
* Must output an RFC‑8259 compliant apply_patch diff.

Include “You are only allowed to touch the specified file” instruction to
prevent cross‑file hallucinations.

-------------------------------------------------------------------------------
## 5  Orchestrator State Machine (pseudo‑code)

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
## 6  Context Management & Summarization

Why: keep Coder within o4‑mini’s token window.  Although o4‑mini is cheaper
than o3, flooding it with full‑repo context still wastes tokens and latency.

Strategy:
1. Give Coder **only** the file contents + action + per‑file rolling summary.
2. Maintain a `summaries.json` mapping file → short natural‑language summary.
   Update it using the diff hunk plus `openai_model=summarizer` (optional).
3. Store summaries in `.codex/cache/` so reruns are instant.

-------------------------------------------------------------------------------
## 7  Failure & Recovery Logic

* **Coder patch fails to apply** → retry **max 2 times** (first with raw file,
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
## 8  Configuration Surface

Add to existing `config.ts` loader:

```toml
two_agent      = true            # opt‑in
architect_model = "o3"
coder_model     = "o4-mini"
coder_temp      = 0.2
```

CLI flag `--two-agent` overrides config file.

-------------------------------------------------------------------------------
## 9  Telemetry & Cost Tracking

* Record tokens, latency, cost per model call.
* JSONL log per session: `{ ts, role, model, tokens_in, tokens_out, cost_usd }`.
* Surface a **cost‑savings report** at the end of the session that compares the
  actual spend against a hypothetical “all‑o3” baseline.  This makes the
  5× difference between o3 and o4‑mini tangible.

-------------------------------------------------------------------------------
## 10  Security Considerations

* Coder never sees secrets hidden by the sandbox.
* Architect sees full repo; ensure redact secrets if necessary.
* Limit `command` actions to a whitelist (`npm test`, `pytest`, etc.).

-------------------------------------------------------------------------------
## 11  Testing Strategy

1. Unit test orchestrator transitions w/ mocked Architect & Coder.
2. Contract tests: feed canned Architect plan → expect exact Coder diff.
3. Integration test against a toy repo (see `tests/fixtures/twoagent-project`).
4. Regression: ensure legacy single‑agent flow remains identical when
   `two_agent=false`.

-------------------------------------------------------------------------------
## 12  Rollout / Migration Steps (functional)

1. Land schema & dummy orchestrator behind feature flag.
2. Wire prompts + model wrappers.
3. Enable basic happy‑path flow (edit + test pass).
4. Harden with retries, summaries, telemetry.
5. Mark feature as stable and flip default.

-------------------------------------------------------------------------------
## 13  Non‑Goals for Phase 1

* Automatic prompt summarization for very large monorepos.
* Fine‑grained cost optimisation across different OpenAI regions.
* Multi‑coder parallelism (out of scope until thread‑safety is proven).

-------------------------------------------------------------------------------
## 14  Open Questions

1. Do we allow the Architect to specify *new* files, or restrict to edits only?
2. Should `command` support arbitrary shell or a curated set of “runners”?
3. Where to persist partial session state if CLI crashes mid‑plan?

-------------------------------------------------------------------------------
## 15  Future Evolution: n-Agent Architecture & Task() Tool Integration

Evolve from two-agent to an n-agent architecture with a flexible system inspired by Claude Code's Task() tool:

```typescript
// Conceptual API:
Task(role: string, instruction: string, options?: TaskOptions): TaskResult;
```

### 15.1 From Two-Agent to n-Agent

The current implementation already has three distinct personas:
- **Orchestrator**: Manages the workflow and coordinates between agents
- **Architect**: Plans the changes to be implemented
- **Coder**: Implements individual components of the plan

Extending to an n-agent system would add roles such as:
- **Verifier**: Performs comprehensive testing and validation of changes
- **Reviewer**: Conducts code reviews with quality and style focus
- **DevOps**: Handles deployment, infrastructure, and operational tasks
- **Security**: Performs security analysis on code changes
- **Data Scientist**: Specializes in data analysis and ML implementations

### 15.2 Model and Role Separation

The n-agent approach recognizes that:
1. One model can play multiple roles (e.g., GPT-4 could be both Architect and Reviewer)
2. Different roles need different contexts and instructions
3. The Orchestrator maintains process control regardless of how many roles exist

### 15.3 Key Enhancements

1. **Flexible Role System**: Define multiple specialized personas with distinct capabilities
2. **Nested Tasks**: Allow agents to spawn sub-tasks handled by specialized agents
3. **Full Tool Access**: Agents invoked via Task() can use the full range of tools:
   - File operations (read/write/edit)
   - Shell commands (controlled by the same security policies)
   - Searches and analyses
4. **Role-Specific Contexts**: Each role gets precisely the context it needs

### 15.4 Benefits

- **Composition**: Complex workflows can be broken down into specialized sub-tasks
- **Expertise**: Delegate to agents with appropriate context/specialization
- **Efficiency**: Right-size model for each aspect of the task
- **Independence**: Let sub-agents work with clear, focused objectives
- **Adaptability**: Pipeline can be customized for different types of projects

### 15.5 Implementation Approach

1. Start with current two-agent pipeline as the foundation
2. Abstract into a general Task() API that maintains same orchestration patterns
3. Create a registry of available roles with their specific prompts and context builders
4. Add robust context passing between parent and child tasks
5. Implement a permission system to control which roles can access which tools

-------------------------------------------------------------------------------
*End of file*
