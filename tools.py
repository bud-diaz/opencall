"""
Tool registry.
Defines tool schemas (sent to model) and execution logic (called by agent loop).

Tools available:
  - web_search     : DuckDuckGo search (no API key needed)
  - read_file      : Read a file from the device
  - write_file     : Write/append a file on the device
  - run_shell      : Run a shell command (sandboxed unless unrestricted=True)
  - switch_model   : Change which Ollama model an agent uses mid-conversation

Agents with unrestricted=True (Pearl, Rain) bypass the workspace sandbox
and can read/write/run anywhere on the device.
"""

import subprocess
import os
import requests
from pathlib import Path

# ── Configurable ─────────────────────────────────────────────────────────────

FILES_ROOT = Path(os.getenv("FILES_ROOT", "./workspace"))
FILES_ROOT.mkdir(parents=True, exist_ok=True)

BLOCKED_COMMANDS = ["rm -rf /", "shutdown", "reboot", "mkfs", ":(){:|:&};:"]


# ── Tool schemas (sent to Ollama) ─────────────────────────────────────────────

TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web using DuckDuckGo. Returns top results as text.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query",
                    }
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read the contents of a file on the device.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to the file. Unrestricted agents can use absolute paths.",
                    }
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write or append content to a file on the device.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to the file. Unrestricted agents can use absolute paths.",
                    },
                    "content": {
                        "type": "string",
                        "description": "Content to write to the file",
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["overwrite", "append"],
                        "description": "Whether to overwrite or append. Defaults to overwrite.",
                    },
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_shell",
            "description": "Run a shell command on the device. Unrestricted agents can run anywhere.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The shell command to run",
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Max seconds to wait. Defaults to 15.",
                    },
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "switch_model",
            "description": "Switch the Ollama model being used mid-conversation.",
            "parameters": {
                "type": "object",
                "properties": {
                    "model_name": {
                        "type": "string",
                        "description": "The Ollama model name to switch to (e.g. 'llama3.1', 'hermes3')",
                    }
                },
                "required": ["model_name"],
            },
        },
    },
]


# ── Tool execution ────────────────────────────────────────────────────────────

def execute_tool(name: str, args: dict, unrestricted: bool = False) -> str:
    try:
        if name == "web_search":
            return tool_web_search(args.get("query", ""))
        elif name == "read_file":
            return tool_read_file(args.get("path", ""), unrestricted=unrestricted)
        elif name == "write_file":
            return tool_write_file(
                args.get("path", ""),
                args.get("content", ""),
                args.get("mode", "overwrite"),
                unrestricted=unrestricted,
            )
        elif name == "run_shell":
            return tool_run_shell(
                args.get("command", ""),
                args.get("timeout", 15),
            )
        elif name == "switch_model":
            return tool_switch_model(args.get("model_name", ""))
        else:
            return f"Unknown tool: {name}"
    except Exception as e:
        return f"Tool error ({name}): {e}"


# ── Individual tool implementations ──────────────────────────────────────────

def tool_web_search(query: str) -> str:
    if not query:
        return "Error: no query provided."
    try:
        resp = requests.get(
            "https://api.duckduckgo.com/",
            params={"q": query, "format": "json", "no_html": 1, "skip_disambig": 1},
            timeout=10,
        )
        data = resp.json()

        results = []

        if data.get("AbstractText"):
            results.append(f"Summary: {data['AbstractText']}")

        for r in data.get("RelatedTopics", [])[:5]:
            if isinstance(r, dict) and r.get("Text"):
                results.append(f"- {r['Text']}")

        if not results:
            return f"No instant results for '{query}'. Try a more specific query."

        return "\n".join(results)
    except Exception as e:
        return f"Search failed: {e}"


def tool_read_file(path: str, unrestricted: bool = False) -> str:
    if not path:
        return "Error: no path provided."

    if unrestricted:
        safe_path = Path(path).expanduser().resolve()
    else:
        safe_path = FILES_ROOT / path
        try:
            safe_path = safe_path.resolve()
            safe_path.relative_to(FILES_ROOT.resolve())
        except ValueError:
            return "Error: path escapes workspace directory. This agent does not have unrestricted access."

    try:
        if not safe_path.exists():
            return f"File not found: {path}"
        content = safe_path.read_text(encoding="utf-8")
        if len(content) > 4000:
            return content[:4000] + "\n\n[...truncated — file is larger than 4000 chars]"
        return content
    except Exception as e:
        return f"Read error: {e}"


def tool_write_file(path: str, content: str, mode: str = "overwrite", unrestricted: bool = False) -> str:
    if not path:
        return "Error: no path provided."

    if unrestricted:
        safe_path = Path(path).expanduser().resolve()
    else:
        safe_path = FILES_ROOT / path
        try:
            safe_path = safe_path.resolve()
            safe_path.relative_to(FILES_ROOT.resolve())
        except ValueError:
            return "Error: path escapes workspace directory. This agent does not have unrestricted access."

    try:
        safe_path.parent.mkdir(parents=True, exist_ok=True)
        write_mode = "a" if mode == "append" else "w"
        with open(safe_path, write_mode, encoding="utf-8") as f:
            f.write(content)
        return f"✓ Written to {safe_path} ({mode})"
    except Exception as e:
        return f"Write error: {e}"


def tool_run_shell(command: str, timeout: int = 15) -> str:
    if not command:
        return "Error: no command provided."

    for blocked in BLOCKED_COMMANDS:
        if blocked in command:
            return f"Error: command contains blocked pattern '{blocked}'."

    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        output = result.stdout + result.stderr
        if not output.strip():
            return f"Command ran with exit code {result.returncode} (no output)"
        return output[:3000]
    except subprocess.TimeoutExpired:
        return f"Error: command timed out after {timeout}s"
    except Exception as e:
        return f"Shell error: {e}"


def tool_switch_model(model_name: str) -> str:
    if not model_name:
        return "Error: no model name provided."
    return f"SWITCH_MODEL:{model_name}"
