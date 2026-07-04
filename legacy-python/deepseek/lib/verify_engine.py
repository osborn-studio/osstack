"""Verification engine — orchestrates docs → checks → LLM call → normalize."""

from __future__ import annotations

from pathlib import Path

import api
import consistency_rules as rules
import doc_reader
import evaluation_specs

REQUIRED_HEADINGS = (
    "# DS Verify Report",
    "## Summary",
    "## Alignment",
    "## Pass / Fail",
)

STRICT_APPEND = (
    "\n\n--- ADDITIONAL CONSTRAINT (strict mode) ---\n"
    "Fail verification if:\n"
    "- tests are missing\n"
    "- architecture changes are undocumented\n"
    "- acceptance criteria are incomplete\n"
    "- sprint tasks remain unchecked\n"
)


def _truncate(text, cap, label):
    if not text:
        return ""
    if cap <= 0 or len(text) <= cap:
        return text
    return text[:cap] + f"\n\n…[truncated {label}: kept {cap} of {len(text)} chars]\n"


def _doc_block(label, info, max_doc_chars):
    if not info or not info["exists"]:
        return f"### {label} (`{info['rel'] if info else label}`)\nWARN missing source: {info['rel'] if info else label}\n"
    body = info["content"] or ""
    body = _truncate(body, max_doc_chars, "doc")
    note = ""
    if info["empty"]:
        note = "\n**(NOTE: file is empty)**\n"
    elif info["todo_only"]:
        note = "\n**(NOTE: file contains only TODO placeholders)**\n"
    return f"### {label} (`{info['rel']}`){note}\n```markdown\n{body}\n```\n"


def build_user_content(docs, git, findings, max_doc_chars, max_diff_chars):
    parts = []
    parts.append(
        "Verify whether the implementation is aligned with project intent. "
        "Use the deterministic findings as ground truth when filling the Alignment table.\n"
    )

    parts.append("\n## Deterministic Findings (Layer 1)\n")
    parts.append(rules.summarize_for_prompt(findings))
    parts.append("\n")

    parts.append("\n## Project Documents\n")
    for label, key in (
        ("PRD",                 "prd"),
        ("System Architecture", "arch"),
        ("Acceptance Criteria", "acceptance"),
        ("Current Sprint",      "sprint"),
    ):
        parts.append(_doc_block(label, docs["required"].get(key), max_doc_chars))

    for label, key in (
        ("Task Breakdown",  "tasks_doc"),
        ("Changelog",       "changelog"),
        ("Project Context", "context"),
    ):
        info = docs["optional"].get(key)
        if info and info["exists"]:
            parts.append(_doc_block(label, info, max_doc_chars))

    parts.append("\n## Git State\n")
    if not git.get("is_repo"):
        parts.append("Not a git repository.\n")
    else:
        parts.append(f"Branch: `{git.get('branch') or '(detached)'}`\n")
        if git.get("status", "").strip():
            parts.append("\n`git status --short`:\n```\n" + git["status"] + "\n```\n")
        else:
            parts.append("Working tree: clean.\n")
        diff = git.get("diff", "")
        if diff.strip():
            parts.append("\n`git diff` (unstaged):\n")
            parts.append("```diff\n" + _truncate(diff, max_diff_chars, "diff") + "\n```\n")
        else:
            parts.append("`git diff`: empty.\n")

    parts.append(
        "\n---\nReturn the report in EXACTLY the OSBORN format from the system "
        "prompt. Do not add other top-level headings.\n"
    )
    return "".join(parts)


def normalize_output(content, findings):
    """Pass-through if model returned the right headings; otherwise wrap.
    Always appends a 'Layer 1 deterministic findings' block at the end."""
    body = content.rstrip()
    if all(h in body for h in REQUIRED_HEADINGS):
        normalized = body + "\n"
    else:
        normalized = (
            "# DS Verify Report\n"
            "## Summary\n"
            "_Upstream model did not return the expected OSBORN format. "
            "Original output preserved below._\n\n"
            "## Alignment\n"
            "| Area | Status | Notes |\n"
            "|---|---|---|\n"
            "| PRD | FAIL | model output unparseable |\n"
            "| Architecture | FAIL | model output unparseable |\n"
            "| Current Sprint | FAIL | model output unparseable |\n"
            "| Acceptance Criteria | FAIL | model output unparseable |\n"
            "| Changelog | FAIL | model output unparseable |\n"
            "| Tests | FAIL | model output unparseable |\n\n"
            "## Gaps\n1. Model did not produce a structured report.\n\n"
            "## Required Fixes\n1. Inspect raw model output and re-run.\n\n"
            "## Risks\n1. Verification did not complete reliably.\n\n"
            "## Pass / Fail\nFAIL\n\n"
            "## Raw Upstream Output\n" + body + "\n"
        )

    appendix = ["", "---", "", "## Layer 1 Deterministic Findings"]
    if findings:
        for f in findings:
            appendix.append(f.line())
    else:
        appendix.append("_(none)_")
    return normalized.rstrip() + "\n" + "\n".join(appendix) + "\n"


def run(
    project_root,
    api_key,
    base_url,
    model,
    prompt_path,
    strict,
    temperature,
    timeout,
    max_doc_chars,
    max_diff_chars,
    specs=None,
):
    """High-level entry point used by the bin/ds-verify script.

    ``specs`` are osstack loop evaluation specs (see lib/evaluation_specs).
    Returns (report, findings, judgments); judgments is [] without specs.
    """
    root = Path(project_root)
    specs = specs or []

    docs = doc_reader.read_all(root)
    git = doc_reader.git_state(root)
    has_tests = doc_reader.detect_tests(root)
    findings = rules.run_checks(docs, git, has_tests)

    try:
        system_prompt = Path(prompt_path).read_text(encoding="utf-8")
    except Exception:
        system_prompt = (
            "You are a strict implementation verifier. Return a DS Verify Report "
            "in the OSBORN format with sections: Summary, Alignment, Gaps, "
            "Required Fixes, Risks, Pass / Fail."
        )
    if strict:
        system_prompt = system_prompt.rstrip() + STRICT_APPEND
    if specs:
        system_prompt = system_prompt.rstrip() + evaluation_specs.judgment_prompt_appendix(specs)

    user_content = build_user_content(docs, git, findings, max_doc_chars, max_diff_chars)
    if specs:
        user_content = user_content + evaluation_specs.criteria_user_block(specs)

    raw = api.call_chat(
        api_key=api_key,
        base_url=base_url,
        model=model,
        system_prompt=system_prompt,
        user_content=user_content,
        temperature=temperature,
        timeout=timeout,
    )
    judgments = evaluation_specs.extract_judgments(raw, specs)
    return normalize_output(raw, findings), findings, judgments
