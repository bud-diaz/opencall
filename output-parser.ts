/**
 * OpenClaw Output Parser
 *
 * Converts raw, unstructured CLI output from AI tools into a normalised
 * ParsedOutput envelope. Works as a standalone module or as the deep-parse
 * layer called after cli-wrapper.ts's thin parsers succeed/fail.
 *
 * Pipeline: clean → detect source type → extract components → score confidence
 */

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type SourceType = "json" | "json_fence" | "mixed" | "prose" | "code_only";

export interface CodeBlock {
  language: string | null;    // "typescript", "python", null if untagged
  code:     string;
  index:    number;           // ordinal within the output (0-based)
}

export interface ParsedOutput {
  source_type:  SourceType;
  summary:      string | null;
  code_blocks:  CodeBlock[];
  actions:      string[];      // concrete things the tool did / recommends doing
  notes:        string[];      // warnings, caveats, "Note:" lines
  raw_json:     unknown | null;
  confidence:   number;        // 0–1: how much structure was recovered
  parse_warnings: string[];    // non-fatal issues encountered during parsing
}

export interface ParserOptions {
  /** Hint the parser toward tool-specific output patterns. */
  tool?:              "claude" | "codex" | "generic";
  /** Maximum length of the extracted summary string. */
  max_summary_length?: number;
  /** If true, keep ANSI escape sequences in code blocks. */
  preserve_ansi?:     boolean;
}

// ─────────────────────────────────────────────
// Stage 1 — Cleaners
// ─────────────────────────────────────────────

// Matches all ANSI CSI escape sequences (colours, cursor movement, etc.)
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Claude CLI wraps its response in a JSON envelope:
 *   { "type": "result", "result": "<assistant text>", ... }
 * Unwrap it so subsequent stages see only the assistant content.
 */
function unwrapClaudeEnvelope(raw: string): { text: string; envelope: unknown | null } {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return { text: raw, envelope: null };
  try {
    const outer = JSON.parse(trimmed);
    if (outer?.type === "result" && typeof outer.result === "string") {
      return { text: outer.result, envelope: outer };
    }
  } catch { /* not an envelope */ }
  return { text: raw, envelope: null };
}

// ─────────────────────────────────────────────
// Stage 2 — Source type detection
// ─────────────────────────────────────────────

function detectSourceType(text: string): SourceType {
  const trimmed = text.trim();

  // Direct JSON object or array
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && isValidJson(trimmed)) {
    return "json";
  }

  const hasFencedJson  = /```json[\s\S]*?```/i.test(text);
  const hasFencedCode  = /```[\w]*\n[\s\S]*?```/.test(text);
  const hasProseLines  = /[A-Za-z]{4,}/.test(text.replace(/```[\s\S]*?```/g, ""));

  if (hasFencedJson)                return "json_fence";
  if (hasFencedCode && hasProseLines) return "mixed";
  if (hasFencedCode)               return "code_only";
  return "prose";
}

function isValidJson(s: string): boolean {
  try { JSON.parse(s); return true; } catch { return false; }
}

// ─────────────────────────────────────────────
// Stage 3 — Extractors
// ─────────────────────────────────────────────

// ── 3a. JSON ──────────────────────────────────

function extractJson(text: string): unknown | null {
  // 1. Direct parse
  const trimmed = text.trim();
  if (isValidJson(trimmed)) return JSON.parse(trimmed);

  // 2. Fenced ```json block
  const fenceMatch = /```json\s*([\s\S]*?)```/i.exec(text);
  if (fenceMatch && isValidJson(fenceMatch[1].trim())) {
    return JSON.parse(fenceMatch[1].trim());
  }

  // 3. Bare JSON object/array embedded in prose.
  //    Strip code fences first so we don't misparse code snippets as JSON.
  const stripFences = text.replace(/```[\s\S]*?```/g, "");
  for (const startChar of ["{", "["]) {
    const idx = stripFences.indexOf(startChar);
    if (idx === -1) continue;
    const endChar = startChar === "{" ? "}" : "]";
    let lastClose = stripFences.lastIndexOf(endChar);
    while (lastClose > idx) {
      const candidate = stripFences.slice(idx, lastClose + 1);
      // Require at least 20 chars to avoid matching single-value arrays like [1]
      if (candidate.length >= 20 && isValidJson(candidate)) return JSON.parse(candidate);
      lastClose = stripFences.lastIndexOf(endChar, lastClose - 1);
    }
  }

  return null;
}

// ── 3b. Code blocks ────────────────────────────

