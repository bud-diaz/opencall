#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# openclaw.sh — OpenClaw unified CLI
#
# Usage:
#   ./openclaw.sh "task description"  [OPTIONS]
#   ./openclaw.sh --setup
#   ./openclaw.sh --log [--last N]
#   ./openclaw.sh --help
#
# Options:
#   -c, --complexity N    Task complexity 0–10  (default: 5)
#   -u, --urgency LEVEL   low | medium | high   (default: medium)
#   -f, --files           Task involves existing files
#   -x, --context N       Context size in tokens (default: 1000)
#   -p, --prompt TEXT     Full prompt (defaults to task description)
#   -j, --json            Print raw JSON output instead of formatted summary
#       --setup           Run prerequisite checks and one-time setup
#       --log             Print call history from memory/tool-calls.jsonl
#       --last N          With --log: show last N entries (default: 10)
#       --help            Show this help
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Paths ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ENV_FILE="$SCRIPT_DIR/.env"
MEMORY_FILE="$SCRIPT_DIR/memory/tool-calls.jsonl"

# ── Colors (disabled if not a TTY) ───────────────────────────────────────────
if [ -t 1 ]; then
  BOLD="\033[1m"; DIM="\033[2m"; RESET="\033[0m"
  GREEN="\033[32m"; RED="\033[31m"; YELLOW="\033[33m"
  CYAN="\033[36m"; BLUE="\033[34m"; MAGENTA="\033[35m"
else
  BOLD=""; DIM=""; RESET=""
  GREEN=""; RED=""; YELLOW=""
  CYAN=""; BLUE=""; MAGENTA=""
fi

# ── Helpers ───────────────────────────────────────────────────────────────────
die()  { echo -e "${RED}✗ $*${RESET}" >&2; exit 1; }
ok()   { echo -e "${GREEN}✓ $*${RESET}"; }
warn() { echo -e "${YELLOW}⚠ $*${RESET}"; }
info() { echo -e "${CYAN}→ $*${RESET}"; }
hdr()  { echo -e "\n${BOLD}${BLUE}$*${RESET}"; }

# ── Load .env if present ──────────────────────────────────────────────────────
if [ -f "$ENV_FILE" ]; then
  # Export key=value lines, skip comments and blanks
  set -o allexport
  # shellcheck disable=SC1090
  source <(grep -E '^[A-Z_]+=.+' "$ENV_FILE" | grep -v '^#')
  set +o allexport
fi

# ── Build JSON input using Node (avoids jq/python escaping edge-cases) ────────
build_json() {
  local description="$1" complexity="$2" urgency="$3" \
        file_involvement="$4" context_size="$5" prompt="$6"
  node --input-type=module <<JS
const obj = {
  description:      ${description@Q},
  complexity:       Number(${complexity@Q}),
  urgency:          ${urgency@Q},
  file_involvement: ${file_involvement@Q} === "true",
  context_size:     Number(${context_size@Q}),
};
if (${prompt@Q}) obj.prompt = ${prompt@Q};
process.stdout.write(JSON.stringify(obj));
JS
}

