# OpenClaw Tool-Calling Architecture

## Deliverables

| File | Purpose |
|---|---|
| `schema.json` | JSON Schema (draft-07) — single-tool definition contract |
| `example-tools.json` | Concrete tool configs for Claude Code, Codex, + a generic stub |

---

## Key Decisions

### 1. Schema-first, not code-first

Every tool is a data document, not a class. The orchestrator loads and validates tools at startup against `schema.json`. Adding a new tool never requires a code change — drop a JSON file into the registry and restart.

### 2. Template args (`{{variable}}`)

CLI args are strings with `{{var}}` placeholders. `input_schema` declares each variable's type, whether it is required, and its default. The runner resolves templates at invocation time after validating inputs. This keeps tools declarative while still supporting dynamic invocation.

### 3. Layered output parsing

Raw CLI stdout is hostile: it may be plain text, Markdown, JSON inside a fence block, or nothing at all. The `output_parser` hook normalises this before anything reaches the agent:

```
stdout
  → json_fence_extract   (Claude wraps JSON in ```json fences)
  → json_parse           (Codex returns bare JSON)
  → passthrough          (generic/unknown tools)
  → json_wrap fallback   (always produces a structured envelope on parse failure)
```

The fallback (`on_parse_error: "fallback_json_wrap"`) guarantees the agent always receives an object, never a raw string crash.

### 4. Structured result envelope

Every tool execution — success or failure — returns the same `tool_result` shape:

```
{
  run_id, tool, success, outcome,
  parsed_output,          ← what the agent consumes
  raw_stdout, raw_stderr, ← kept for debugging
  metadata: { attempt, duration_ms, exit_code },
  error
}
```

Downstream consumers (memory store, response formatter) never branch on which tool was called.

### 5. Retry policy is data, not logic

Retry behaviour lives in the tool definition (`retry`), not in the runner's source code. Each tool specifies its own `max_attempts`, exponential backoff parameters, and which exit codes or stderr patterns are transient (rate limits) vs fatal (auth errors). The runner is a generic executor.

### 6. Error policy separates classification from action

`error_policy.exit_code_map` maps raw exit codes to semantic outcomes (`auth_error`, `timeout`, etc.). `stderr_overrides` let noisy CLIs that always exit 1 still be classified correctly. The runner converts raw process state into a symbolic `outcome` string before the agent ever sees it.

### 7. Secrets stay out of the schema

API keys are declared in `input_schema` with type `string` and are injected at runtime from an external secret store (env vars, Vault, etc.). They appear in `args` as `{{ANTHROPIC_API_KEY}}` templates. The log format explicitly documents that `input_vars` must be sanitised — secrets are never written to logs.

### 8. `enabled` flag and tags for routing

Tools carry an `enabled` boolean and free-form `tags`. The orchestrator can disable a tool without deleting it (useful during API outages), and the local model can use tags as hints when selecting among available tools.

---

## How a tool invocation flows

```
Agent issues tool call
       │
       ▼
1. Input validation   — input_schema checked, templates resolved
       │
       ▼
2. Subprocess spawn   — command + resolved args, env, working_dir, timeout_ms
       │
       ├── timeout → SIGTERM → SIGKILL → outcome: "timeout"
       │
       ▼
3. Exit code + stderr → error_policy → symbolic outcome
       │
       ▼
4. output_parser hook — normalise stdout → parsed_output
       │
       ├── parse failure → on_parse_error fallback
       │
       ▼
5. Structured log emitted (JSON, one line per event)
       │
       ▼
6. tool_result envelope returned to agent loop
```

---

## Adding a future tool

Copy the `run_shell_tool` stub in `example-tools.json`, fill in the fields, and set `"enabled": true`. No code changes required. The schema enforces the contract at load time.