// Captures:  ```[language]\n<code>```  (any language, including unlabelled)
const CODE_FENCE_RE = /```(\w*)\n?([\s\S]*?)```/g;

function extractCodeBlocks(text: string, preserveAnsi: boolean): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  let match: RegExpExecArray | null;
  CODE_FENCE_RE.lastIndex = 0;

  while ((match = CODE_FENCE_RE.exec(text)) !== null) {
    const lang = match[1].trim() || null;
    const code = preserveAnsi ? match[2] : stripAnsi(match[2]);
    blocks.push({ language: lang, code: code.trim(), index: blocks.length });
  }
  return blocks;
}

// ── 3c. Summary ────────────────────────────────

const SUMMARY_HEADERS = [
  /^#{1,3}\s+summary[:\s]/im,
  /^#{1,3}\s+overview[:\s]/im,
  /^#{1,3}\s+result[:\s]/im,
];

const SUMMARY_INLINE = [
  /^summary:\s*(.+)/im,
  /^overview:\s*(.+)/im,
  /^in summary[,:]?\s*(.+)/im,
  /^to summarize[,:]?\s*(.+)/im,
  /^in conclusion[,:]?\s*(.+)/im,
  /^tldr[:\s]+(.+)/im,
];

function extractSummary(text: string, maxLen: number): string | null {
  // Strip code fences before scanning prose for a summary
  const prose = text.replace(/```[\s\S]*?```/g, "").trim();

  // 1. Explicit markdown header → grab the paragraph that follows
  for (const re of SUMMARY_HEADERS) {
    const headerMatch = re.exec(prose);
    if (headerMatch) {
      const after = prose.slice(headerMatch.index + headerMatch[0].length).trim();
      const para  = after.split(/\n{2,}/)[0].replace(/\n/g, " ").trim();
      if (para.length > 10) return truncate(para, maxLen);
    }
  }

  // 2. Inline keyword at start of a line
  for (const re of SUMMARY_INLINE) {
    const m = re.exec(prose);
    if (m && m[1]?.trim().length > 10) return truncate(m[1].trim(), maxLen);
  }

  // 3. First non-trivial paragraph (≥ 30 chars, ≥ 5 words) — last resort
  const paras = prose.split(/\n{2,}/).map(p => p.replace(/\n/g, " ").trim());
  for (const p of paras) {
    if (p.length >= 30 && p.split(/\s+/).length >= 5 && !p.startsWith("#")) {
      return truncate(p, maxLen);
    }
  }

  return null;
}

// ── 3d. Actions ────────────────────────────────

// Past-tense action verbs that signal a concrete change was made
const ACTION_VERBS =
  "added|modified|removed|updated|created|deleted|fixed|refactored|changed|" +
  "renamed|moved|extracted|replaced|implemented|converted|migrated|" +
  "improved|simplified|optimized|restructured|rewrote|resolved|addressed";

const ACTION_VERB_RE = new RegExp(
  `^(?:[-*•]\\s+|\\d+\\.\\s+)?((?:${ACTION_VERBS})[^\\n]{5,})`,
  "im"
);

function extractActions(text: string): string[] {
  const prose   = text.replace(/```[\s\S]*?```/g, "");
  const actions = new Set<string>();

  // 1. Bullet / numbered list items
  const listRe = /^[ \t]*(?:[-*•]|\d+\.)\s+(.{10,})/gm;
  let m: RegExpExecArray | null;
  while ((m = listRe.exec(prose)) !== null) {
    const item = m[1].trim();
    // Only keep items that look like actions (start with a verb or noun phrase)
    if (/^[A-Z]/.test(item) || new RegExp(`^(${ACTION_VERBS})`, "i").test(item)) {
      actions.add(item);
    }
  }

  // 2. Standalone action-verb sentences
  const lines = prose.split("\n");
  for (const line of lines) {
    const clean = line.trim();
    if (new RegExp(`^(${ACTION_VERBS})\\b`, "i").test(clean) && clean.length > 15) {
      actions.add(clean.replace(/[.!]+$/, "").trim());
    }
  }

  return [...actions].slice(0, 20);  // cap to avoid noise
}

// ── 3e. Notes / warnings ──────────────────────

const NOTE_RE = /^[ \t]*(?:note|warning|important|caveat|caution|todo|fixme)[:\s]+(.+)/gim;
const BLOCKQUOTE_RE = /^[ \t]*>\s+(.+)/gm;

