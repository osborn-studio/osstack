"""osb-task storage and rendering (stdlib only).

Tasks live as Markdown files with YAML-ish frontmatter under
`tasks/items/<id>-<slug>.md`. The ID is auto-incremented (T001, T002, …).

No LLM, no network. Deterministic local file management.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, asdict
from datetime import date
from pathlib import Path

ITEMS_DIR = "tasks/items"
ID_PREFIX = "T"
ID_PAD = 3

VALID_STATUSES = ("backlog", "in_progress", "blocked", "done")
VALID_PRIORITIES = ("P1", "P2", "P3")

DEFAULT_STATUS = "backlog"
DEFAULT_PRIORITY = "P2"

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)
KV_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$")


# ----------------------------------------------------------------------
# Task model
# ----------------------------------------------------------------------

@dataclass
class Task:
    id: str
    title: str
    status: str = DEFAULT_STATUS
    priority: str = DEFAULT_PRIORITY
    created: str = ""
    path: str = ""

    # Body sections (Markdown content under each H2)
    linked_docs: list = field(default_factory=list)
    files_involved: list = field(default_factory=list)
    acceptance_criteria: list = field(default_factory=list)
    do_not_change: list = field(default_factory=list)
    test_plan: list = field(default_factory=list)
    rollback_plan: list = field(default_factory=list)
    dependencies: list = field(default_factory=list)
    notes: list = field(default_factory=list)


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------

def slugify(title):
    s = title.lower().strip()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = s.strip("-")
    return s[:48] or "task"


def items_dir(root):
    return Path(root) / ITEMS_DIR


def parse_frontmatter(text):
    """Returns (front_dict, body_text). Empty dict if no frontmatter."""
    if not text:
        return {}, ""
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    front_text = m.group(1)
    body = m.group(2)
    front = {}
    for line in front_text.splitlines():
        km = KV_RE.match(line.strip())
        if km:
            front[km.group(1)] = km.group(2).strip().strip('"').strip("'")
    return front, body


def parse_section_bullets(body, heading):
    """Extract bullet lines under '## <heading>' until the next ##."""
    out = []
    in_section = False
    target = heading.lower()
    for line in body.splitlines():
        s = line.strip()
        if s.startswith("## "):
            current = s[3:].strip().lower()
            in_section = (current == target)
            continue
        if s.startswith("#"):
            if in_section:
                break
        if in_section and s.startswith("-"):
            out.append(s.lstrip("- ").rstrip())
    return out


def load_task(path):
    text = ""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return None
    front, body = parse_frontmatter(text)
    t = Task(
        id=front.get("id", "T???"),
        title=front.get("title", "(untitled)"),
        status=front.get("status", DEFAULT_STATUS),
        priority=front.get("priority", DEFAULT_PRIORITY),
        created=front.get("created", ""),
        path=str(path),
    )
    t.linked_docs         = parse_section_bullets(body, "Linked Docs")
    t.files_involved      = parse_section_bullets(body, "Files Involved")
    t.acceptance_criteria = parse_section_bullets(body, "Acceptance Criteria")
    t.do_not_change       = parse_section_bullets(body, "Do Not Change")
    t.test_plan           = parse_section_bullets(body, "Test Plan")
    t.rollback_plan       = parse_section_bullets(body, "Rollback Plan")
    t.dependencies        = parse_section_bullets(body, "Dependencies")
    t.notes               = parse_section_bullets(body, "Notes")
    return t


def list_tasks(root):
    d = items_dir(Path(root))
    if not d.is_dir():
        return []
    out = []
    for f in sorted(d.glob("*.md")):
        t = load_task(f)
        if t:
            out.append(t)
    out.sort(key=lambda t: t.id)
    return out


def next_id(root):
    existing = list_tasks(root)
    nums = []
    for t in existing:
        m = re.match(rf"^{ID_PREFIX}(\d+)$", t.id)
        if m:
            nums.append(int(m.group(1)))
    n = (max(nums) + 1) if nums else 1
    return f"{ID_PREFIX}{str(n).zfill(ID_PAD)}"


def task_path(root, task_id, title):
    return items_dir(Path(root)) / f"{task_id}-{slugify(title)}.md"


