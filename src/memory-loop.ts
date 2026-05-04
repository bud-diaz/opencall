/**
 * src/memory-loop.ts
 * Appends every route_ai_task invocation to memory/tool-calls.jsonl.
 * One JSON object per line; directory is created on first write.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const MEMORY_DIR  = join(process.cwd(), "memory");
const MEMORY_FILE = join(MEMORY_DIR, "tool-calls.jsonl");

export interface MemoryEntry {
  run_id:              string;
  timestamp:           string;
  task_description:    string;
  selected_path:       string;
  decision_confidence: number;
  fallback_path:       string;
  cost_tier:           string;
  success:             boolean;
  outcome:             string;
  duration_ms:         number;
  summary:             string | null;
}

function ensureDir(): void {
  mkdirSync(MEMORY_DIR, { recursive: true });
}

/** Append one call record to memory/tool-calls.jsonl. Never throws. */
export function appendMemory(entry: MemoryEntry): void {
  try {
    ensureDir();
    appendFileSync(MEMORY_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    // Log to stderr so it doesn't corrupt stdout JSON; don't crash the runtime
    process.stderr.write(
      JSON.stringify({ level: "warn", event: "memory_write_failed", error: String(err) }) + "\n"
    );
  }
}

/** Read and parse all entries from the log file. Returns [] if file is absent. */
export function readMemory(): MemoryEntry[] {
  if (!existsSync(MEMORY_FILE)) return [];
  return readFileSync(MEMORY_FILE, "utf8")
    .split("\n")
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l) as MemoryEntry);
}

export function getMemoryPath(): string {
  return MEMORY_FILE;
}