function extractNotes(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, "");
  const notes = new Set<string>();

  let m: RegExpExecArray | null;
  while ((m = NOTE_RE.exec(prose)) !== null)       notes.add(m[1].trim());
  while ((m = BLOCKQUOTE_RE.exec(prose)) !== null) notes.add(m[1].trim());

  return [...notes];
}

// ─────────────────────────────────────────────
// Stage 4 — Confidence scoring
// ─────────────────────────────────────────────

function scoreConfidence(out: Omit<ParsedOutput, "confidence" | "parse_warnings">): number {
  let score = 0;
  if (out.raw_json !== null)        score += 0.45;
  if (out.code_blocks.length > 0)   score += 0.25;
  if (out.actions.length >= 3)      score += 0.20;
  else if (out.actions.length > 0)  score += 0.10;
  if (out.summary !== null)         score += 0.10;
  return Math.max(0.05, Math.min(1.0, score));
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

export function parse(raw: string, opts: ParserOptions = {}): ParsedOutput {
  const maxSummaryLen  = opts.max_summary_length ?? 300;
  const preserveAnsi   = opts.preserve_ansi      ?? false;
  const warnings:   string[] = [];

  // ── Stage 1: Clean ──────────────────────────
  let text = normalizeLineEndings(raw);
  if (!preserveAnsi) text = stripAnsi(text);

  // Unwrap Claude CLI's outer JSON envelope if present
  const { text: inner, envelope } = unwrapClaudeEnvelope(text);
  if (envelope) {
    warnings.push("Claude CLI envelope unwrapped; parsing inner result string.");
    text = inner;
  }

  // ── Stage 2: Detect ─────────────────────────
  const source_type = detectSourceType(text);

  // ── Stage 3: Extract ────────────────────────
  const raw_json    = extractJson(text);
  const code_blocks = extractCodeBlocks(text, preserveAnsi);
  const actions     = extractActions(text);
  const notes       = extractNotes(text);

  // Summary: prefer semantic fields from extracted JSON, then fall back to prose
  let summary: string | null = null;
  if (raw_json && typeof raw_json === "object" && !Array.isArray(raw_json)) {
    const j = raw_json as Record<string, unknown>;
    // Ranked preference: most-to-least descriptive field names
    const candidate = j["summary"] ?? j["description"] ?? j["explanation"] ?? j["result"] ?? j["message"];
    if (typeof candidate === "string" && candidate.trim().length > 5) {
      summary = truncate(candidate.trim(), maxSummaryLen);
    }
  }
  // Don't fall back to prose extraction when source is direct JSON — the raw text
  // is the JSON literal itself and would produce a useless stringified summary.
  if (!summary && source_type !== "json") summary = extractSummary(text, maxSummaryLen);

  if (raw_json === null && source_type === "prose" && !summary) {
    warnings.push("No structured content detected; output is pure prose.");
  }

  // ── Stage 4: Score ──────────────────────────
  const partial = { source_type, summary, code_blocks, actions, notes, raw_json };
  const confidence = scoreConfidence(partial);

  return { ...partial, confidence, parse_warnings: warnings };
}

/**
 * Convenience wrapper with tool-specific hints.
 * Claude: unwraps envelopes, expects fenced JSON.
 * Codex: expects direct JSON or bare code blocks.
 */
export function parseForTool(
  raw:  string,
  tool: "claude" | "codex" | "generic",
  opts: Omit<ParserOptions, "tool"> = {},
): ParsedOutput {
  return parse(raw, { ...opts, tool });
}

// ─────────────────────────────────────────────
// Raw → Parsed examples
// ─────────────────────────────────────────────

interface Example {
  label:       string;
  tool:        "claude" | "codex" | "generic";
  raw:         string;
}

export const EXAMPLES: Example[] = [
  // ── 1. Claude CLI envelope wrapping fenced JSON ──────────────────────
  {
    label: "1 · Claude CLI envelope + fenced JSON",
    tool:  "claude",
    raw: JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      result: [
        "Here are the changes I made:\n",
        "```json",
        JSON.stringify({
          summary: "Converted all callback-based DB calls to async/await",
          changes: "Modified src/db/users.js and src/db/posts.js",
          code: "async function getUser(id) {\n  return await db.users.findOne({ id });\n}",
          notes: "Requires Node >= 14 for top-level await.",
          files_modified: ["src/db/users.js", "src/db/posts.js"],
        }, null, 2),
        "```",
      ].join("\n"),
    }),
  },

  // ── 2. Mixed prose + code + action bullets ───────────────────────────
  {
    label: "2 · Mixed prose — refactor with action list",
    tool:  "claude",
    raw: `I've completed the JWT migration. Here is a summary of what changed:

## Summary
Replaced session-based auth with stateless JWT tokens across the API layer.

## Changes Made
- Added jsonwebtoken and express-jwt dependencies
- Removed connect-redis and express-session packages
- Refactored authController.js to sign and verify JWT tokens
- Updated middleware/auth.js to extract bearer tokens from Authorization header
- Modified all protected routes to use the new middleware

\`\`\`javascript
// middleware/auth.js
const jwt = require('jsonwebtoken');
module.exports = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(403).json({ error: 'Invalid token' });
  }
};
\`\`\`

Note: Set JWT_SECRET in all environments before deploying.
Warning: Existing sessions will be invalidated immediately on deploy.`,
  },

  // ── 3. Codex bare code block with minimal prose ──────────────────────
  {
    label: "3 · Codex — bare code block, minimal prose",
    tool:  "codex",
    raw: `Here's the email validator:

\`\`\`typescript
export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function validateEmailStrict(email: string): boolean {
  const re = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
  return re.test(email.trim());
}
\`\`\``,
  },

  // ── 4. ANSI-polluted output with numbered list ───────────────────────
  {
    label: "4 · ANSI escape codes + numbered action list",
    tool:  "claude",
    raw: "\x1b[32m✓ Done\x1b[0m\n\nI fixed the race condition. Changes made:\n\n" +
      "1. Added mutex lock to updateCart() to prevent concurrent writes\n" +
      "2. Removed the stale setTimeout workaround in checkout.js\n" +
      "3. Fixed missing await in processPayment() that caused silent failures\n\n" +
      "```diff\n- setTimeout(() => updateCart(id), 100);\n" +
      "+ await withLock(cartId, () => updateCart(id));\n```\n\n" +
      "Important: Deploy the lock service before this code or writes will queue indefinitely.",
  },

  // ── 5. Pure prose — no code, no structure ────────────────────────────
  {
    label: "5 · Pure prose — no structure, fallback path",
    tool:  "generic",
    raw: `The code looks reasonable but has a few issues worth addressing.
Error handling is inconsistent — some functions use try/catch while others
silently swallow errors via empty catch blocks. The fetchUser function does
not validate its input before making the database call, which could cause
unexpected behaviour with null or undefined values. You might also consider
extracting the retry logic into a shared utility rather than duplicating it
across three different service files.`,
  },

  // ── 6. Direct JSON response (no fence, no prose) ─────────────────────
  {
    label: "6 · Direct JSON — Codex structured response",
    tool:  "codex",
    raw: JSON.stringify({
      code:        "function debounce(fn, delay) {\n  let t;\n  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };\n}",
      language:    "javascript",
      filename:    "src/utils/debounce.js",
      explanation: "Returns a debounced version of fn that delays invocation until delay ms have elapsed since the last call.",
    }, null, 2),
  },
];

