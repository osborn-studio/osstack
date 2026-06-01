"""Agent-brief extraction and formatting (stdlib only).

Used by ~/.osborn/capabilities/runtime/bin/osb-agent-brief.
No LLM, no network. Deterministic local Markdown extraction.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

# ----------------------------------------------------------------------
# I/O helpers
# ----------------------------------------------------------------------

def read_file(path: Path):
    try:
        if path.is_file():
            return path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return None
    return None


def git_status_short(root: Path):
    """Returns the output of `git status --short` or None if not a git repo."""
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            cwd=str(root), capture_output=True, text=True, timeout=5,
        )
        if r.returncode != 0:
            return None
    except Exception:
        return None
    try:
        s = subprocess.run(
            ["git", "status", "--short"],
            cwd=str(root), capture_output=True, text=True, timeout=5,
        )
        if s.returncode == 0:
            return s.stdout.rstrip()
    except Exception:
        return None
    return ""


# ----------------------------------------------------------------------
# Markdown helpers
# ----------------------------------------------------------------------

HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")


def parse_heading(line):
    m = HEADING_RE.match(line.strip())
    if not m:
        return None
    return len(m.group(1)), m.group(2).strip()


def extract_section(text, heading_substring):
    """Return content under the first heading whose title contains
    `heading_substring` (case-insensitive). Stops at next heading at the
    same or higher level."""
    if not text:
        return []
    out = []
    in_section = False
    target_level = None
    target = heading_substring.lower()
    for raw in text.splitlines():
        h = parse_heading(raw)
        if h:
            level, title = h
            if not in_section:
                if target in title.lower():
                    in_section = True
                    target_level = level
                    continue
            else:
                if level <= target_level:
                    break
                out.append(raw.rstrip())
                continue
        if in_section and raw.strip():
            out.append(raw.rstrip())
    return out


def first_summary(text, max_lines):
    """First N non-empty content lines, skipping a leading H1 title."""
    if not text:
        return []
    out, seen_h1 = [], False
    for raw in text.splitlines():
        s = raw.rstrip()
        h = parse_heading(s)
        if h and h[0] == 1 and not seen_h1:
            seen_h1 = True
            continue
        if not s.strip():
            continue
        # Skip HTML comments/metadata lines from osb-context output
        if s.strip().startswith("<!--"):
            continue
        out.append(s)
        if len(out) >= max_lines:
            break
    return out


def unchecked_items(text, limit=None):
    """Returns checkbox items like '- [ ] foo', skipping placeholder 'TODO'."""
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
        if limit and len(out) >= limit:
            break
    return out


def changelog_recent(text, limit=5):
    """Pull bullets from the most recent changelog section."""
    if not text:
        return []
    # Try 'Unreleased' first; fall back to first ## section.
    bullets = extract_section(text, "Unreleased")
    if not bullets:
        # Walk all H2s, pick first
        in_first = False
        bullets = []
        for raw in text.splitlines():
            h = parse_heading(raw)
            if h:
                if h[0] == 2:
                    if in_first:
                        break
                    in_first = True
                    continue
            if in_first and raw.strip():
                bullets.append(raw.rstrip())
    return [b for b in bullets if b.strip().startswith("-")][:limit]


# ----------------------------------------------------------------------
# Brief builder
# ----------------------------------------------------------------------

REQUIRED_READING = (
    "`.agent/PROJECT_CONTEXT.md`",
    "`.agent/CCB_PROTOCOL.md`",
    "`docs/02_PRD.md`",
    "`docs/04_SYSTEM_ARCHITECTURE.md`",
    "`tasks/CURRENT_SPRINT.md`",
    "`docs/16_ACCEPTANCE_CRITERIA.md`",
)

DEFAULT_DO_NOT_CHANGE = (
    "- Architecture boundaries (see `docs/04_SYSTEM_ARCHITECTURE.md`).",
    "- Database schemas without migration notes.",
    "- Acceptance criteria without explicit approval.",
    "- Public API contracts without changelog updates.",
)

IMPLEMENTATION_INSTRUCTIONS = (
    "- Make minimal correct changes.",
    "- Preserve existing behavior.",
    "- Update docs if architecture or behavior changes.",
    "- Do not skip tests.",
    "- Do not silently change schema or API contracts.",
)

COMPLETION_CHECKLIST = (
    "1. Run relevant tests/build.",
    "2. Update `docs/15_CHANGELOG.md`.",
    "3. Run `osb-context`.",
    "4. Run `osb-loop`.",
    "5. Report only unresolved blockers.",
)

HUMAN_GATE = (
    "- product direction changes",
    "- architecture boundary changes",
    "- security-sensitive decisions",
    "- deployment approval",
    "- major trade-offs",
    "- final acceptance",
)

CCB_INSTRUCTION = (
    "You are running in Claude Code Bypass mode.",
    "Minimize human interruptions.",
    "Proceed autonomously within the project rules.",
    "Only stop for Human Gate issues.",
)

CODEX_INSTRUCTION = (
    "You are acting as a patch/refactor worker.",
    "Do not change product direction.",
    "Do not rewrite architecture unless explicitly requested.",
    "Focus on small, correct, reviewable patches.",
)


def _h(brief, full_label, brief_label=None):
    """Build a section heading. In brief mode we drop the numbering prefix."""
    if brief:
        return "## " + (brief_label or full_label.split(". ", 1)[-1])
    return "## " + full_label


def build_brief(root, brief=False, persona=None):
    project_context = read_file(root / ".agent" / "PROJECT_CONTEXT.md")
    ccb_protocol   = read_file(root / ".agent" / "CCB_PROTOCOL.md")
    current_sprint = read_file(root / "tasks" / "CURRENT_SPRINT.md")
    prd            = read_file(root / "docs" / "02_PRD.md")
    arch           = read_file(root / "docs" / "04_SYSTEM_ARCHITECTURE.md")
    accept         = read_file(root / "docs" / "16_ACCEPTANCE_CRITERIA.md")
    changelog      = read_file(root / "docs" / "15_CHANGELOG.md")
    git_st         = git_status_short(root)

    out = ["# Agent Brief", ""]

    # ---------- Project Snapshot (full mode only) ----------
    if not brief:
        out.append(_h(False, "1. Project Snapshot"))
        snap = extract_section(project_context, "Project Goal")
        if not snap and project_context:
            snap = first_summary(project_context, 8)
        if not snap and prd:
            problem = extract_section(prd, "Problem")
            if problem:
                snap = ["**From `docs/02_PRD.md` Problem:**"] + problem[:6]
        if not snap:
            out.append("Missing source: .agent/PROJECT_CONTEXT.md")
        else:
            out.extend(snap[:8])
        out.append("")

    # ---------- Current Objective ----------
    out.append(_h(brief, "2. Current Objective"))
    obj_lines = []
    sprint_goal = extract_section(current_sprint, "Sprint Goal")
    if sprint_goal:
        obj_lines.append("**Sprint Goal:**")
        obj_lines.extend(sprint_goal[:5])
    open_tasks = unchecked_items(current_sprint or "", limit=5)
    if open_tasks:
        if obj_lines:
            obj_lines.append("")
        obj_lines.append("**Open tasks:**")
        for item in open_tasks:
            obj_lines.append(f"- [ ] {item}")
    if not obj_lines and project_context:
        active = extract_section(project_context, "Active Sprint")
        next_action = extract_section(project_context, "Next Recommended Action")
        if active:
            obj_lines.append("**Active sprint (from PROJECT_CONTEXT):**")
            obj_lines.extend(active[:5])
        if next_action:
            if obj_lines:
                obj_lines.append("")
            obj_lines.append("**Next recommended action:**")
            obj_lines.extend(next_action[:3])
    if not obj_lines:
        obj_lines.append("Missing source: tasks/CURRENT_SPRINT.md")
    out.extend(obj_lines)
    out.append("")

    # ---------- Required Reading ----------
    out.append(_h(brief, "3. Required Reading"))
    out.append("Before changing code, read:")
    for i, item in enumerate(REQUIRED_READING, start=1):
        out.append(f"{i}. {item}")
    out.append("")

    # ---------- Do Not Change ----------
    out.append(_h(brief, "4. Do Not Change"))
    constraints = []
    sprint_dnc = extract_section(current_sprint, "Do Not Change")
    if sprint_dnc:
        for line in sprint_dnc[:6]:
            if line.strip() and line.strip().upper() != "TODO":
                constraints.append(line)
    ccb_rules = extract_section(ccb_protocol, "Execution Rules")
    if ccb_rules:
        for line in ccb_rules[:8]:
            stripped = line.strip()
            if stripped and stripped.upper() != "TODO" and line not in constraints:
                constraints.append(line)
    if constraints:
        out.extend(constraints)
    else:
        out.extend(DEFAULT_DO_NOT_CHANGE)
    out.append("")

    # ---------- Implementation Instructions (full mode only) ----------
    if not brief:
        out.append(_h(False, "5. Implementation Instructions"))
        out.extend(IMPLEMENTATION_INSTRUCTIONS)
        out.append("")

    # ---------- Completion Checklist ----------
    out.append(_h(brief, "6. Completion Checklist"))
    out.append("After implementation:")
    out.extend(COMPLETION_CHECKLIST)
    out.append("")

    # ---------- Current Git Status (full mode only) ----------
    if not brief:
        out.append(_h(False, "7. Current Git Status"))
        if git_st is None:
            out.append("Not a git repository.")
        elif not git_st.strip():
            out.append("Working tree: clean.")
        else:
            out.append("```")
            for line in git_st.splitlines()[:10]:
                out.append(line)
            extra = len(git_st.splitlines()) - 10
            if extra > 0:
                out.append(f"... (+{extra} more)")
            out.append("```")
        out.append("")

        # ---------- Recent Changelog (full mode only, optional context) ----------
        recent = changelog_recent(changelog, limit=5)
        if recent:
            out.append("### Recent Changelog")
            out.extend(recent)
            out.append("")

    # ---------- Human Gate (full mode only) ----------
    if not brief:
        out.append(_h(False, "8. Human Gate"))
        out.append("Only interrupt human for:")
        out.extend(HUMAN_GATE)
        out.append("")

    # ---------- Persona-specific section ----------
    if persona == "ccb":
        out.append("## CCB-Specific Instruction")
        out.extend(CCB_INSTRUCTION)
        out.append("")
    elif persona == "codex":
        out.append("## Codex-Specific Instruction")
        out.extend(CODEX_INSTRUCTION)
        out.append("")

    return "\n".join(out).rstrip() + "\n"
