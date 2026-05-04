/**
 * OpenClaw CLI Wrapper
 *
 * Safe subprocess execution layer for Claude CLI and Codex CLI.
 * Plugs into the tool configs defined in example-tools.json and the
 * ToolResult envelope shape defined in schema.json.
 */

import { spawn }      from "node:child_process";
import { randomUUID } from "node:crypto";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type ToolOutcome =
  | "success" | "tool_error" | "usage_error"
  | "auth_error" | "timeout" | "interrupted" | "unknown";

export type ParseStrategy =
  | "passthrough" | "json_parse" | "json_extract"
  | "json_fence_extract" | "json_wrap";

export interface RetryPolicy {
  max_attempts:              number;
  initial_backoff_ms:        number;
  backoff_multiplier:        number;
  max_backoff_ms:            number;
  retryable_exit_codes:      number[];
  retryable_stderr_patterns?: string[];
}

export interface OutputParserConfig {
  type:            ParseStrategy;
  fields?:         string[];
  fence_language?: string;
  wrap_key?:       string;
  include_stderr?: boolean;
  on_parse_error?: "fail" | "fallback_json_wrap" | "fallback_passthrough";
}

export interface ErrorOverride {
  pattern: string;
  outcome: ToolOutcome;
  action:  "retry" | "fail_hard" | "log_and_continue";
}

export interface ToolConfig {
  name:             string;
  command:          string;
  args:             string[];        // {{variable}} templates
  env?:             Record<string, string>;
  shell?:           boolean;
  timeout_ms:       number;
  retry:            RetryPolicy;
  parser:           OutputParserConfig;
  exit_code_map?:   Record<string, ToolOutcome>;
  stderr_overrides?: ErrorOverride[];
}

export interface ToolResult {
  run_id:        string;
  tool:          string;
  success:       boolean;
  outcome:       ToolOutcome;
  parsed_output: unknown;
  raw_stdout:    string;
  raw_stderr:    string;
  metadata: {
    attempt:     number;
    duration_ms: number;
    exit_code:   number | null;
  };
  error: { code: string; message: string; detail?: string } | null;
}

// ─────────────────────────────────────────────
// Structured logger  (JSON lines → stderr)
// Keeps stdout clean for piping; never logs secret-shaped keys.
// ─────────────────────────────────────────────

type LogLevel = "debug" | "info" | "warn" | "error";
type LogEvent  =
  | "invoke_start" | "invoke_end" | "retry_attempt"
  | "parse_start"  | "parse_end"  | "parse_error"
  | "timeout"      | "error";

const SECRET_KEY = /key|token|secret|password|auth/i;

function sanitise(vars: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(vars).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[redacted]" : v])
  );
}

function log(
  level:  LogLevel,
  event:  LogEvent,
  tool:   string,
  run_id: string,
  fields: Record<string, unknown> = {},
): void {
  process.stderr.write(
    JSON.stringify({ level, timestamp: new Date().toISOString(), tool, event, run_id, ...fields }) + "\n"
  );
}

// ─────────────────────────────────────────────
// Template resolver
// ─────────────────────────────────────────────

function resolve(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in vars)) throw new Error(`Unresolved template variable: {{${key}}}`);
    return vars[key];
  });
}

// ─────────────────────────────────────────────
// Subprocess executor
// ─────────────────────────────────────────────

interface SpawnResult {
  stdout:   string;
  stderr:   string;
  exitCode: number | null;
  timedOut: boolean;
}

function spawnProcess(
  command:    string,
  args:       string[],
  env:        Record<string, string>,
  timeout_ms: number,
  shell:      boolean,
): Promise<SpawnResult> {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      env:   { ...process.env, ...env } as NodeJS.ProcessEnv,
      shell,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "", stderr = "", timedOut = false;

    child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });

    // Two-stage kill: SIGTERM first, SIGKILL after 5 s if still running
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already exited */ } }, 5_000);
    }, timeout_ms);

    child.on("close", code => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: code, timedOut }); });

    // ENOENT / EACCES — treat as exit 127 (command not found)
    child.on("error", err => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + err.message, exitCode: 127, timedOut: false });
    });
  });
}

// ─────────────────────────────────────────────
// Output parsers
// ─────────────────────────────────────────────

function dotGet(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((cur, key) =>
    cur != null && typeof cur === "object" ? (cur as Record<string, unknown>)[key] : undefined
  , obj);
}