export function runExamples(): void {
  for (const ex of EXAMPLES) {
    const result = parseForTool(ex.raw, ex.tool);
    const bar    = "█".repeat(Math.round(result.confidence * 20)).padEnd(20, "░");

    console.log(`\n${"─".repeat(64)}`);
    console.log(`Example : ${ex.label}`);
    console.log(`Source  : ${result.source_type.padEnd(12)} Confidence: ${bar} ${(result.confidence * 100).toFixed(0)}%`);

    if (result.parse_warnings.length) {
      console.log(`Warnings: ${result.parse_warnings.join(" | ")}`);
    }
    if (result.summary) {
      console.log(`Summary : ${result.summary}`);
    }
    if (result.code_blocks.length) {
      const langs = result.code_blocks.map(b => b.language ?? "?").join(", ");
      const preview = result.code_blocks[0].code.split("\n")[0];
      console.log(`Code    : [${result.code_blocks.length} block(s): ${langs}] → ${preview}`);
    }
    if (result.actions.length) {
      console.log(`Actions : ${result.actions.slice(0, 3).join(" | ")}${result.actions.length > 3 ? ` (+${result.actions.length - 3} more)` : ""}`);
    }
    if (result.notes.length) {
      console.log(`Notes   : ${result.notes.join(" | ")}`);
    }
    if (result.raw_json) {
      const keys = Object.keys(result.raw_json as object).join(", ");
      console.log(`JSON    : { ${keys} }`);
    }
  }
  console.log(`\n${"─".repeat(64)}`);
}

// ts-node --esm output-parser.ts
const _self = (await import("url")).fileURLToPath(import.meta.url);
if (process.argv[1] === _self) runExamples();
