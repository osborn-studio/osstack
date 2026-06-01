"""Read OSBORN-convention project documents into a structured dict.

No I/O on missing files — they appear as `exists=False`. The verify engine
is responsible for emitting WARN/FAIL findings based on missing-but-required
docs, not this module.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

REQUIRED_SOURCES = {
    "prd":         "docs/02_PRD.md",
    "arch":        "docs/04_SYSTEM_ARCHITECTURE.md",
    "acceptance":  "docs/16_ACCEPTANCE_CRITERIA.md",
    "sprint":      "tasks/CURRENT_SPRINT.md",
}

OPTIONAL_SOURCES = {
    "tasks_doc":   "docs/10_TASK_BREAKDOWN.md",
    "changelog":   "docs/15_CHANGELOG.md",
    "context":     ".agent/PROJECT_CONTEXT.md",
    "agents":      "AGENTS.md",
    "tasks":       "tasks/TASKS.md",
}


def _read_text(p):
    try:
        if p.is_file():
            return p.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return None
    return None


def _is_todo_only(text):
    """True if the doc contains only headings + 'TODO' placeholder lines.
    Treats osb-init template output as 'effectively empty'."""
    if not text:
        return True
    saw_real_content = False
    for raw in text.splitlines():
        s = raw.strip()
        if not s:
            continue
        if s.startswith("#"):
            continue
        if s.upper() == "TODO":
            continue
        if re.match(r"^[-*]\s*\[\s*\]\s*TODO\s*$", s, re.IGNORECASE):
            continue
        # any other real line = content
        saw_real_content = True
        break
    return not saw_real_content


def _unchecked_items(text):
    if not text:
        return []
    out = []
    for raw in text.splitlines():
        s = raw.strip()
        m = re.match(r"-\s*\[\s*\]\s+(.*)$", s)
        if m:
            content = m.group(1).strip()
            if content and content.upper() != "TODO":
                out.append(content)
    return out


def read_one(root, key, rel):
    path = root / rel
    text = _read_text(path)
    return {
        "key": key,
        "rel": rel,
        "abs": str(path),
        "exists": text is not None,
        "empty": text is None or not text.strip(),
        "todo_only": _is_todo_only(text or ""),
        "content": text,
        "size": len(text) if text else 0,
        "unchecked": _unchecked_items(text or "") if key == "sprint" else [],
    }


def read_all(root):
    out = {"required": {}, "optional": {}, "root": str(root)}
    for k, rel in REQUIRED_SOURCES.items():
        out["required"][k] = read_one(root, k, rel)
    for k, rel in OPTIONAL_SOURCES.items():
        out["optional"][k] = read_one(root, k, rel)
    return out


def git_state(root):
    """Returns dict with branch/status_short/diff_text. Empty fields if not a repo."""
    info = {"is_repo": False, "branch": "", "status": "", "diff": ""}
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            cwd=str(root), capture_output=True, text=True, timeout=5,
        )
        if r.returncode != 0:
            return info
    except Exception:
        return info
    info["is_repo"] = True

    for cmd, key in (
        (["git", "branch", "--show-current"], "branch"),
        (["git", "status", "--short"],         "status"),
        (["git", "diff"],                      "diff"),
    ):
        try:
            r = subprocess.run(cmd, cwd=str(root), capture_output=True, text=True, timeout=20)
            if r.returncode == 0:
                info[key] = r.stdout.rstrip() if key != "diff" else r.stdout
        except Exception:
            pass
    return info


def detect_tests(root):
    """Heuristic: returns True if the project appears to have tests."""
    if any((root / p).exists() for p in (
        "package.json", "pyproject.toml", "Cargo.toml", "go.mod",
    )):
        # Even with package.json, still check for actual test directories
        if (root / "tests").is_dir() or (root / "test").is_dir():
            return True
    if any(root.glob("**/test_*.py")) or any(root.glob("**/*_test.py")):
        return True
    if any(root.glob("**/*.test.ts")) or any(root.glob("**/*.test.js")):
        return True
    if any(root.glob("**/*.spec.ts")) or any(root.glob("**/*.spec.js")):
        return True
    if (root / "tests").is_dir() or (root / "test").is_dir():
        return True
    return False
