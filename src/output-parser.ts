/**
 * src/output-parser.ts
 * Re-exports all public API from the root module and adds parseOutput(),
 * the named entry-point used by the runtime.
 */

export type {
  SourceType,
  CodeBlock,
  ParsedOutput,
  ParserOptions,
} from "../output-parser.ts";

export {
  parse,
  parseForTool,
  EXAMPLES,
  runExamples,
} from "../output-parser.ts";

import { parse } from "../output-parser.ts";
import type { ParsedOutput, ParserOptions } from "../output-parser.ts";

/**
 * parseOutput — primary parsing entry-point for the OpenClaw runtime.
 * A named alias for parse() with an intent-signalling name.
 */
export function parseOutput(raw: string, opts?: ParserOptions): ParsedOutput {
  return parse(raw, opts);
}
