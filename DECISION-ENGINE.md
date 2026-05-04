# OpenClaw Decision Engine

Routes each incoming task to one of three execution paths without wasting money on heavy tools when lighter ones are sufficient.

| Path | Cost tier | Best for |
|---|---|---|
| `local_llm` | free | Explanation, planning, lightweight reasoning |
| `codex` | low | Fast code generation, tests, stubs, new files |
| `claude` | high | Deep refactoring, debugging, multi-file, security |

---

## Scoring Model

Every task is evaluated across **five signals**. Each signal returns a per-path preference value in `[0, 1]`. The weighted sum determines the winner.

```
total_score(path) = Σ signal_score(path) × weight
```

### Weights

| Signal | Weight | Rationale |
|---|---|---|
| `complexity` | 0.30 | Strongest single predictor of which tool is needed |
| `keyword` | 0.20 | Direct intent from task description |
| `file_context` | 0.20 | File work implies a CLI tool; no files → local viable |
| `context_size` | 0.15 | Large payloads eliminate local and strain Codex |
| `urgency` | 0.15 | High urgency penalises slow tools |

Weights sum to 1.0. Adjusting them here is the primary tuning knob.

---

### Signal Details

#### 1. Complexity (`complexity: 0–10`)

```
local_llm : max(0,  1 − n × 1.5)      → 0 above complexity ≈ 6.7
claude    : n ^ 1.2                    → accelerating preference for hard tasks
codex     : bell-curve centred at 5    → peaks at mid-range, drops off both ends
```

Where `n = complexity / 10`.

| Complexity | local | claude | codex |
|---|---|---|---|
| 1 | 0.85 | 0.09 | 0.72 |
| 4 | 0.40 | 0.33 | 0.80 |
| 7 | 0.00 | 0.63 | 0.72 |
| 9 | 0.00 | 0.88 | 0.44 |

#### 2. File context (boolean)

```
involved=false → local_llm: 0.85, claude: 0.30, codex: 0.65
involved=true  → local_llm: 0.10, claude: 0.90, codex: 0.60
```

File involvement alone doesn't distinguish *existing* (→ Claude) from *new* (→ Codex) — that distinction is resolved by the keyword signal.

#### 3. Context size (tokens)

- **local_llm**: degrades above 4 k tokens, floor 0.05
- **claude**: increases linearly to 1.0 at 16 k tokens
- **codex**: flat 0.70 up to 8 k, then degrades, floor 0.15

#### 4. Urgency

```
high   → local: 0.90  claude: 0.20  codex: 0.75
medium → local: 0.55  claude: 0.60  codex: 0.65
low    → local: 0.35  claude: 0.90  codex: 0.50
```

High urgency strongly penalises Claude (latency); low urgency rewards its thoroughness.

#### 5. Keyword matching (regex)

Three pattern groups scan the task description. When multiple groups match, scores are averaged.

| Group | Example triggers | Scores local / claude / codex |
|---|---|---|
| Explanatory | explain, describe, outline, plan, concept | 0.95 / 0.15 / 0.15 |
| Structural   | refactor, debug, fix bug, migrate, security, auth | 0.10 / 0.95 / 0.25 |
| Generation   | generate, create, write test, endpoint, scaffold | 0.20 / 0.40 / 0.90 |

No match → neutral (0.50 / 0.50 / 0.50).

---

## Post-Processing Rules

### Cost guard
After sorting by total score, if the top paid tool's margin over `local_llm` is ≤ 0.08, `local_llm` is promoted to first place. Prevents paying when the outcome is nearly equivalent.

### Confidence gate
Confidence is computed as the normalised gap between rank-1 and rank-2:

```
confidence = min(1,  (score[0] − score[1]) / 0.25)
```

If `confidence < 0.30` and the winner is not `local_llm`, the decision is overridden to `local_llm` — an ambiguous signal should not trigger expensive tool calls.

### Fallback path
Always the second-ranked path after post-processing. The agent retries on the fallback if the selected path fails (auth error, timeout, quota exceeded).

---

## Decision Flow

```
TaskInput
    │
    ├─ scoreComplexity()
    ├─ scoreFileContext()
    ├─ scoreContextSize()     ─→  weighted sum  →  PathScore[3]
    ├─ scoreUrgency()                                    │
    └─ scoreKeywords()                                   │
                                                    sort desc
                                                         │
                                              ┌──── cost guard ────┐
                                              │  margin ≤ 0.08?    │
                                              │  promote local_llm │
                                              └────────────────────┘
                                                         │
                                           ┌── confidence gate ───┐
                                           │  gap < 0.30?          │
                                           │  override → local_llm │
                                           └───────────────────────┘
                                                         │
                                                    Decision{}
```

---

## Sample Task Decisions