function parseOutput(stdout: string, stderr: string, cfg: OutputParserConfig): unknown {
  const wrap = (): unknown => ({ [cfg.wrap_key ?? "output"]: stdout, ...(cfg.include_stderr ? { stderr } : {}) });

  try {
    switch (cfg.type) {
      case "passthrough":
        return stdout;

      case "json_parse":
        return JSON.parse(stdout.trim());

      case "json_extract": {
        const parsed = JSON.parse(stdout.trim());
        return cfg.fields?.length
          ? Object.fromEntries(cfg.fields.map(f => [f, dotGet(parsed, f)]))
          : parsed;
      }

      case "json_fence_extract": {
        const lang  = cfg.fence_language ?? "json";
        // Claude often wraps output in ```json ... ``` fences
        const match = new RegExp("```" + lang + "?\\s*([\\s\\S]*?)```", "i").exec(stdout);
        if (!match) throw new Error("no fenced block in output");
        const parsed = JSON.parse(match[1].trim());
        return cfg.fields?.length
          ? Object.fromEntries(cfg.fields.map(f => [f, dotGet(parsed, f)]))
          : parsed;
      }

      case "json_wrap":
        return wrap();
    }
  } catch {
    if (cfg.on_parse_error === "fail")                  throw new Error("parse failed");
    if (cfg.on_parse_error === "fallback_passthrough")  return stdout;
    return wrap();   // fallback_json_wrap (default) — always returns an object
  }
}

// ─────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────

const BASE_EXIT_MAP: Record<string, ToolOutcome> = {
  "0": "success", "1": "tool_error", "2": "usage_error",
  "124": "timeout", "127": "tool_error", "130": "interrupted",
};

function classifyOutcome(result: SpawnResult, cfg: ToolConfig): ToolOutcome {
  if (result.timedOut) return "timeout";
  for (const ov of cfg.stderr_overrides ?? []) {
    if (new RegExp(ov.pattern, "i").test(result.stderr)) return ov.outcome;
  }
  return { ...BASE_EXIT_MAP, ...cfg.exit_code_map }[String(result.exitCode)] ?? "unknown";
}

function isRetryable(outcome: ToolOutcome, result: SpawnResult, pol: RetryPolicy): boolean {
  if (outcome === "auth_error" || outcome === "usage_error") return false;
  if (outcome === "timeout")    return true;
  if (result.exitCode !== null && pol.retryable_exit_codes.includes(result.exitCode)) return true;
  return (pol.retryable_stderr_patterns ?? []).some(p => new RegExp(p, "i").test(result.stderr));
}

// ─────────────────────────────────────────────
// Core execution loop
// ─────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function errorResult(
  run_id: string, tool: string, outcome: ToolOutcome,
  message: string, attempt: number, duration_ms: number,
  exitCode: number | null, raw_stdout = "", raw_stderr = "",
): ToolResult {
  return { run_id, tool, success: false, outcome, parsed_output: null,
    raw_stdout, raw_stderr, metadata: { attempt, duration_ms, exit_code: exitCode },
    error: { code: outcome, message } };
}