# ── Pretty-print a runtime result JSON string ─────────────────────────────────
print_result() {
  local json="$1"

  local path success confidence cost_tier response error fallback
  path=$(echo "$json"      | jq -r '.selected_path')
  success=$(echo "$json"   | jq -r '.success')
  confidence=$(echo "$json"| jq -r '(.decision.confidence * 100 | round | tostring) + "%"')
  cost_tier=$(echo "$json" | jq -r '.decision.cost_tier')
  fallback=$(echo "$json"  | jq -r '.decision.fallback_path')
  response=$(echo "$json"  | jq -r '.response // empty')
  error=$(echo "$json"     | jq -r '.error // empty')

  # Path badge
  case "$path" in
    local_llm) badge="${DIM}[ LOCAL ]${RESET}" ;;
    claude)    badge="${MAGENTA}[CLAUDE ]${RESET}" ;;
    codex)     badge="${BLUE}[ CODEX ]${RESET}" ;;
    *)         badge="$path" ;;
  esac

  # Confidence bar (20 chars)
  local pct score
  pct=$(echo "$json" | jq '.decision.confidence * 100 | round')
  score=$(( pct / 5 ))
  local bar=""
  for (( i=0; i<20; i++ )); do
    [ $i -lt $score ] && bar+="█" || bar+="░"
  done

  echo ""
  echo -e "  ${BOLD}Path     :${RESET} $badge  (fallback → $fallback)"
  echo -e "  ${BOLD}Cost     :${RESET} $cost_tier"
  echo -e "  ${BOLD}Confidence:${RESET} $bar $confidence"

  if [ "$success" = "true" ]; then
    echo -e "  ${BOLD}Status   :${RESET} ${GREEN}success${RESET}"
  else
    echo -e "  ${BOLD}Status   :${RESET} ${RED}failed${RESET}"
  fi

  # Reasoning (last line only)
  local reasoning
  reasoning=$(echo "$json" | jq -r '.decision.reasoning[-1] // empty')
  if [ -n "$reasoning" ]; then
    echo -e "  ${BOLD}Routing  :${RESET} ${DIM}$reasoning${RESET}"
  fi

  # Response / error
  if [ -n "$response" ]; then
    echo ""
    echo -e "  ${BOLD}Response :${RESET}"
    echo "$response" | fold -s -w 76 | sed 's/^/    /'
  fi

  if [ -n "$error" ]; then
    echo ""
    echo -e "  ${BOLD}Error    :${RESET} ${RED}$error${RESET}"
  fi

  # Code blocks summary
  local nblocks
  nblocks=$(echo "$json" | jq '.parsed.code_blocks | length // 0')
  if [ "$nblocks" -gt 0 ] 2>/dev/null; then
    local langs
    langs=$(echo "$json" | jq -r '[.parsed.code_blocks[].language // "?"] | join(", ")')
    echo ""
    echo -e "  ${BOLD}Code     :${RESET} $nblocks block(s) [$langs]"
    # Preview first block, first 5 lines
    echo -e "${DIM}"
    echo "$json" | jq -r '.parsed.code_blocks[0].code // empty' \
      | head -5 | sed 's/^/    /'
    echo -e "${RESET}"
  fi

  # Actions
  local nactions
  nactions=$(echo "$json" | jq '.parsed.actions | length // 0')
  if [ "$nactions" -gt 0 ] 2>/dev/null; then
    echo -e "  ${BOLD}Actions  :${RESET}"
    echo "$json" | jq -r '.parsed.actions[:5][]' | sed "s/^/    ${GREEN}•${RESET} /"
    [ "$nactions" -gt 5 ] && echo "    ... and $(( nactions - 5 )) more"
  fi

  echo ""
}