### Task 1 — "Explain what closures are in JavaScript"
```
Input:  complexity=1  file=false  tokens=400  urgency=low
```
| Signal | local | claude | codex |
|---|---|---|---|
| complexity×0.30 | 0.255 | 0.027 | 0.216 |
| file_context×0.20 | 0.170 | 0.060 | 0.130 |
| context_size×0.15 | 0.143 | 0.041 | 0.105 |
| urgency×0.15 | 0.053 | 0.135 | 0.075 |
| keyword×0.20 | 0.190 | 0.030 | 0.030 |
| **Total** | **0.811** | **0.293** | **0.556** |

**→ local_llm** (confidence 100%, cost free)
No files needed. Task is purely explanatory. Local handles it instantly for free.

---

### Task 2 — "Refactor auth module across 8 files to use JWT"
```
Input:  complexity=8  file=true  tokens=12000  urgency=low
```
| Signal | local | claude | codex |
|---|---|---|---|
| complexity×0.30 | 0.000 | 0.222 | 0.174 |
| file_context×0.20 | 0.020 | 0.180 | 0.120 |
| context_size×0.15 | 0.008 | 0.150 | 0.068 |
| urgency×0.15 | 0.053 | 0.135 | 0.075 |
| keyword×0.20 | 0.020 | 0.190 | 0.050 |
| **Total** | **0.101** | **0.877** | **0.487** |

**→ claude** (confidence 100%, cost high)
High complexity eliminates local. "refactor" + file involvement + 12k token context are all decisive Claude signals. Low urgency confirms thoroughness over speed.

---

### Task 3 — "Generate unit tests for the UserService class"
```
Input:  complexity=4  file=true  tokens=2000  urgency=medium
```
| Signal | local | claude | codex |
|---|---|---|---|
| complexity×0.30 | 0.120 | 0.099 | 0.216 |
| file_context×0.20 | 0.020 | 0.180 | 0.120 |
| context_size×0.15 | 0.120 | 0.056 | 0.105 |
| urgency×0.15 | 0.083 | 0.090 | 0.098 |
| keyword×0.20 | 0.040 | 0.080 | 0.180 |
| **Total** | **0.383** | **0.505** | **0.719** |

**→ codex** (confidence 86%, cost low)
"Generate" + "test" pattern strongly signals Codex. Mid-range complexity is Codex's sweet-spot. File involvement is present but the goal is *new* test files, not modifying existing logic.

---

### Task 4 — "Debug intermittent crash in payment webhook"
```
Input:  complexity=7  file=true  tokens=8000  urgency=medium
```
| Signal | local | claude | codex |
|---|---|---|---|
| complexity×0.30 | 0.000 | 0.189 | 0.216 |
| file_context×0.20 | 0.020 | 0.180 | 0.120 |
| context_size×0.15 | 0.015 | 0.113 | 0.105 |
| urgency×0.15 | 0.083 | 0.090 | 0.098 |
| keyword×0.20 | 0.020 | 0.190 | 0.050 |
| **Total** | **0.138** | **0.762** | **0.589** |

**→ claude** (confidence 69%, cost high)
"Debug" + "fix" keywords clearly route to Claude. 8k tokens of webhook code + production crash trace benefit from Claude's context window and reasoning depth. Codex would generate code but can't trace an intermittent bug through existing state.

---

### Task 5 — "Add a password-reset endpoint — ship in 30 min"
```
Input:  complexity=5  file=true  tokens=3000  urgency=high
```
| Signal | local | claude | codex |
|---|---|---|---|
| complexity×0.30 | 0.075 | 0.126 | 0.240 |
| file_context×0.20 | 0.020 | 0.180 | 0.120 |
| context_size×0.15 | 0.105 | 0.066 | 0.105 |
| urgency×0.15 | 0.135 | 0.030 | 0.113 |
| keyword×0.20 | 0.040 | 0.080 | 0.180 |
| **Total** | **0.375** | **0.482** | **0.758** |

**→ codex** (confidence 100%, cost low)
"Add endpoint" is a self-contained generation task. High urgency heavily penalises Claude. Codex scores high on urgency, mid-complexity, and generation keywords. Cost guard doesn't trigger because Codex's margin over local (0.383) is well above 0.08.

---

## Tuning Guide

| Scenario | Adjustment |
|---|---|
| Claude being over-selected | Increase `COST_TOLERANCE` (e.g. 0.12) |
| Codex under-used | Reduce `complexity` weight, increase `urgency` weight |
| Too many low-confidence overrides | Lower `CONFIDENCE_THRESHOLD` (e.g. 0.20) |
| New keyword category needed | Add an entry to `KEYWORD_RULES` in the engine |
| New execution path (e.g. GPT-4) | Add to `ExecutionPath` union, extend all signal scorers |
