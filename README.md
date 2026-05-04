# OpenClaw Tool-Calling Architecture
## Claude Code + Codex via Terminal (Hybrid Local Stack)
## 1. Overview
This system treats external AI providers (Claude Code, Codex) as **tools**, not primary models.
OpenClaw acts as:
- Orchestrator
- Router
- Execution engine
Local LLM (Ollama) acts as:
- Primary reasoning layer
- Decision-maker for tool usage
External CLIs act as:
- Specialized execution engines
---
## 2. Core Philosophy
> "Cheap brain. Expensive specialists on demand."
- Local model handles:
  - Planning
  - Lightweight reasoning
  - Task decomposition
- Claude Code handles:
  - Deep refactors
  - Multi-file edits
  - Codebase-aware transformations
- Codex handles:
  - Fast generation
  - Boilerplate
  - Tests / snippets
---
## 3. System Architecture
User Input
↓
OpenClaw Agent Loop
↓
Local Model (Ollama)
↓ decision
Tool Call OR Local Execution
↓
[ Tool Layer ]
├── Claude CLI
└── Codex CLI
↓
Output Parsing Layer
↓
Memory / Context Store
↓
Final Response
---
## 4. Tool Definitions
### 4.1 Claude Tool
Command:
claude
Usage:
claude “”
Purpose:
- Complex refactoring
- Codebase reasoning
- Multi-step transformations
---
### 4.2 Codex Tool
Command:
codex
Usage:
codex “”
Purpose:
- Quick code generation
- Test creation
- Small utilities
---
## 5. Tool Config (Example)
```json
{
  "tools": [
    {
      "name": "ask_claude",
      "description": "Use Claude Code for deep code analysis and refactoring",
      "command": "claude",
      "args": ["{{input}}"]
    },
    {
      "name": "ask_codex",
      "description": "Use Codex for fast code generation and lightweight tasks",
      "command": "codex",
      "args": ["{{input}}"]
    }
  ]
}
6. Decision Rules (Baseline)
Use LOCAL MODEL when:
	•	Task is simple
	•	Requires explanation
	•	No file system interaction needed
	•	Planning or breakdown is required
Use CLAUDE when:
	•	Multi-file edits required
	•	Refactoring existing code
	•	Debugging complex logic
	•	Context-heavy reasoning needed
Use CODEX when:
	•	Generating new code from scratch
	•	Writing tests
	•	Creating small utilities
	•	Fast iteration needed
7. Output Handling
Problem:
	•	CLI outputs are unstructured
Solution:
	•	Enforce structured responses
Example Prompt Wrapper:
Return output in JSON:
{
  "summary": "...",
  "changes": "...",
  "code": "...",
  "notes": "..."
}
Optional:
	•	Pipe through parser
	•	Normalize before returning to agent loop
8. Context Strategy
Each CLI call is stateless.
To maintain continuity:
	•	Pass relevant context in every call
	•	Store summaries in memory layer
	•	Optionally log to:
	•	Markdown files
	•	Obsidian vault
	•	SQLite store
9. Rate Limiting Strategy
	•	Avoid repeated calls
	•	Cache responses when possible
	•	Add cooldown logic:
	•	Max X tool calls per task
	•	Escalation only when needed
10. Future Enhancements
	•	Automatic tool selection (confidence scoring)
	•	Tool chaining (Claude → Codex → Local)
	•	Structured diff parsing
	•	File-aware execution context
	•	Parallel tool execution
11. Example Flow
User:
“Refactor this project to use async/await”
Flow:
	1.	Local model analyzes complexity
	2.	Determines task is complex
	3.	Calls ask_claude
	4.	Claude returns refactored code
	5.	Output parsed + stored
	6.	Response returned to user
12. Key Takeaway
This is NOT a single-model system.
It is:
	A coordinated multi-agent execution environment with tool-based specialization
---