# ── --setup mode ──────────────────────────────────────────────────────────────
cmd_setup() {
  hdr "OpenClaw Setup Check"

  local all_ok=true

  # Node
  if command -v node &>/dev/null; then
    local nv; nv=$(node --version)
    ok "Node.js $nv"
  else
    die "Node.js not found. Install from https://nodejs.org (v18+)"
  fi

  # npm deps
  if [ -d "$SCRIPT_DIR/node_modules/tsx" ]; then
    ok "npm dependencies installed (tsx found)"
  else
    warn "node_modules missing — running npm install..."
    npm install
    ok "npm install complete"
  fi

  # claude CLI
  if command -v claude &>/dev/null; then
    ok "claude CLI found at $(command -v claude)"
  else
    warn "claude CLI not found"
    echo "    Install: npm install -g @anthropic-ai/claude-code"
    all_ok=false
  fi

  # codex CLI
  if command -v codex &>/dev/null; then
    ok "codex CLI found at $(command -v codex)"
  else
    warn "codex CLI not found (optional — only needed for the codex path)"
    echo "    Install: npm install -g @openai/codex"
  fi

  # ANTHROPIC_API_KEY
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    ok "ANTHROPIC_API_KEY is set (${#ANTHROPIC_API_KEY} chars)"
  else
    warn "ANTHROPIC_API_KEY not set — claude path will fail"
    echo "    Add to $ENV_FILE:  ANTHROPIC_API_KEY=sk-ant-..."
    all_ok=false
  fi

  # OPENAI_API_KEY
  if [ -n "${OPENAI_API_KEY:-}" ]; then
    ok "OPENAI_API_KEY is set (${#OPENAI_API_KEY} chars)"
  else
    warn "OPENAI_API_KEY not set (optional — only needed for codex path)"
    echo "    Add to $ENV_FILE:  OPENAI_API_KEY=sk-..."
  fi

  # jq
  if command -v jq &>/dev/null; then
    ok "jq found — pretty output enabled"
  else
    warn "jq not found — install with: sudo apt install jq"
    all_ok=false
  fi

  # memory dir
  mkdir -p "$SCRIPT_DIR/memory"
  ok "memory/ directory ready"

  # Smoke test
  hdr "Smoke Test (local_llm path)"
  local test_json='{"description":"test setup","complexity":1,"urgency":"low"}'
  local result
  result=$(echo "$test_json" | npm run --silent openclaw:runtime 2>/dev/null)
  local spath; spath=$(echo "$result" | jq -r '.selected_path')
  local ssuccess; ssuccess=$(echo "$result" | jq -r '.success')

  if [ "$ssuccess" = "true" ] && [ "$spath" = "local_llm" ]; then
    ok "Runtime smoke test passed (local_llm path, no API call)"
  else
    die "Runtime smoke test failed. Check: npm run openclaw:runtime"
  fi

  echo ""
  if [ "$all_ok" = "true" ]; then
    echo -e "${GREEN}${BOLD}All checks passed. OpenClaw is ready.${RESET}"
  else
    echo -e "${YELLOW}${BOLD}Setup complete with warnings. See above.${RESET}"
  fi

  echo ""
  echo "  Quick start:"
  echo '    ./openclaw.sh "Explain what closures are in JavaScript"'
  echo '    ./openclaw.sh "Refactor auth module to use JWT" --complexity 8 --files --urgency low'
  echo ""
}

# ── --log mode ────────────────────────────────────────────────────────────────
cmd_log() {
  local last="${1:-10}"

  if [ ! -f "$MEMORY_FILE" ]; then
    warn "No call history yet. Run a task first."
    exit 0
  fi

  hdr "Call History (last $last entries)"
  echo ""

  local count=0
  while IFS= read -r line; do
    count=$(( count + 1 ))
    local ts path success confidence cost outcome desc
    ts=$(echo "$line"         | jq -r '.timestamp')
    path=$(echo "$line"       | jq -r '.selected_path')
    success=$(echo "$line"    | jq -r '.success')
    confidence=$(echo "$line" | jq -r '(.decision_confidence * 100 | round | tostring) + "%"')
    cost=$(echo "$line"       | jq -r '.cost_tier')
    outcome=$(echo "$line"    | jq -r '.outcome')
    desc=$(echo "$line"       | jq -r '.task_description' | cut -c1-60)

    if [ "$success" = "true" ]; then
      status="${GREEN}✓${RESET}"
    else
      status="${RED}✗${RESET}"
    fi

    printf "  %s  ${DIM}%s${RESET}  %-10s  conf:%-5s  cost:%-5s  %s  %s\n" \
      "$status" "$ts" "$path" "$confidence" "$cost" "$outcome" "$desc"
  done < <(tail -"$last" "$MEMORY_FILE")

  echo ""
  echo -e "  ${DIM}Full log: $MEMORY_FILE${RESET}"
  echo ""
}

