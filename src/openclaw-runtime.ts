/**
 * src/openclaw-runtime.ts
 * OpenClaw tool routing runtime — entry point for the route_ai_task tool.
 *
 * Flow:
 *   JSON input (stdin or argv[2])
 *     → validate & coerce
 *     → decide (decision-engine)
 *     → execute (cli-wrapper, or skip if local_llm)
 *     → parse   (output-parser)
 *     → log     (memory-loop)
 *     → print structured JSON to stdout
 *
 * Logs go to stderr; stdout is always one JSON object.
 */

import { randomUUID } from "node:crypto";
import { decideTool }  from "./decision-engine.ts";
import { runCli }      from "./cli-wrapper.ts";
import { parseOutput } from "./output-parser.ts";
import { appendMemory } from "./memory-loop.ts";

import type { TaskInput, Decision, ExecutionPath } from "./decision-engine.ts";
import type { ToolResult }   from "./cli-wrapper.ts";
import type { ParsedOutput } from "./output-parser.ts";
import type { MemoryEntry }  from "./memory-loop.ts";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

interface RuntimeInput {
  description:      string;
  prompt?:          string;
  complexity?:      number;
  file_involvement?: boolean;
  context_size?:    number;
  urgency?:         "low" | "medium" | "high";
}

export interface RuntimeResult {
  run_id:        string;
  timestamp:     string;
  selected_path: ExecutionPath;
  success:       boolean;
  response:      string | null;
  decision:      Decision;
  cli_result:    ToolResult | null;
  parsed:        ParsedOutput | null;
  error:         string | null;
}

// ─────────────────────────────────────────────
// Input handling
// ─────────────────────────────────────────────

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data",  chunk => { buf += chunk; });
    process.stdin.on("end",   () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

const URGENCY_VALUES = new Set(["low", "medium", "high"]);

function coerceInput(raw: unknown): { task: TaskInput; prompt: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Input must be a JSON object.");
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.description !== "string" || r.description.trim() === "") {
    throw new Error("'description' is required and must be a non-empty string.");
  }

  const complexity = typeof r.complexity === "number"
    ? Math.min(10, Math.max(0, r.complexity))
    : 5;

  const urgency = URGENCY_VALUES.has(String(r.urgency))
    ? (r.urgency as "low" | "medium" | "high")
    : "medium";

  const task: TaskInput = {
    description:      r.description.trim(),
    complexity,
    file_involvement: Boolean(r.file_involvement ?? false),
    context_size:     typeof r.context_size === "number" ? Math.max(0, r.context_size) : 1_000,
    urgency,
  };

  const prompt = typeof r.prompt === "string" && r.prompt.trim()
    ? r.prompt.trim()
    : task.description;

  return { task, prompt };
}

// ─────────────────────────────────────────────
// Local path response
// No CLI is called; return decision metadata as the result.
// ─────────────────────────────────────────────

function buildLocalResult(
  run_id:    string,
  timestamp: string,
  task:      TaskInput,
  decision:  Decision,
): RuntimeResult {
  const response =
    `[local_llm] Task routed to local model. ` +
    `Confidence: ${(decision.confidence * 100).toFixed(0)}%. ` +
    `Reasoning: ${decision.reasoning.at(-1) ?? "n/a"}`;

  return {
    run_id,
    timestamp,
    selected_path: "local_llm",
    success:    true,
    response,
    decision,
    cli_result: null,
    parsed:     null,
    error:      null,
  };
}

// ─────────────────────────────────────────────
// CLI path response
// ─────────────────────────────────────────────

async function buildCliResult(
  run_id:    string,
  timestamp: string,
  task:      TaskInput,
  decision:  Decision,
  prompt:    string,
): Promise<RuntimeResult> {
  const path = decision.selected_path as "claude" | "codex";

  const cliResult = await runCli(path, prompt);

  if (!cliResult.success) {
    // Surface failure; include fallback_path hint for the caller
    return {
      run_id,
      timestamp,
      selected_path: decision.selected_path,
      success:    false,
      response:   null,
      decision,
      cli_result: cliResult,
      parsed:     null,
      error:      `${cliResult.outcome}: ${cliResult.error?.message ?? "unknown error"}. ` +
                  `Suggested fallback: ${decision.fallback_path}`,
    };
  }

  const parsed = parseOutput(cliResult.raw_stdout, { tool: path });

  // Extract the most useful response string for the caller
  const fallbackText = parsed.raw_json && typeof parsed.raw_json === "object"
    ? JSON.stringify(parsed.raw_json).slice(0, 500)
    : cliResult.raw_stdout.slice(0, 500).trim();

  const response = (parsed.summary || fallbackText) || null;

  return {
    run_id,
    timestamp,
    selected_path: decision.selected_path,
    success:    true,
    response,
    decision,
    cli_result: cliResult,
    parsed,
    error:      null,
  };
}

