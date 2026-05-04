/**
 * src/decision-engine.ts
 * Re-exports all public API from the root module and adds decideTool(),
 * the named entry-point used by the runtime.
 */

export type {
  ExecutionPath,
  Urgency,
  CostTier,
  TaskInput,
  PathScore,
  Decision,
} from "../decision-engine.ts";

export {
  decide,
  batch,
  SAMPLE_TASKS,
  runExamples,
} from "../decision-engine.ts";

import { decide } from "../decision-engine.ts";
import type { TaskInput, Decision } from "../decision-engine.ts";

/**
 * decideTool — primary routing entry-point for the OpenClaw runtime.
 * A named alias for decide() with an intent-signalling name.
 */
export function decideTool(input: TaskInput): Decision {
  return decide(input);
}
