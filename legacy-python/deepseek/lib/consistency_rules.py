"""Layer-1 deterministic checks for ds-verify.

Each check produces a Finding. The verify engine bundles findings into the
LLM context so the model has ground-truth observations when filling in the
Alignment table.
"""

from __future__ import annotations

from dataclasses import dataclass


# Severity levels (lowercase keeps tabular display compact).
INFO = "info"
WARN = "warn"
FAIL = "fail"


@dataclass
class Finding:
    severity: str   # INFO | WARN | FAIL
    area: str       # PRD | Architecture | Sprint | Acceptance Criteria | Changelog | Tests
    message: str

    def line(self):
        return f"- [{self.severity.upper():>4}] {self.area}: {self.message}"


# Map doc keys to alignment areas
DOC_AREA = {
    "prd":        "PRD",
    "arch":       "Architecture",
    "acceptance": "Acceptance Criteria",
    "sprint":     "Current Sprint",
    "changelog":  "Changelog",
}


def _check_required_files(docs):
    out = []
    for key, info in docs["required"].items():
        area = DOC_AREA.get(key, key)
        if not info["exists"]:
            out.append(Finding(FAIL, area, f"missing source file: {info['rel']}"))
        elif info["empty"]:
            out.append(Finding(FAIL, area, f"source file is empty: {info['rel']}"))
        elif info["todo_only"]:
            out.append(Finding(FAIL, area, f"source file is TODO-only stub: {info['rel']}"))
    return out


def _check_changelog(docs):
    info = docs["optional"].get("changelog")
    out = []
    if not info:
        return out
    if not info["exists"]:
        out.append(Finding(WARN, "Changelog", f"missing source file: {info['rel']}"))
        return out
    if info["empty"] or info["todo_only"]:
        out.append(Finding(WARN, "Changelog", f"changelog is empty or stub: {info['rel']}"))
        return out
    text = info["content"] or ""
    # only the auto-init line — no real entries yet
    real_bullets = [
        ln.strip() for ln in text.splitlines()
        if ln.strip().startswith("-") and "Initialized project structure" not in ln
    ]
    if not real_bullets:
        out.append(Finding(
            WARN, "Changelog",
            "changelog has only the osb-init placeholder entry — no real changes recorded",
        ))
    return out


def _check_sprint(docs):
    info = docs["required"].get("sprint")
    out = []
    if not info or not info["exists"]:
        return out
    unchecked = info.get("unchecked") or []
    if unchecked:
        sample = "; ".join(unchecked[:3])
        more = f" (+{len(unchecked) - 3} more)" if len(unchecked) > 3 else ""
        out.append(Finding(
            INFO, "Current Sprint",
            f"{len(unchecked)} unchecked sprint task(s): {sample}{more}",
        ))
    return out


def _check_tests(has_tests, git_diff):
    out = []
    if not has_tests:
        out.append(Finding(WARN, "Tests", "no test files detected in project tree"))
    if git_diff:
        diff_mentions_test = any(
            kw in git_diff.lower() for kw in ("test_", "_test.", ".test.", ".spec.", "describe(", "it(", "def test_")
        )
        if not diff_mentions_test and len(git_diff) > 50:
            out.append(Finding(
                INFO, "Tests",
                "current git diff does not appear to add or modify tests",
            ))
    return out


def _check_git_state(git):
    out = []
    if not git.get("is_repo"):
        out.append(Finding(INFO, "Changelog", "not a git repository — cannot infer recent activity"))
        return out
    if git.get("status", "").strip():
        n = len([ln for ln in git["status"].splitlines() if ln.strip()])
        out.append(Finding(
            INFO, "Changelog",
            f"working tree has {n} uncommitted change(s) — verify changelog is current",
        ))
    return out


def run_checks(docs, git, has_tests):
    """Run all layer-1 checks. Returns list[Finding]."""
    findings = []
    findings += _check_required_files(docs)
    findings += _check_changelog(docs)
    findings += _check_sprint(docs)
    findings += _check_tests(has_tests, git.get("diff", ""))
    findings += _check_git_state(git)
    return findings


def summarize_for_prompt(findings):
    """Format findings as a Markdown block for the LLM context."""
    if not findings:
        return "_(no deterministic findings)_"
    return "\n".join(f.line() for f in findings)


def verdict_floor(findings):
    """If any finding is FAIL, the overall verdict cannot be PASS.
    Returns 'FAIL', 'PARTIAL', or None (no floor)."""
    sev = {f.severity for f in findings}
    if FAIL in sev:
        return "FAIL"
    if WARN in sev:
        return "PARTIAL"
    return None
