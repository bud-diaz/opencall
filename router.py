"""
Pearl's routing logic for the hub channel.
Pearl reads the message, decides which agent is best suited,
then hands off with context.
"""

import ollama
import json
from history import HistoryManager


ROUTING_PROMPT = """You are Pearl, the orchestrator of a 5-agent crew.

Your crew:
- pearl   → Strategy, leadership, big-picture decisions, complex multi-part tasks
- corey   → Creative writing, copy, concepts, storytelling, brand voice
- midas   → Marketing, growth, audience, go-to-market, social strategy
- rain    → Code, technical problems, debugging, architecture, shell commands
- levy    → Money, legal, compliance, revenue models, risk, accounting

Given the user's message, respond ONLY with a JSON object like this:
{
  "agent": "<agent_name>",
  "reason": "<one sentence why>",
  "context": "<any helpful framing to pass to that agent, or empty string>"
}

Pick exactly one agent. If the task spans multiple agents, pick the one who should lead it.
If it's truly strategic or multi-part, route to pearl.
"""


class Pearl:
    def __init__(self, history: HistoryManager):
        self.history = history
        self.routing_model = "dolphin3"

    async def route_and_respond(self, user_id: str, user_name: str, content: str) -> str:
        # Step 1: Ask Pearl to decide routing
        routing_response = ollama.chat(
            model=self.routing_model,
            messages=[
                {"role": "system", "content": ROUTING_PROMPT},
                {"role": "user", "content": content},
            ],
        )

        raw = routing_response.message.content.strip()

        try:
            # Strip markdown fences if model wraps in ```json
            if raw.startswith("```"):
                raw = raw.split("```")[1]
                if raw.startswith("json"):
                    raw = raw[4:]
            decision = json.loads(raw.strip())
            agent_name = decision.get("agent", "pearl")
            context = decision.get("context", "")
            reason = decision.get("reason", "")
        except (json.JSONDecodeError, KeyError):
            # Routing failed — Pearl handles it herself
            agent_name = "pearl"
            context = ""
            reason = "routing parse failed"

        # Import here to avoid circular import
        from agents import get_agent_by_name

        try:
            agent = get_agent_by_name(agent_name)
        except ValueError:
            from agents import AGENTS
            agent = AGENTS["pearl"]

        # Step 2: Let the chosen agent actually respond
        response = await agent.respond(
            user_id=user_id,
            user_name=user_name,
            content=content,
            history=self.history,
            extra_context=context,
        )

        # Prepend routing attribution
        route_note = f"*→ routed to {agent.name} ({reason})*\n\n"
        return route_note + response
