"""Read-only product/source checks; writes only this study's validation records."""
from pathlib import Path
import hashlib
import json
import re
import subprocess
from datetime import datetime, timezone

EVIDENCE = Path(__file__).resolve().parent
ROOT = EVIDENCE.parents[2]
FIRSTMATE = ROOT.parent / "firstmate"
DOCS = [
    ROOT / "docs/reports/2026-10-23-firstmate-analysis.md",
    ROOT / "docs/design/2026-10-23-firstmate-capability-adoption.md",
    ROOT / "docs/plans/2026-10-23-firstmate-adoption-plan.md",
    ROOT / "docs/reports/2026-10-23-firstmate-claude-audit.md",
    EVIDENCE / "README.md",
]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(path, *args):
    return subprocess.check_output(["git", "-C", str(path), *args], text=True).strip()


def run():
    errors = []
    upstream = json.loads((EVIDENCE / "firstmate-source-manifest.json").read_text())
    baseline = json.loads((EVIDENCE / "osstack-source-manifest.json").read_text())
    source_index = json.loads((EVIDENCE / "source-index.json").read_text())
    for manifest, root in [(upstream, FIRSTMATE), (baseline, ROOT)]:
        for record in manifest["files"]:
            path = root / record["path"]
            if not path.is_file() or sha(path) != record["sha256"]:
                errors.append(f"baseline_changed: {path}")
    for entry in source_index:
        root = FIRSTMATE if entry["repository"] == "firstmate" else ROOT
        path = root / entry["path"]
        if sha(path) != entry["sha256"]:
            errors.append(f"excerpt_source_changed: {entry['id']}")
        if not 1 <= entry["start_line"] <= entry["end_line"] <= len(path.read_text().splitlines()):
            errors.append(f"invalid_source_range: {entry['id']}")

    upstream_status = git(FIRSTMATE, "status", "--porcelain")
    if upstream_status:
        errors.append("firstmate_checkout_dirty")
    if git(FIRSTMATE, "rev-parse", "HEAD") != upstream["commit"]:
        errors.append("firstmate_commit_changed")
    if git(ROOT, "rev-parse", "HEAD") != baseline["head"]:
        errors.append("osstack_head_changed")
    initial_status = (EVIDENCE / "osstack-initial-status.txt").read_text().splitlines()
    # --porcelain paths/status, excluding new research artifacts and existing untracked dirs.
    initial_tracked = sorted(line for line in initial_status if line and not line.startswith("??"))
    current_status = subprocess.check_output(
        ["git", "-C", str(ROOT), "status", "--porcelain"], text=True
    ).splitlines()
    current_tracked = sorted(line for line in current_status if line and not line.startswith("??"))
    if initial_tracked != current_tracked:
        errors.append("tracked_status_changed_since_baseline")

    checked_links = 0
    for doc in DOCS:
        content = doc.read_text()
        if sum(line.startswith("```") for line in content.splitlines()) % 2:
            errors.append(f"unbalanced_code_fence: {doc.name}")
        for target in re.findall(r"\]\(([^)]+)\)", content):
            if target.startswith(("https://", "http://", "#")):
                continue
            target = target.split("#")[0].strip("<>")
            target = re.sub(r":\d+$", "", target)
            if not (doc.parent / target).exists() and (doc.parent / target).resolve() not in {EVIDENCE / "final-validation.json", EVIDENCE / "artifact-manifest.json"}:
                errors.append(f"broken_link: {doc.name} -> {target}")
            checked_links += 1

    models = []
    for path in sorted(EVIDENCE.glob("claude-round*.json")):
        raw = json.loads(path.read_text())
        extracted = path.with_suffix(".md")
        if raw.get("is_error") or not raw.get("result"):
            errors.append(f"review_failed: {path.name}")
        if extracted.read_text().strip() != raw["result"].strip():
            errors.append(f"review_raw_mismatch: {path.name}")
        usage = raw.get("modelUsage", {})
        if "claude-fable-5-1" not in usage:
            errors.append(f"unexpected_model: {path.name}")
        models.append({"file": path.name, "model_ids": list(usage), "duration_ms": raw.get("duration_ms"), "is_error": raw.get("is_error")})

    json_count = 0
    for path in EVIDENCE.glob("*.json"):
        json.loads(path.read_text())
        json_count += 1
    tests = json.loads((EVIDENCE / "upstream-validation.json").read_text())
    if tests["ok_lines"] != 81 or tests["not_ok_lines"] != 0 or any(x["exit_code"] != 0 or x["gate_skip"] for x in tests["suites"]):
        errors.append("upstream_suite_record_not_passing")

    result = {
        "validated_at_utc": datetime.now(timezone.utc).isoformat(),
        "passed": not errors,
        "errors": errors,
        "firstmate_commit": upstream["commit"],
        "firstmate_status": upstream_status,
        "firstmate_baseline_files_checked": len(upstream["files"]),
        "osstack_head": baseline["head"],
        "osstack_baseline_files_checked": len(baseline["files"]),
        "tracked_status_unchanged": initial_tracked == current_tracked,
        "source_index_entries_checked": len(source_index),
        "document_links_checked": checked_links,
        "json_files_parsed": json_count,
        "reviews": models,
        "limits": "Document/source integrity only; no new OSStack runtime functionality, no production DB access, no full upstream suite or live backend verification.",
    }
    (EVIDENCE / "final-validation.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    # Avoid a circular checksum: the manifest does not hash itself.
    artifacts = sorted(set(DOCS + [p for p in EVIDENCE.iterdir() if p.is_file() and p.name != "artifact-manifest.json"]))
    (EVIDENCE / "artifact-manifest.json").write_text(json.dumps([
        {"path": str(p.relative_to(ROOT)), "bytes": p.stat().st_size, "sha256": sha(p)}
        for p in artifacts
    ], ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if not errors else 1)


if __name__ == "__main__":
    run()
