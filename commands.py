"""
Built-in slash-style commands any user can run in any agent channel.
Prefix: !crew

Usage:
  !crew help                      — show all commands
  !crew agents                    — list all agents, roles, and current models
  !crew status                    — ping Ollama and show which models are loaded
  !crew tools <agent>             — list tools available to a specific agent
  !crew model <agent> <model>     — hot-swap an agent's Ollama model
  !crew clear                     — wipe your full conversation history
  !crew history                   — show how many messages are in your history
  !crew export                    — save your full history to workspace/history_export.txt
  !crew ls [path]                 — list files in workspace/ (or a subdirectory)
  !crew ping                      — quick check that Ollama is reachable
  !crew reload                    — reload agent definitions from memory (no restart needed)
"""

import os
import ollama
import subprocess
from pathlib import Path
from agents import AGENTS
from history import HistoryManager
from tools import FILES_ROOT

history_manager = HistoryManager()

PREFIX = "!crew"


def is_command(content: str) -> bool:
    return content.strip().lower().startswith(PREFIX)


async def handle_command(content: str, user_id: str, user_name: str) -> str:
    parts = content.strip().split()
    if len(parts) < 2:
        return _help()

    cmd = parts[1].lower()

    # ── !crew help ────────────────────────────────────────────────────────────
    if cmd == "help":
        return _help()

    # ── !crew agents ──────────────────────────────────────────────────────────
    elif cmd == "agents":
        lines = ["**Pearl Crew — Active Agents:**"]
        for name, agent in AGENTS.items():
            lock = "🔓" if agent.unrestricted else "🔒"
            lines.append(f"  {lock} `{name}` — {agent.role} | model: `{agent.model}`")
        lines.append("\n🔓 = unrestricted device access  🔒 = sandboxed to workspace/")
        return "\n".join(lines)

    # ── !crew status ──────────────────────────────────────────────────────────
    elif cmd == "status":
        return _status()

    # ── !crew tools <agent> ───────────────────────────────────────────────────
    elif cmd == "tools":
        if len(parts) < 3:
            return "Usage: `!crew tools <agent_name>`"
        agent_name = parts[2].lower()
        if agent_name not in AGENTS:
            return f"No agent named '{agent_name}'. Try: {', '.join(AGENTS.keys())}"
        agent = AGENTS[agent_name]
        tool_list = "\n".join(f"  • `{t}`" for t in agent.allowed_tools) or "  (none)"
        sandbox = "🔓 unrestricted device access" if agent.unrestricted else "🔒 sandboxed to workspace/"
        return f"**{agent.name}'s tools** ({sandbox}):\n{tool_list}"

    # ── !crew model <agent> <model> ───────────────────────────────────────────
    elif cmd == "model":
        if len(parts) < 4:
            return "Usage: `!crew model <agent_name> <model_name>`"
        agent_name = parts[2].lower()
        model_name = parts[3]
        if agent_name not in AGENTS:
            return f"No agent named '{agent_name}'."
        AGENTS[agent_name].model = model_name
        return f"✓ **{agent_name.capitalize()}**'s model switched to `{model_name}`."

    # ── !crew clear ───────────────────────────────────────────────────────────
    elif cmd == "clear":
        history_manager.clear(user_id)
        return f"✓ History cleared for {user_name}."

    # ── !crew history ─────────────────────────────────────────────────────────
    elif cmd == "history":
        return history_manager.summary(user_id)

    # ── !crew export ──────────────────────────────────────────────────────────
    elif cmd == "export":
        return _export_history(user_id, user_name)

    # ── !crew ls [path] ───────────────────────────────────────────────────────
    elif cmd == "ls":
        target = parts[3] if len(parts) > 2 else "."
        return _ls(target)

    # ── !crew ping ────────────────────────────────────────────────────────────
    elif cmd == "ping":
        return _ping()

    # ── !crew reload ──────────────────────────────────────────────────────────
    elif cmd == "reload":
        # Agents are already live objects — this confirms current state is active
        count = len(AGENTS)
        names = ", ".join(AGENTS.keys())
        return f"✓ {count} agents active: {names}. (No restart needed — models and settings are live.)"

    else:
        return f"Unknown command `{cmd}`. Try `!crew help`."


# ── Helper functions ──────────────────────────────────────────────────────────

def _help() -> str:
    return (
        "**!crew commands:**\n"
        "  `!crew agents` — list all agents, roles, and models\n"
        "  `!crew status` — check Ollama and loaded models\n"
        "  `!crew tools <agent>` — show what tools an agent has\n"
        "  `!crew model <agent> <model>` — hot-swap an agent's model\n"
        "  `!crew ping` — quick Ollama health check\n"
        "  `!crew ls [path]` — list files in workspace/\n"
        "  `!crew history` — show how many messages are in your history\n"
        "  `!crew export` — save your history to workspace/\n"
        "  `!crew clear` — wipe your conversation history\n"
        "  `!crew reload` — confirm agents are live without restarting\n"
        "  `!crew help` — show this message"
    )


def _status() -> str:
    lines = ["**Pearl Crew — System Status:**\n"]

    # Ollama reachability
    try:
        models = ollama.list()
        loaded = [m.model for m in models.models]
        lines.append("🟢 Ollama is reachable")
        if loaded:
            lines.append(f"**Loaded models:** {', '.join(loaded)}")
        else:
            lines.append("No models currently loaded.")
    except Exception as e:
        lines.append(f"🔴 Ollama unreachable: `{e}`")
        return "\n".join(lines)

    # Agent model assignments
    lines.append("\n**Agent model assignments:**")
    for name, agent in AGENTS.items():
        status = "✓" if agent.model in loaded else "⚠️ not loaded"
        lines.append(f"  `{name}` → `{agent.model}` {status}")

    return "\n".join(lines)


def _ping() -> str:
    try:
        ollama.list()
        return "🟢 Ollama is up and responding."
    except Exception as e:
        return f"🔴 Ollama is not responding: `{e}`"


def _ls(target: str = ".") -> str:
    try:
        base = FILES_ROOT / target if target != "." else FILES_ROOT
        base = base.resolve()
        # Keep ls sandboxed to workspace for safety
        base.relative_to(FILES_ROOT.resolve())
        if not base.exists():
            return f"Path not found: {target}"
        entries = sorted(base.iterdir(), key=lambda p: (p.is_file(), p.name))
        if not entries:
            return f"`{target}` is empty."
        lines = [f"📁 `{target}/`"]
        for entry in entries:
            icon = "📄" if entry.is_file() else "📁"
            size = f"({entry.stat().st_size} bytes)" if entry.is_file() else ""
            lines.append(f"  {icon} `{entry.name}` {size}")
        return "\n".join(lines)
    except ValueError:
        return "Error: path escapes workspace directory."
    except Exception as e:
        return f"ls error: {e}"


def _export_history(user_id: str, user_name: str) -> str:
    history = history_manager.get(user_id)
    if not history:
        return "No history to export."
    try:
        export_path = FILES_ROOT / f"history_export_{user_id}.txt"
        lines = [f"History export for {user_name}\n{'='*40}\n"]
        for msg in history:
            role = msg.get("role", "?").upper()
            content = msg.get("content", "")
            lines.append(f"[{role}]\n{content}\n")
        export_path.write_text("\n".join(lines), encoding="utf-8")
        return f"✓ History exported to `workspace/history_export_{user_id}.txt` ({len(history)} messages)."
    except Exception as e:
        return f"Export failed: {e}"
