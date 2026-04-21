from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict


@dataclass(frozen=True)
class Theme:
    name: str
    data: Dict[str, Any]

    def get(self, *path: str, default: Any = None) -> Any:
        node: Any = self.data
        for part in path:
            if not isinstance(node, dict):
                return default
            node = node.get(part)
            if node is None:
                return default
        return node


class ThemeManager:
    def __init__(self, default_theme_path: str):
        self.default_theme_path = Path(default_theme_path)
        self.theme = self.load_theme(str(self.default_theme_path))

    def load_theme(self, path: str) -> Theme:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return Theme(name=data.get("name", "Custom Theme"), data=data)