// ─────────────────────────────────────────────
// Structured stderr logger
// ─────────────────────────────────────────────

function logRuntime(
  level: "info" | "warn" | "error",
  event: string,
  run_id: string,
  fields: Record<string, unknown> = {},
): void {
  process.stderr.write(
    JSON.stringify({ level, timestamp: new Date().toISOString(), source: "runtime", event, run_id, ...fields }) + "\n"
  );
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function main(): Promise<void> {
  const run_id    = randomUUID();
  const timestamp = new Date().toISOString();
  const wallStart = Date.now();

  // ── 1. Read input ────────────────────────────────────────────────────
  let rawStr: string;
  if (process.argv[2]?.trim()) {
    rawStr = process.argv[2];
  } else if (!process.stdin.isTTY) {
    rawStr = await readStdin();
  } else {
    emit({ run_id, timestamp, selected_path: "local_llm" as ExecutionPath,
      success: false, response: null, decision: null as unknown as Decision,
      cli_result: null, parsed: null,
      error: "No input. Pipe JSON via stdin or pass a JSON string as argv[2]." });
    process.exit(1);
  }

  // ── 2. Parse & validate ──────────────────────────────────────────────
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawStr.trim());
  } catch {
    emit({ run_id, timestamp, selected_path: "local_llm" as ExecutionPath,
      success: false, response: null, decision: null as unknown as Decision,
      cli_result: null, parsed: null, error: "Invalid JSON input." });
    process.exit(1);
  }

  let task: TaskInput, prompt: string;
  try {
    ({ task, prompt } = coerceInput(parsed));
  } catch (err) {
    emit({ run_id, timestamp, selected_path: "local_llm" as ExecutionPath,
      success: false, response: null, decision: null as unknown as Decision,
      cli_result: null, parsed: null,
      error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }

  logRuntime("info", "runtime_start", run_id, {
    description:  task.description.slice(0, 80),
    complexity:   task.complexity,
    urgency:      task.urgency,
    file:         task.file_involvement,
    context_size: task.context_size,
  });

  // ── 3. Route ─────────────────────────────────────────────────────────
  const decision = decideTool(task);

  logRuntime("info", "decision_made", run_id, {
    selected_path: decision.selected_path,
    confidence:    decision.confidence,
    cost_tier:     decision.cost_tier,
  });

  // ── 4. Execute ───────────────────────────────────────────────────────
  let result: RuntimeResult;

  if (decision.selected_path === "local_llm") {
    result = buildLocalResult(run_id, timestamp, task, decision);
  } else {
    result = await buildCliResult(run_id, timestamp, task, decision, prompt);
  }

  const duration_ms = Date.now() - wallStart;

  logRuntime(result.success ? "info" : "warn", "runtime_end", run_id, {
    selected_path: result.selected_path,
    success:       result.success,
    duration_ms,
  });

  // ── 5. Memory ─────────────────────────────────────────────────────────
  const memEntry: MemoryEntry = {
    run_id,
    timestamp,
    task_description:    task.description,
    selected_path:       result.selected_path,
    decision_confidence: decision.confidence,
    fallback_path:       decision.fallback_path,
    cost_tier:           decision.cost_tier,
    success:             result.success,
    outcome:             result.cli_result?.outcome ?? (result.success ? "local" : "error"),
    duration_ms,
    summary:             result.parsed?.summary ?? null,
  };
  appendMemory(memEntry);

  // ── 6. Output ─────────────────────────────────────────────────────────
  emit(result);
}

function emit(result: RuntimeResult): void {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch(err => {
  process.stderr.write(
    JSON.stringify({ level: "error", event: "runtime_crash", error: String(err) }) + "\n"
  );
  process.stdout.write(
    JSON.stringify({ success: false, error: String(err), run_id: "unknown", timestamp: new Date().toISOString() }) + "\n"
  );
  process.exit(1);
});