export async function runTool(config: ToolConfig, vars: Record<string, string>): Promise<ToolResult> {
  const run_id = randomUUID();
  const pol    = config.retry;

  log("info", "invoke_start", config.name, run_id, { input_vars: sanitise(vars) });

  const wallStart = Date.now();
  let attempt = 0;
  let backoff  = pol.initial_backoff_ms;
  let last:    SpawnResult = { stdout: "", stderr: "", exitCode: null, timedOut: false };
  let outcome: ToolOutcome = "unknown";

  while (attempt < pol.max_attempts) {
    attempt++;
    if (attempt > 1) {
      log("info", "retry_attempt", config.name, run_id, { attempt, backoff_ms: backoff });
      await sleep(backoff);
      backoff = Math.min(backoff * pol.backoff_multiplier, pol.max_backoff_ms);
    }

    let resolvedArgs: string[];
    let resolvedEnv:  Record<string, string>;
    try {
      resolvedArgs = config.args.map(a => resolve(a, vars));
      resolvedEnv  = Object.fromEntries(
        Object.entries(config.env ?? {}).map(([k, v]) => [k, resolve(v, vars)])
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("error", "error", config.name, run_id, { attempt, error: msg });
      return errorResult(run_id, config.name, "usage_error", msg, attempt, Date.now() - wallStart, null);
    }

    last    = await spawnProcess(config.command, resolvedArgs, resolvedEnv, config.timeout_ms, config.shell ?? false);
    outcome = classifyOutcome(last, config);

    if (outcome === "success") break;
    if (!isRetryable(outcome, last, pol) || attempt >= pol.max_attempts) break;
  }

  const duration_ms = Date.now() - wallStart;
  log(outcome === "success" ? "info" : "warn", "invoke_end", config.name, run_id,
    { attempt, duration_ms, exit_code: last.exitCode, outcome });

  if (outcome !== "success") {
    return errorResult(run_id, config.name, outcome,
      last.stderr.trim() || `exit ${last.exitCode}`,
      attempt, duration_ms, last.exitCode, last.stdout, last.stderr);
  }

  log("debug", "parse_start", config.name, run_id, {});
  let parsed: unknown;
  try {
    parsed = parseOutput(last.stdout, last.stderr, config.parser);
    log("debug", "parse_end", config.name, run_id, {});
  } catch {
    log("warn", "parse_error", config.name, run_id, {});
    parsed = { output: last.stdout };
  }

  return { run_id, tool: config.name, success: true, outcome: "success",
    parsed_output: parsed, raw_stdout: last.stdout, raw_stderr: last.stderr,
    metadata: { attempt, duration_ms, exit_code: last.exitCode }, error: null };
}

// ─────────────────────────────────────────────
// Built-in tool configs  (mirrors example-tools.json)
// ─────────────────────────────────────────────

const CLAUDE_CONFIG: ToolConfig = {
  name:    "ask_claude",
  command: "claude",
  args:    ["--print", "--output-format", "json", "--system-prompt", "{{system_prompt}}", "{{input}}"],
  env:     { ANTHROPIC_API_KEY: "{{ANTHROPIC_API_KEY}}", NO_COLOR: "1" },
  shell:   false,
  timeout_ms: 120_000,
  retry: {
    max_attempts: 3, initial_backoff_ms: 2_000,
    backoff_multiplier: 2.0, max_backoff_ms: 30_000,
    retryable_exit_codes: [1, 124],
    retryable_stderr_patterns: ["rate.?limit", "overloaded", "529", "temporarily unavailable", "connection reset"],
  },
  parser: {
    type: "json_fence_extract", fence_language: "json",
    fields: ["summary", "changes", "code", "notes", "files_modified"],
    on_parse_error: "fallback_json_wrap",
  },
  exit_code_map: { "0": "success", "1": "tool_error", "2": "usage_error", "124": "timeout", "130": "interrupted" },
  stderr_overrides: [
    { pattern: "invalid.?api.?key|authentication|unauthorized", outcome: "auth_error",  action: "fail_hard" },
    { pattern: "rate.?limit|overloaded",                        outcome: "tool_error",  action: "retry" },
  ],
};

const CODEX_CONFIG: ToolConfig = {
  name:    "ask_codex",
  command: "codex",
  args:    ["--quiet", "--output-format", "json", "--prompt", "{{input}}"],
  env:     { OPENAI_API_KEY: "{{OPENAI_API_KEY}}", NO_COLOR: "1" },
  shell:   false,
  timeout_ms: 45_000,
  retry: {
    max_attempts: 3, initial_backoff_ms: 1_000,
    backoff_multiplier: 2.0, max_backoff_ms: 16_000,
    retryable_exit_codes: [1, 124],
    retryable_stderr_patterns: ["rate.?limit", "503", "timeout", "connection reset"],
  },
  parser: {
    type: "json_parse",
    fields: ["code", "language", "filename", "explanation"],
    on_parse_error: "fallback_json_wrap",
  },
  exit_code_map: { "0": "success", "1": "tool_error", "2": "usage_error", "124": "timeout", "130": "interrupted" },
  stderr_overrides: [
    { pattern: "invalid.?api.?key|unauthorized|401", outcome: "auth_error", action: "fail_hard" },
    { pattern: "rate.?limit|429",                    outcome: "tool_error", action: "retry" },
  ],
};

const DEFAULT_SYSTEM_PROMPT =
  "You are a precise engineering assistant. " +
  "Return all outputs as valid JSON. Do not add commentary outside the JSON block.";

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

export interface ClaudeOptions {
  system_prompt?: string;
  timeout_ms?:    number;
  apiKey?:        string;
}

export async function runClaude(prompt: string, opts: ClaudeOptions = {}): Promise<ToolResult> {
  const config = opts.timeout_ms
    ? { ...CLAUDE_CONFIG, timeout_ms: opts.timeout_ms }
    : CLAUDE_CONFIG;

  return runTool(config, {
    input:            prompt,
    system_prompt:    opts.system_prompt ?? DEFAULT_SYSTEM_PROMPT,
    ANTHROPIC_API_KEY: opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "",
  });
}

export interface CodexOptions {
  timeout_ms?: number;
  apiKey?:     string;
}

export async function runCodex(prompt: string, opts: CodexOptions = {}): Promise<ToolResult> {
  const config = opts.timeout_ms
    ? { ...CODEX_CONFIG, timeout_ms: opts.timeout_ms }
    : CODEX_CONFIG;

  return runTool(config, {
    input:        prompt,
    OPENAI_API_KEY: opts.apiKey ?? process.env.OPENAI_API_KEY ?? "",
  });
}

// ─────────────────────────────────────────────
// Usage examples
// ─────────────────────────────────────────────

export async function usageExamples(): Promise<void> {
  console.log("=== OpenClaw CLI Wrapper — Usage Examples ===\n");

  // ── Example 1: basic Claude call ──────────────────────────────────────
  console.log("── Example 1: runClaude (basic) ──");
  const r1 = await runClaude(
    "Refactor this function to use async/await:\n\nfunction getUser(id, cb) { db.find(id, cb); }"
  );
  console.log("success  :", r1.success);
  console.log("outcome  :", r1.outcome);
  console.log("output   :", JSON.stringify(r1.parsed_output, null, 2));
  console.log("duration :", r1.metadata.duration_ms, "ms\n");

  // ── Example 2: basic Codex call ───────────────────────────────────────
  console.log("── Example 2: runCodex (basic) ──");
  const r2 = await runCodex(
    "Generate a TypeScript function that validates an email address with a regex."
  );
  console.log("success  :", r2.success);
  console.log("outcome  :", r2.outcome);
  console.log("output   :", JSON.stringify(r2.parsed_output, null, 2));
  console.log("duration :", r2.metadata.duration_ms, "ms\n");

  // ── Example 3: custom system prompt + shorter timeout ─────────────────
  console.log("── Example 3: runClaude with custom options ──");
  const r3 = await runClaude(
    "List the top 3 security issues in this code:\n\nconst q = `SELECT * FROM users WHERE id=${req.params.id}`",
    {
      system_prompt: "You are a security expert. Respond only with a JSON array of issue objects {issue, severity, fix}.",
      timeout_ms:    60_000,
    }
  );
  console.log("success  :", r3.success);
  console.log("fallback?:", !r3.success ? r3.outcome : "n/a");
  console.log("output   :", JSON.stringify(r3.parsed_output, null, 2), "\n");

  // ── Example 4: low-level runTool with a custom config ─────────────────
  console.log("── Example 4: runTool with a custom tool config ──");
  const customConfig: ToolConfig = {
    name:    "echo_tool",
    command: "echo",
    args:    ["{{input}}"],
    shell:   false,
    timeout_ms: 5_000,
    retry:   { max_attempts: 1, initial_backoff_ms: 500, backoff_multiplier: 1, max_backoff_ms: 500, retryable_exit_codes: [] },
    parser:  { type: "json_wrap", wrap_key: "result", on_parse_error: "fallback_json_wrap" },
  };
  const r4 = await runTool(customConfig, { input: "hello from custom tool" });
  console.log("success  :", r4.success);
  console.log("output   :", JSON.stringify(r4.parsed_output, null, 2), "\n");

  // ── Example 5: inspecting a failure result ────────────────────────────
  console.log("── Example 5: handling a failure (bad command) ──");
  const badConfig: ToolConfig = {
    ...customConfig,
    name:    "bad_tool",
    command: "this-command-does-not-exist",
  };
  const r5 = await runTool(badConfig, { input: "test" });
  console.log("success  :", r5.success);
  console.log("outcome  :", r5.outcome);
  console.log("error    :", r5.error);
  console.log("attempts :", r5.metadata.attempt, "\n");
}

// ts-node --esm cli-wrapper.ts
const _self = (await import("url")).fileURLToPath(import.meta.url);
if (process.argv[1] === _self) {
  await usageExamples();
}