# ── --help ────────────────────────────────────────────────────────────────────
cmd_help() {
  echo ""
  echo -e "${BOLD}OpenClaw — AI Task Routing CLI${RESET}"
  echo ""
  echo "  Routes tasks to local_llm, claude, or codex based on complexity"
  echo "  and context. Logs every call to memory/tool-calls.jsonl."
  echo ""
  echo -e "${BOLD}Usage:${RESET}"
  echo '  ./openclaw.sh "task description"  [OPTIONS]'
  echo '  ./openclaw.sh --setup'
  echo '  ./openclaw.sh --log [--last N]'
  echo ""
  echo -e "${BOLD}Task options:${RESET}"
  echo '  -c, --complexity N    0–10, how hard is this task? (default: 5)'
  echo '  -u, --urgency LEVEL   low | medium | high            (default: medium)'
  echo '  -f, --files           Task reads or modifies existing files'
  echo '  -x, --context N       Estimated token count          (default: 1000)'
  echo '  -p, --prompt TEXT     Full prompt (defaults to task description)'
  echo '  -j, --json            Print raw JSON output'
  echo ""
  echo -e "${BOLD}Examples:${RESET}"
  echo '  ./openclaw.sh "Explain closures in JavaScript"'
  echo '  ./openclaw.sh "Generate unit tests for UserService" -c 4 -f -u medium'
  echo '  ./openclaw.sh "Refactor auth to JWT" -c 8 -f -x 12000 -u low \'
  echo '    -p "Rewrite auth.js and middleware/verify.js to use JWT tokens"'
  echo '  ./openclaw.sh --setup'
  echo '  ./openclaw.sh --log --last 5'
  echo ""
  echo -e "${BOLD}Environment (.env or exported):${RESET}"
  echo '  ANTHROPIC_API_KEY=sk-ant-...   (required for claude path)'
  echo '  OPENAI_API_KEY=sk-...          (required for codex path)'
  echo ""
}

# ── Argument parsing ──────────────────────────────────────────────────────────
DESCRIPTION=""
COMPLEXITY="5"
URGENCY="medium"
FILES="false"
CONTEXT="1000"
PROMPT=""
JSON_MODE=false
MODE="task"
LOG_LAST="10"

[ $# -eq 0 ] && { cmd_help; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --setup)          MODE="setup"; shift ;;
    --log)            MODE="log"; shift ;;
    --last)           LOG_LAST="$2"; shift 2 ;;
    --help|-h)        cmd_help; exit 0 ;;
    -j|--json)        JSON_MODE=true; shift ;;
    -c|--complexity)  COMPLEXITY="$2"; shift 2 ;;
    -u|--urgency)     URGENCY="$2"; shift 2 ;;
    -f|--files)       FILES="true"; shift ;;
    -x|--context)     CONTEXT="$2"; shift 2 ;;
    -p|--prompt)      PROMPT="$2"; shift 2 ;;
    -*)               die "Unknown option: $1. Run ./openclaw.sh --help" ;;
    *)
      # First positional arg = task description
      if [ -z "$DESCRIPTION" ]; then
        DESCRIPTION="$1"
      else
        die "Unexpected argument: $1"
      fi
      shift ;;
  esac
done

# ── Dispatch ──────────────────────────────────────────────────────────────────
case "$MODE" in
  setup) cmd_setup; exit 0 ;;
  log)   cmd_log "$LOG_LAST"; exit 0 ;;
esac

# Task mode
[ -z "$DESCRIPTION" ] && die "Task description required. Usage: ./openclaw.sh \"your task\""

# Validate urgency
case "$URGENCY" in
  low|medium|high) ;;
  *) die "Invalid urgency: $URGENCY. Must be low, medium, or high." ;;
esac

# Validate complexity
if ! [[ "$COMPLEXITY" =~ ^[0-9]+([.][0-9]+)?$ ]] || \
   (( $(echo "$COMPLEXITY > 10" | bc -l) )) || \
   (( $(echo "$COMPLEXITY < 0" | bc -l) )); then
  die "Complexity must be a number between 0 and 10."
fi

hdr "OpenClaw — Routing Task"
echo -e "  ${BOLD}Task    :${RESET} $DESCRIPTION"
echo -e "  ${BOLD}Options :${RESET} complexity=$COMPLEXITY  urgency=$URGENCY  files=$FILES  context=$CONTEXT"
echo ""

# Build JSON input
INPUT_JSON=$(build_json "$DESCRIPTION" "$COMPLEXITY" "$URGENCY" "$FILES" "$CONTEXT" "$PROMPT")

# Run runtime — stdout = result JSON, stderr = structured logs (suppressed)
info "Running runtime..."
echo ""

RESULT=$(echo "$INPUT_JSON" | npm run --silent openclaw:runtime 2>/dev/null)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  die "Runtime exited with code $EXIT_CODE. Run with 2>&1 to see logs."
fi

# Output
if [ "$JSON_MODE" = "true" ]; then
  echo "$RESULT" | jq .
else
  print_result "$RESULT"
fi
