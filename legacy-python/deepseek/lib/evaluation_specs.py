"""Loop evaluation-spec protocol for DeepSeek commands.

The osstack loop runtime hands acceptance criteria to ds-review/ds-verify
through a JSON file referenced by $OSSTACK_EVALUATION_SPECS_FILE, and reads
per-spec verdicts back from a single stdout line:

    OSSTACK_EVALUATIONS: {"evaluations":[{"id":"x","pass":true,"summary":"..."}]}

This module owns both directions. Everything degrades gracefully: no env var
means no criteria and no judgment line, so legacy invocations are unchanged.

Stdlib only.
"""

from __future__ import annotations

import json
import os

ENV_VAR = "OSSTACK_EVALUATION_SPECS_FILE"
PREFIX = "OSSTACK_EVALUATIONS:"


def load_specs(environ=None):
    """Read evaluation specs from $OSSTACK_EVALUATION_SPECS_FILE.

    Returns a list of dicts with at least an ``id`` and ``description``.
    Any problem (unset var, unreadable file, wrong shape) returns [] so the
    command behaves exactly like a legacy invocation.
    """
    env = environ if environ is not None else os.environ
    path = env.get(ENV_VAR, "").strip()
    if not path:
        return []
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except Exception:
        return []
    if not isinstance(raw, list):
        return []
    specs = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        spec_id = entry.get("id")
        if not isinstance(spec_id, str) or not spec_id.strip():
            continue
        specs.append(entry)
    return specs


def judgment_prompt_appendix(specs):
    """System-prompt appendix instructing the model to judge each spec."""
    if not specs:
        return ""
    ids = ", ".join(spec["id"] for spec in specs)
    return (
        "\n\n--- OSSTACK EVALUATION JUDGMENTS (required) ---\n"
        "In addition to your report, you MUST end your response with exactly one\n"
        "fenced JSON block judging every evaluation listed in the user message.\n"
        f"Cover these ids exactly once each: {ids}.\n"
        "Format (no other keys, summary <= 200 chars):\n"
        "```json\n"
        '{"evaluations":[{"id":"<id>","pass":true,"summary":"<why>"}]}\n'
        "```\n"
        "Judge strictly against each evaluation's acceptance criteria. When in\n"
        "doubt, mark pass=false and explain what is missing.\n"
    )


def criteria_user_block(specs):
    """User-content block listing the acceptance criteria to judge."""
    if not specs:
        return ""
    lines = ["", "--- Evaluation criteria to judge ---"]
    for spec in specs:
        mode = spec.get("mode", "semantic_review")
        description = spec.get("description", "")
        lines.append(f"- {spec['id']} ({mode}): {description}")
        acceptance = spec.get("acceptance")
        if isinstance(acceptance, str) and acceptance.strip():
            lines.append(f"  Acceptance: {acceptance.strip()}")
    lines.append("")
    return "\n".join(lines)


def extract_judgments(content, specs):
    """Pull per-spec judgments from model output.

    Accepts the judgments JSON either inside a fenced block or raw. Only
    entries whose id matches a known spec and whose ``pass`` is a boolean
    survive; the last well-formed JSON object wins. Returns a list of
    {"id", "pass", "summary"?} dicts (possibly empty).
    """
    if not specs or not content:
        return []
    known_ids = {spec["id"] for spec in specs}
    best = []
    for candidate in _candidate_json_objects(content):
        entries = candidate.get("evaluations")
        if not isinstance(entries, list):
            continue
        judgments = []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            spec_id = entry.get("id")
            verdict = entry.get("pass")
            if spec_id not in known_ids or not isinstance(verdict, bool):
                continue
            judgment = {"id": spec_id, "pass": verdict}
            summary = entry.get("summary")
            if isinstance(summary, str) and summary.strip():
                judgment["summary"] = summary.strip()[:240]
            judgments.append(judgment)
        if judgments:
            best = judgments
    return best


def emit_line(judgments):
    """Render the stdout line the osstack adapter parses. '' when empty."""
    if not judgments:
        return ""
    return f"{PREFIX} " + json.dumps({"evaluations": judgments}, ensure_ascii=False)


def _candidate_json_objects(content):
    """Yield parsed JSON objects that contain an 'evaluations' key, in order."""
    marker = '"evaluations"'
    start = 0
    while True:
        index = content.find(marker, start)
        if index == -1:
            return
        brace = content.rfind("{", 0, index)
        if brace == -1:
            start = index + len(marker)
            continue
        parsed = _parse_balanced(content, brace)
        if parsed is not None:
            yield parsed
        start = index + len(marker)


def _parse_balanced(content, open_index):
    depth = 0
    in_string = False
    escaped = False
    for position in range(open_index, len(content)):
        char = content[position]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                try:
                    parsed = json.loads(content[open_index:position + 1])
                except Exception:
                    return None
                return parsed if isinstance(parsed, dict) else None
    return None
