/**
 * OpenClaw Decision Engine
 *
 * Routes each task to the optimal execution path:
 *   local_llm  — free, fast, limited depth
 *   codex      — fast code generation, moderate cost
 *   claude     — deep reasoning, multi-file, highest cost
 *
 * Algorithm: weighted multi-signal scoring → cost guard → confidence gate → fallback
 */

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type ExecutionPath = "local_llm" | "claude" | "codex";
export type Urgency       = "low" | "medium" | "high";
export type CostTier      = "free" | "low" | "high";

export interface TaskInput {
  /** Natural-language task description — drives keyword scoring. */
  description:      string;
  /** Caller-estimated complexity, 0 (trivial) – 10 (very hard). */
  complexity:       number;
  /** True when the task needs to read or modify existing files. */
  file_involvement: boolean;
  /** Estimated prompt + context token count. */
  context_size:     number;
  urgency:          Urgency;
}

interface SignalVector {
  complexity:   number;
  file_context: number;
  context_size: number;
  urgency:      number;
  keyword:      number;
}

export interface PathScore {
  path:    ExecutionPath;
  total:   number;
  signals: SignalVector;
}

export interface Decision {
  selected_path: ExecutionPath;
  fallback_path: ExecutionPath;
  /** Normalised gap between rank-1 and rank-2 scores (0 = tie, 1 = decisive). */
  confidence:    number;
  cost_tier:     CostTier;
  reasoning:     string[];
  scores:        PathScore[];
}

// ─────────────────────────────────────────────
// Signal weights  (must sum to 1.0)
// ─────────────────────────────────────────────

const W: Record<keyof SignalVector, number> = {
  complexity:   0.30,   // dominant — complexity is the strongest routing signal
  file_context: 0.20,   // file work strongly implies a CLI tool
  context_size: 0.15,   // large context eliminates local and strains Codex
  urgency:      0.15,   // high urgency penalises slow tools
  keyword:      0.20,   // intent extracted from description
};

type PathPreference = Record<ExecutionPath, number>;

// ─────────────────────────────────────────────
// Signal scorers
// Each returns per-path preference in [0, 1].
// ─────────────────────────────────────────────

function scoreComplexity(c: number): PathPreference {
  const n = Math.min(Math.max(c, 0), 10) / 10;
  return {
    local_llm: Math.max(0, 1 - n * 1.5),       // collapses to 0 above complexity ~6.7
    claude:    Math.pow(n, 1.2),                 // accelerating preference for hard tasks
    // Codex sweet-spot is mid-range; bell-curve centred at 0.5
    codex: n <= 0.5
      ? 0.40 + n * 0.80
      : Math.max(0.10, 1 - (n - 0.5) * 1.4),
  };
}

function scoreFileContext(involved: boolean): PathPreference {
  // Without files: local or Codex generates freely.
  // With files: Claude's codebase awareness is the right tool; Codex can still read context.
  return involved
    ? { local_llm: 0.10, claude: 0.90, codex: 0.60 }
    : { local_llm: 0.85, claude: 0.30, codex: 0.65 };
}

function scoreContextSize(tokens: number): PathPreference {
  const localScore =
    tokens < 4_000
      ? 1 - (tokens / 4_000) * 0.4
      : Math.max(0.05, 0.6 - ((tokens - 4_000) / 4_000) * 0.5);

  const claudeScore = Math.min(1, 0.25 + tokens / 16_000);

  const codexScore =
    tokens < 8_000
      ? 0.70
      : Math.max(0.15, 0.70 - ((tokens - 8_000) / 8_000) * 0.5);

  return { local_llm: localScore, claude: claudeScore, codex: codexScore };
}

function scoreUrgency(u: Urgency): PathPreference {
  // High urgency: local (instant) or Codex (fast API); Claude is slower.
  // Low urgency: Claude's thoroughness pays off.
  const MAP: Record<Urgency, PathPreference> = {
    high:   { local_llm: 0.90, claude: 0.20, codex: 0.75 },
    medium: { local_llm: 0.55, claude: 0.60, codex: 0.65 },
    low:    { local_llm: 0.35, claude: 0.90, codex: 0.50 },
  };
  return MAP[u];
}

