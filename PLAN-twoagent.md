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

1. The **Architect** model (large & expensive) receives the full user prompt
   plus project context once per user turn and emits a JSON **Change Plan**.
2. The **Orchestrator** (local Node/TS code in Codex‑CLI):
   a. Validates the Change Plan.
   b. Fans out each `edit` / `command` item to the **Coder** model (small & cheap).
   c. Applies returned patches, runs tests/linters, and feeds back failures.
3. The **Coder** model consumes *one* action at a time together with a minimal
   context slice (usually just the target file) and returns an RFC‑8259 diff.

The loop continues until all actions succeed or the Architect is re‑invoked for
re‑planning.

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

Why: keep Coder within a small model’s token window (e.g. 16 k tokens for
`gpt-3.5-turbo` is still pricey).

Strategy:
1. Give Coder **only** the file contents + action + per‑file rolling summary.
2. Maintain a `summaries.json` mapping file → short natural‑language summary.
   Update it using the diff hunk plus `openai_model=summarizer` (optional).
3. Store summaries in `.codex/cache/` so reruns are instant.

-------------------------------------------------------------------------------
## 7  Failure & Recovery Logic

* **Coder patch fails to apply** → retry once with Git reject hunks context → else escalate to Architect.
* **Tests fail**:
  - If only the edited file appears in the stack‑trace, retry Coder with failure
    output.
  - Otherwise escalate to Architect.
* **Architect JSON invalid** → call Architect again with validation error
  message prepended.

-------------------------------------------------------------------------------
## 8  Configuration Surface

Add to existing `config.ts` loader:

```toml
two_agent      = true            # opt‑in
architect_model = "gpt-4o-mini"
coder_model     = "gpt-3.5-turbo-0125"
coder_temp      = 0.2
```

CLI flag `--two-agent` overrides config file.

-------------------------------------------------------------------------------
## 9  Telemetry & Cost Tracking

* Record tokens, latency, cost per model call.
* JSONL log per session: `{ ts, role, tokens_in, tokens_out, cost_usd }`.
* Surface summary at end of session to prove savings.

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
*End of file*
