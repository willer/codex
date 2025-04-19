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
## 15  Future Evolution: Multi-Agent Architecture

Evolve from the current implementation to a true multi-agent architecture with AI-driven orchestration:

### 15.1 True Multi-Agent System

In this redesigned architecture, we shift from our current "two-agent mode" to a true multi-agent system where:

1. **All agents are AI-driven roles**, including the Orchestrator
2. **Every interaction flows through the Orchestrator first**
3. **Fixed coordination pattern** with a single, well-designed workflow

Core roles in the system:
- **Orchestrator**: First point of contact, processes user input, coordinates workflow (uses o4-mini)
- **Architect**: Plans technical implementation, makes architectural decisions (uses o3)
- **Coder**: Implements specific coding tasks from the plan (uses o4-mini)
- **Tester**: Verifies code changes against requirements (uses o4-mini)
- **Reviewer**: Performs code reviews and quality checks (uses o4-mini)

Additional specialist roles can be added as needed (DevOps, Security, Data Scientist, etc.).

### 15.2 Model Assignment

```toml
# Default model assignments (SOTA defaults)
[models]
orchestrator = "o4-mini"  # Coordination doesn't need the most powerful model
architect = "o3"          # Complex planning benefits from the most capable model
coder = "o4-mini"         # Implementation with clear guidance uses cheaper model
tester = "o4-mini"        # Testing with clear criteria uses cheaper model
reviewer = "o4-mini"      # Code review with clear standards uses cheaper model
```

The system would always support overriding with a global model:
```bash
# Override all roles to use the same model
codex -m o3 "Create a web scraper"
```

### 15.3 Human Team Parallel

This approach mirrors how a human software team works:
- Customer (User) → PM (Orchestrator) → Architect → Developers (Coders) → QA (Testers)
- Each role has specific responsibilities and gets properly scoped context
- The most expensive resources (like Architects) are used only where truly needed

### 15.4 Context Management

Each role receives precisely the context it needs:
- **Orchestrator**: User history, project overview, high-level context
- **Architect**: Detailed system architecture, constraints, existing patterns
- **Coder**: Specific file contents, related files, architectural guidance
- **Tester**: Test requirements, code changes, expected behaviors

This minimizes context pollution and allows each agent to focus on its specific task.

### 15.5 Fixed Workflow

The system follows a consistent, sequential coordination pattern:
1. User input → Orchestrator
2. Orchestrator determines required steps and delegates to appropriate roles
3. Each role executes its task and returns structured output
4. Results flow back through Orchestrator before being presented to user

No configurable behaviors or alternative workflows - just one well-designed approach.

### 15.6 Implementation Plan

1. Refactor the existing Orchestrator from code logic to an AI agent role
2. Define the role registry with SOTA defaults (o3 for Architect, o4-mini for others)
3. Build context isolation system for each role
4. Implement the sequential coordination workflow
5. Update config system to support role-specific model assignment

-------------------------------------------------------------------------------
*End of file*
