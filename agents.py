"""
Agent definitions.
Each agent has:
  - name / role / persona (injected into system prompt)
  - preferred Ollama model
  - tool access list
  - unrestricted flag (bypasses workspace sandbox for file/shell ops)
"""

import ollama
import json
from history import HistoryManager
from tools import TOOL_SCHEMAS, execute_tool


# ── Crew roster description (injected into every agent's system prompt) ──────

CREW_DESCRIPTION = """You are part of a 5-agent crew called Pearl Crew. Know your teammates:

- Pearl   (Orchestrator & Visionary)     — strategic lead, routes tasks, full device access
- Corey   (Creative & Artist)            — copy, concepts, storytelling, brand voice
- Midas   (Marketing & Brand Builder)    — growth, go-to-market, social, positioning
- Rain    (Technical Engineer)           — code, debugging, architecture, shell, full device access
- Levy    (Monetization, Legal & Compliance) — revenue models, legal risk, accounting

When a question involves another agent's domain, name them specifically and suggest the user ask them directly (e.g. "That's Levy's territory — ask her in #levy").
Never refer to teammates as "Agent #1", "another agent", or anonymously. Always use their names.
"""


# ── Agent class ──────────────────────────────────────────────────────────────

class Agent:
    def __init__(self, name: str, role: str, persona: str, model: str, tools: list[str], unrestricted: bool = False):
        self.name = name
        self.role = role
        self.persona = persona
        self.model = model
        self.allowed_tools = tools
        self.unrestricted = unrestricted

    @property
    def system_prompt(self) -> str:
        tool_names = ", ".join(self.allowed_tools) if self.allowed_tools else "none"
        sandbox_note = (
            "You have UNRESTRICTED file and shell access — you can read, write, and run commands anywhere on the device, not just the workspace folder."
            if self.unrestricted
            else "File access is sandboxed to the ./workspace/ directory."
        )
        return (
            f"You are {self.name}, {self.role}.\n"
            f"{self.persona}\n\n"
            f"{CREW_DESCRIPTION}\n"
            f"Available tools: {tool_names}.\n"
            f"{sandbox_note}\n"
            f"Be direct, focused, and true to your role."
        )

    @property
    def tool_schemas(self) -> list[dict]:
        return [s for s in TOOL_SCHEMAS if s["function"]["name"] in self.allowed_tools]

    async def respond(
        self,
        user_id: str,
        user_name: str,
        content: str,
        history: HistoryManager,
        extra_context: str = "",
    ) -> str:
        messages = history.get(user_id)

        user_content = content
        if extra_context:
            user_content = f"[Context from Pearl: {extra_context}]\n\n{content}"

        messages.append({"role": "user", "content": f"{user_name}: {user_content}"})

        MAX_TOOL_ROUNDS = 5
        for _ in range(MAX_TOOL_ROUNDS):
            response = ollama.chat(
                model=self.model,
                messages=[{"role": "system", "content": self.system_prompt}] + messages,
                tools=self.tool_schemas if self.tool_schemas else None,
            )

            msg = response.message

            if msg.tool_calls:
                messages.append({
                    "role": "assistant",
                    "content": msg.content or "",
                    "tool_calls": [
                        {"function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                        for tc in msg.tool_calls
                    ]
                })

                for tc in msg.tool_calls:
                    tool_name = tc.function.name
                    tool_args = tc.function.arguments

                    if tool_name not in self.allowed_tools:
                        result = f"Error: {self.name} does not have access to tool '{tool_name}'."
                    else:
                        result = execute_tool(tool_name, tool_args, unrestricted=self.unrestricted)

                    messages.append({
                        "role": "tool",
                        "content": str(result),
                    })
            else:
                final = msg.content or "(no response)"
                messages.append({"role": "assistant", "content": final})
                history.save(user_id, messages)
                return f"**{self.name}:** {final}"

        history.save(user_id, messages)
        return f"**{self.name}:** I ran into a loop trying to complete that. Try rephrasing?"


# ── Agent roster ─────────────────────────────────────────────────────────────

AGENTS: dict[str, Agent] = {

    "pearl": Agent(
        name="Pearl",
        role="Orchestrator & Visionary",
        persona=(
            "You are the leader of this crew. You think strategically, see the big picture, "
            "and make sure the right agent handles the right task. "
            "When answering directly, you're decisive and clear. "
            "You have full unrestricted access to the device."
        ),
        model="dolphin-llama3",
        tools=["web_search", "read_file", "write_file", "run_shell", "switch_model"],
        unrestricted=True,
    ),

    "corey": Agent(
        name="Corey",
        role="Creative & Imaginative Artist",
        persona=(
            "You are the creative engine of the crew. You think in metaphors, aesthetics, "
            "and narrative. You write copy, brainstorm concepts, develop brand voice, "
            "and bring ideas to life. You love bold creative swings."
        ),
        model="dolphin-llama3",
        tools=["web_search", "read_file", "write_file"],
    ),

    "midas": Agent(
        name="Midas",
        role="Marketing, Growth & Brand Builder",
        persona=(
            "You are obsessed with reach, positioning, and conversion. "
            "You think in audiences, funnels, and hooks. "
            "You research competitors, craft go-to-market strategies, "
            "and know how to make things spread."
        ),
        model="dolphin-llama3",
        tools=["web_search", "read_file", "write_file"],
    ),

    "rain": Agent(
        name="Rain",
        role="Technical Problem-Solver & Engineer",
        persona=(
            "You are the builder. You write code, debug systems, design architecture, "
            "and get things working. You're pragmatic — you prefer working solutions "
            "over perfect ones. You run commands when needed and verify with evidence. "
            "You have full unrestricted access to the device."
        ),
        model="dolphin-mistral",
        tools=["web_search", "read_file", "write_file", "run_shell", "switch_model"],
        unrestricted=True,
    ),

    "levy": Agent(
        name="Levy",
        role="Monetization, Legal & Compliance Accountant",
        persona=(
            "You think about risk, revenue, and structure. "
            "You flag legal and compliance concerns, model revenue scenarios, "
            "track costs, and make sure the crew's work actually makes money "
            "without getting anyone in trouble."
        ),
        model="dolphin-llama3",
        tools=["web_search", "read_file", "write_file"],
    ),
}


def get_agent_by_name(name: str) -> Agent:
    if name not in AGENTS:
        raise ValueError(f"No agent named '{name}'")
    return AGENTS[name]
