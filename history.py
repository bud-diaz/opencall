"""
History Manager
- Per user, global across all agents
- Persisted to JSON on disk so history survives bot restarts
- Capped at MAX_TURNS to prevent context bloat
"""

import json
import os
from pathlib import Path

HISTORY_DIR = Path("./data/history")
MAX_TURNS = 40  # max messages to keep per user (user+assistant pairs)


class HistoryManager:
    def __init__(self):
        HISTORY_DIR.mkdir(parents=True, exist_ok=True)
        self._cache: dict[str, list] = {}

    def _path(self, user_id: str) -> Path:
        return HISTORY_DIR / f"{user_id}.json"

    def get(self, user_id: str) -> list:
        """Load history for a user. Returns a mutable list."""
        if user_id in self._cache:
            return list(self._cache[user_id])  # return copy

        path = self._path(user_id)
        if path.exists():
            try:
                with open(path) as f:
                    history = json.load(f)
                self._cache[user_id] = history
                return list(history)
            except (json.JSONDecodeError, IOError):
                pass

        self._cache[user_id] = []
        return []

    def save(self, user_id: str, messages: list):
        """Save updated history, trimming to MAX_TURNS."""
        # Keep only the last MAX_TURNS messages
        trimmed = messages[-MAX_TURNS:]
        self._cache[user_id] = trimmed

        path = self._path(user_id)
        try:
            with open(path, "w") as f:
                json.dump(trimmed, f, indent=2)
        except IOError as e:
            print(f"Warning: could not save history for {user_id}: {e}")

    def clear(self, user_id: str):
        """Wipe history for a user."""
        self._cache.pop(user_id, None)
        path = self._path(user_id)
        if path.exists():
            path.unlink()

    def summary(self, user_id: str) -> str:
        """Return a quick summary of how much history exists."""
        history = self.get(user_id)
        if not history:
            return "No history yet."
        return f"{len(history)} messages in history."