// Keyword rules — later rules do NOT override earlier; scores are averaged when multiple match.
const KEYWORD_RULES: Array<{ patterns: RegExp[]; scores: PathPreference }> = [
  {
    // Explanatory, planning, conceptual — no external tool required
    patterns: [/\b(explain|what is|describe|summarize|outline|plan|list|break.?down|how does|overview|concept|difference.?between)\b/i],
    scores: { local_llm: 0.95, claude: 0.15, codex: 0.15 },
  },
  {
    // Structural change, debugging, security, multi-file ops
    patterns: [/\b(refactor|rewrite|debug|fix.?bug|migrate|multi.?file|transform|audit|diagnose|trace|security|auth(?:entication)?|vuln)\b/i],
    scores: { local_llm: 0.10, claude: 0.95, codex: 0.25 },
  },
  {
    // New code generation, tests, stubs
    patterns: [/\b(generate|create|write.?test|boilerplate|scaffold|new.?file|implement|snippet|stub|template|endpoint|add.?function)\b/i],
    scores: { local_llm: 0.20, claude: 0.40, codex: 0.90 },
  },
];

const NEUTRAL_KEYWORD: PathPreference = { local_llm: 0.50, claude: 0.50, codex: 0.50 };

function scoreKeywords(description: string): PathPreference {
  const hits = KEYWORD_RULES.filter(r => r.patterns.some(p => p.test(description)));
  if (hits.length === 0) return NEUTRAL_KEYWORD;

  const avg = (k: ExecutionPath) =>
    hits.reduce((s, h) => s + h.scores[k], 0) / hits.length;

  return { local_llm: avg("local_llm"), claude: avg("claude"), codex: avg("codex") };
}

// ─────────────────────────────────────────────
// Score combiner
// ─────────────────────────────────────────────

function computePathScores(input: TaskInput): PathScore[] {
  const raw = {
    complexity:   scoreComplexity(input.complexity),
    file_context: scoreFileContext(input.file_involvement),
    context_size: scoreContextSize(input.context_size),
    urgency:      scoreUrgency(input.urgency),
    keyword:      scoreKeywords(input.description),
  };

  return (["local_llm", "claude", "codex"] as ExecutionPath[]).map(path => {
    const signals: SignalVector = {
      complexity:   raw.complexity[path],
      file_context: raw.file_context[path],
      context_size: raw.context_size[path],
      urgency:      raw.urgency[path],
      keyword:      raw.keyword[path],
    };
    const total = (Object.keys(W) as Array<keyof SignalVector>)
      .reduce((sum, k) => sum + signals[k] * W[k], 0);

    return { path, total, signals };
  });
}

// ─────────────────────────────────────────────
// Post-processing: cost guard + confidence gate
// ─────────────────────────────────────────────

// Promote local_llm if the top paid tool's margin is within this tolerance.
// Prevents spending money when local is "good enough."
const COST_TOLERANCE = 0.08;

function applyCostGuard(sorted: PathScore[], reasoning: string[]): PathScore[] {
  const [first] = sorted;
  if (first.path === "local_llm") return sorted;

  const local = sorted.find(s => s.path === "local_llm")!;
  const margin = first.total - local.total;

  if (margin <= COST_TOLERANCE) {
    reasoning.push(
      `cost_guard: ${first.path} margin over local_llm (${margin.toFixed(3)}) ≤ ${COST_TOLERANCE} — promoting local_llm.`
    );
    return [local, ...sorted.filter(s => s.path !== "local_llm")];
  }
  return sorted;
}

// Confidence = normalised gap; 0.25 gap is treated as fully decisive.
function computeConfidence(sorted: PathScore[]): number {
  if (sorted.length < 2) return 1;
  return Math.min(1, (sorted[0].total - sorted[1].total) / 0.25);
}

// Below this threshold we don't trust the winner enough to call an expensive tool.
const CONFIDENCE_THRESHOLD = 0.30;

const COST: Record<ExecutionPath, CostTier> = {
  local_llm: "free",
  codex:     "low",
  claude:    "high",
};

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

