/**
 * src/cli-wrapper.ts
 * Re-exports all public API from the root module and adds runCli(),
 * which dispatches to the correct tool based on the decided path.
 */

export type {
  ToolOutcome,
  ParseStrategy,
  RetryPolicy,
  OutputParserConfig,
  ErrorOverride,
  ToolConfig,
  ToolResult,
  ClaudeOptions,
  CodexOptions,
} from "../cli-wrapper.ts";

export {
  runTool,
  runClaude,
  runCodex,
  usageExamples,
} from "../cli-wrapper.ts";

import { runClaude, runCodex } from "../cli-wrapper.ts";
import type { ToolResult, ClaudeOptions, CodexOptions } from "../cli-wrapper.ts";

/**
 * runCli — single dispatch function for the runtime.
 * Accepts the decided path and routes to the correct CLI wrapper.
 * Never called with "local_llm" — the runtime handles that branch itself.
 */
export async function runCli(
  path:   "claude" | "codex",
  prompt: string,
  opts:   ClaudeOptions & CodexOptions = {},
): Promise<ToolResult> {
  if (path === "claude") return runClaude(prompt, opts);
  if (path === "codex")  return runCodex(prompt, opts);
  // Exhaustive check — TypeScript narrows this away at compile time
  throw new Error(`runCli: unexpected path "${path as string}"`);
}