# ----------------------------------------------------------------------
# Rendering
# ----------------------------------------------------------------------

def render_task_file(t):
    body = []
    body.append("---")
    body.append(f"id: {t.id}")
    body.append(f'title: "{t.title}"')
    body.append(f"status: {t.status}")
    body.append(f"priority: {t.priority}")
    body.append(f"created: {t.created or date.today().isoformat()}")
    body.append("---")
    body.append("")
    body.append(f"# {t.id}: {t.title}")
    body.append("")
    sections = [
        ("Linked Docs",         t.linked_docs),
        ("Files Involved",      t.files_involved),
        ("Acceptance Criteria", t.acceptance_criteria),
        ("Do Not Change",       t.do_not_change),
        ("Test Plan",           t.test_plan),
        ("Rollback Plan",       t.rollback_plan),
        ("Dependencies",        t.dependencies),
        ("Notes",               t.notes),
    ]
    for name, items in sections:
        body.append(f"## {name}")
        if items:
            for it in items:
                body.append(f"- {it}")
        else:
            body.append("- TODO")
        body.append("")
    return "\n".join(body).rstrip() + "\n"


def write_task(t):
    p = Path(t.path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(render_task_file(t), encoding="utf-8")
    return p


# ----------------------------------------------------------------------
# Operations
# ----------------------------------------------------------------------

def cmd_add(root, title, priority=DEFAULT_PRIORITY):
    if priority not in VALID_PRIORITIES:
        raise ValueError(f"priority must be one of {VALID_PRIORITIES}")
    new_id = next_id(root)
    t = Task(id=new_id, title=title, priority=priority,
             path=str(task_path(root, new_id, title)),
             created=date.today().isoformat())
    write_task(t)
    return t


def cmd_set_status(root, task_id, new_status):
    if new_status not in VALID_STATUSES:
        raise ValueError(f"status must be one of {VALID_STATUSES}")
    for t in list_tasks(root):
        if t.id == task_id:
            t.status = new_status
            write_task(t)
            return t
    raise KeyError(f"task not found: {task_id}")


def cmd_done(root, task_id):
    return cmd_set_status(root, task_id, "done")


def render_table(tasks, columns=("id", "status", "priority", "title")):
    headers = list(columns)
    rows = []
    for t in tasks:
        row = []
        for col in headers:
            row.append(getattr(t, col, ""))
        rows.append(row)
    widths = [len(h) for h in headers]
    for r in rows:
        for i, c in enumerate(r):
            widths[i] = max(widths[i], len(str(c)))
    out = []
    out.append("| " + " | ".join(h.ljust(widths[i]) for i, h in enumerate(headers)) + " |")
    out.append("|" + "|".join("-" * (w + 2) for w in widths) + "|")
    for r in rows:
        out.append("| " + " | ".join(str(c).ljust(widths[i]) for i, c in enumerate(r)) + " |")
    return "\n".join(out)


def cmd_list(root, status_filter=None, priority_filter=None):
    tasks = list_tasks(root)
    if status_filter:
        tasks = [t for t in tasks if t.status == status_filter]
    if priority_filter:
        tasks = [t for t in tasks if t.priority == priority_filter]
    if not tasks:
        return "_(no tasks)_"
    return render_table(tasks)


def cmd_show(root, task_id):
    for t in list_tasks(root):
        if t.id == task_id:
            try:
                return Path(t.path).read_text(encoding="utf-8")
            except Exception:
                return None
    raise KeyError(f"task not found: {task_id}")


def cmd_sprint(root):
    """Active sprint = all in_progress + all P1 backlog + all blocked."""
    tasks = list_tasks(root)
    sprint = [
        t for t in tasks
        if t.status == "in_progress"
        or (t.status == "backlog" and t.priority == "P1")
        or t.status == "blocked"
    ]
    if not sprint:
        return "_(no sprint tasks: nothing in_progress, no P1 backlog, no blockers)_"
    return render_table(sprint)


def cmd_remove(root, task_id):
    for t in list_tasks(root):
        if t.id == task_id:
            try:
                Path(t.path).unlink()
                return t
            except Exception as e:
                raise RuntimeError(f"failed to remove {t.path}: {e}")
    raise KeyError(f"task not found: {task_id}")