export function decide(input: TaskInput): Decision {
  const reasoning: string[] = [];

  const sorted  = computePathScores(input).sort((a, b) => b.total - a.total);
  const guarded = applyCostGuard(sorted, reasoning);
  const confidence = computeConfidence(guarded);

  let selected_path: ExecutionPath = guarded[0].path;

  // Confidence gate: ambiguous result → safe default
  if (confidence < CONFIDENCE_THRESHOLD && selected_path !== "local_llm") {
    reasoning.push(
      `confidence_gate: score gap too small (${confidence.toFixed(2)} < ${CONFIDENCE_THRESHOLD}) — overriding to local_llm.`
    );
    selected_path = "local_llm";
  }

  const fallback_path = guarded.find(s => s.path !== selected_path)?.path ?? "local_llm";
  const winner        = guarded.find(s => s.path === selected_path)!;

  // Top two weighted contributors to the winning path's score
  const drivers = (Object.keys(W) as Array<keyof SignalVector>)
    .map(k => ({ name: k, contrib: winner.signals[k] * W[k] }))
    .sort((a, b) => b.contrib - a.contrib)
    .slice(0, 2)
    .map(d => `${d.name}(+${d.contrib.toFixed(2)})`);

  reasoning.push(
    `selected=${selected_path} score=${winner.total.toFixed(3)} confidence=${confidence.toFixed(2)} drivers=[${drivers.join(", ")}]`
  );

  return {
    selected_path,
    fallback_path,
    confidence,
    cost_tier: COST[selected_path],
    reasoning,
    scores: guarded,
  };
}

export function batch(inputs: TaskInput[]): Decision[] {
  return inputs.map(decide);
}

// ─────────────────────────────────────────────
// Sample tasks + runner
// ─────────────────────────────────────────────

export const SAMPLE_TASKS: Array<{ label: string; input: TaskInput }> = [
  {
    label: "1 · Explain what closures are in JavaScript",
    input: {
      description:      "Explain what closures are in JavaScript with examples",
      complexity:        1,
      file_involvement:  false,
      context_size:      400,
      urgency:           "low",
    },
  },
  {
    label: "2 · Refactor auth module across 8 files to use JWT",
    input: {
      description:      "Refactor the entire authentication module to use JWT instead of sessions — touches 8 files",
      complexity:        8,
      file_involvement:  true,
      context_size:      12_000,
      urgency:           "low",
    },
  },
  {
    label: "3 · Generate unit tests for UserService",
    input: {
      description:      "Generate unit tests for the UserService class",
      complexity:        4,
      file_involvement:  true,
      context_size:      2_000,
      urgency:           "medium",
    },
  },
  {
    label: "4 · Debug intermittent crash in payment webhook",
    input: {
      description:      "Debug and fix intermittent crash in the payment webhook handler",
      complexity:        7,
      file_involvement:  true,
      context_size:      8_000,
      urgency:           "medium",
    },
  },
  {
    label: "5 · Add password-reset endpoint — deploy in 30 min",
    input: {
      description:      "Add a new REST endpoint for user password reset",
      complexity:        5,
      file_involvement:  true,
      context_size:      3_000,
      urgency:           "high",
    },
  },
];

export function runExamples(): void {
  const BAR: Record<ExecutionPath, string> = {
    local_llm: "[ LOCAL ]",
    codex:     "[ CODEX ]",
    claude:    "[CLAUDE ]",
  };

  for (const { label, input } of SAMPLE_TASKS) {
    const d = decide(input);
    const bar     = "█".repeat(Math.round(d.confidence * 20)).padEnd(20, "░");
    const scores  = d.scores.map(s => `${s.path.padEnd(9)} ${s.total.toFixed(3)}`).join("  |  ");

    console.log(`\n${"─".repeat(60)}`);
    console.log(`Task  : ${label}`);
    console.log(`Path  : ${BAR[d.selected_path]}  fallback → ${d.fallback_path}`);
    console.log(`Conf  : ${bar} ${(d.confidence * 100).toFixed(0)}%  cost=${d.cost_tier}`);
    console.log(`Scores: ${scores}`);
    console.log(`Why   : ${d.reasoning.join("  |  ")}`);
  }
  console.log(`\n${"─".repeat(60)}`);
}

// Run if executed directly: ts-node decision-engine.ts
const _isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (await import("url")).fileURLToPath(import.meta.url) === process.argv[1];

if (_isMain) {
  runExamples();
}
