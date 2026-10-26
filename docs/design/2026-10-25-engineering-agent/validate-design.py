#!/usr/bin/env python3
"""Validate this design registry. Does not run OSStack or open its database.

Requires Python 3 and jsonschema >= 4. Run with --verify-sources to hash pinned
Git objects in both local repositories. Runtime qualification is not implied.
"""

import argparse
import copy
import hashlib
import json
import pathlib
import subprocess

from jsonschema import Draft202012Validator, ValidationError


ROOT = pathlib.Path(__file__).resolve().parent


def read_json(name):
    return json.loads((ROOT / name).read_text(encoding="utf-8"))


def check(condition, message):
    if not condition:
        raise ValueError(message)


def validate(registry, schema, sources, scenarios):
    Draft202012Validator.check_schema(schema)
    Draft202012Validator(schema).validate(registry)
    expected = {f"FM-{number:02}" for number in range(1, 25)}
    capabilities = registry["capabilities"]
    ids = [item["id"] for item in capabilities]
    check(len(set(ids)) == 24 and set(ids) == expected, "Capability IDs must be exactly FM-01..FM-24")
    source_ids = [item["id"] for item in sources["sources"]]
    check(len(set(source_ids)) == len(source_ids), "Duplicate source ID")
    known_sources = set(source_ids)
    by_source = {item["id"]: item for item in sources["sources"]}
    graph = {}
    for item in capabilities:
        check(item["id"] == f'FM-{item["ledger_number"]:02}', "Ledger number drift")
        for field in ("upstream_refs", "osstack_refs", "existing_test_refs"):
            check(set(item[field]) <= known_sources, f"Missing source in {item['id']}")
        check(all(by_source[s]["repository"] == "firstmate" for s in item["upstream_refs"]), "Wrong upstream repository")
        check(all(by_source[s]["repository"] == "osstack" for s in item["osstack_refs"] + item["existing_test_refs"]), "Wrong target repository")
        dependencies = item["depends_on"]
        check(set(dependencies) <= expected, f"Unknown dependency in {item['id']}")
        check(item["id"] not in dependencies, "Self dependency")
        graph[item["id"]] = dependencies
    visiting, done = set(), set()

    def visit(node):
        check(node not in visiting, f"Dependency cycle at {node}")
        if node in done:
            return
        visiting.add(node)
        for dependency in graph[node]:
            visit(dependency)
        visiting.remove(node)
        done.add(node)

    for node in graph:
        visit(node)
    for source in sources["sources"]:
        check(source["commit"] == registry["baselines"][source["repository"]], "Source baseline drift")
        check(len(source["sha256"]) == 64, "Invalid source digest")
        check(source["commit"] in source["url"], "Source URL must pin a commit")
    scenario_ids = [item["id"] for item in scenarios["scenarios"]]
    check(len(scenario_ids) == len(set(scenario_ids)), "Duplicate scenario ID")
    for scenario in scenarios["scenarios"]:
        check(set(scenario["capability_ids"]) <= expected, "Unknown scenario capability")
        check(scenario["execution_status"] == "not_run", "Design scenario is not a runtime receipt")
        check(scenario["given"] and scenario["expected"], "Missing scenario contract")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-sources", action="store_true")
    parser.add_argument("--osstack-repo", type=pathlib.Path, default=ROOT.parents[2])
    parser.add_argument("--firstmate-repo", type=pathlib.Path, default=ROOT.parents[2].parent / "firstmate")
    args = parser.parse_args()
    registry = read_json("capabilities.json")
    schema = read_json("capability-registry.schema.json")
    sources = read_json("sources.json")
    scenarios = read_json("pilot-scenarios.json")
    validate(registry, schema, sources, scenarios)
    work_items = read_json("work-items.json")["work_items"]
    work_ids = {item["id"] for item in work_items}
    check(len(work_ids) == len(work_items), "Duplicate work item ID")
    remaining = {item["id"]: set(item["depends_on"]) for item in work_items}
    for item in work_items:
        check(item["state"] == "planned" and item["delivery_receipt"] is None, "Planned work is not a delivery receipt")
        check(remaining[item["id"]] <= work_ids, "Unknown work dependency")
    completed = set()
    while remaining:
        ready = {item for item, dependencies in remaining.items() if dependencies <= completed}
        check(bool(ready), "Work plan dependency cycle")
        completed.update(ready)
        for item in ready:
            del remaining[item]
    by_work = {item["id"]: item for item in work_items}
    pilot_dependencies = set()

    def collect_work(node):
        for dependency in by_work[node]["depends_on"]:
            if dependency not in pilot_dependencies:
                pilot_dependencies.add(dependency)
                collect_work(dependency)

    collect_work("D08")
    check(not any(item.startswith(("R", "E")) for item in pilot_dependencies), "Adoption pilot must not depend on registry or executor serviceization")
    check(not pilot_dependencies.intersection({"C03", "C04", "C05", "C06", "C07"}), "Adoption pilot must not require the full controller")
    check("C02" in pilot_dependencies, "Pilot requires Mission storage before dependent writes")
    stage_counts = {}
    for scenario in scenarios["scenarios"]:
        stage = scenario["delivery_stage"]
        check(stage in {"adopt_session", "runtime_registry", "integrated_controller", "production_qualification"}, "Unknown scenario stage")
        check(scenario["owner_work_item"] in work_ids, "Unknown scenario owner")
        if stage == "adopt_session":
            check(scenario["owner_work_item"] in pilot_dependencies | {"D08"}, "Pilot scenario introduces a hidden future dependency")
        else:
            check(scenario["owner_work_item"] not in pilot_dependencies | {"D08"}, "Later scenario cannot silently block the adoption pilot")
        stage_counts[stage] = stage_counts.get(stage, 0) + 1
    qualification_schema = read_json("qualification-contract.schema.json")
    Draft202012Validator.check_schema(qualification_schema)
    divergences = read_json("semantic-divergences.json")
    known_scenarios = {item["id"] for item in scenarios["scenarios"]}
    check(len({rule["id"] for rule in divergences["rules"]}) == len(divergences["rules"]), "Duplicate divergence ID")
    for rule in divergences["rules"]:
        check(set(rule["scenario_ids"]) <= known_scenarios, "Unknown divergence scenario")
        check(set(rule["capabilities"]) <= {item["id"] for item in registry["capabilities"]}, "Unknown divergence capability")

    # Check that the validator rejects the misleading states it is designed to catch.
    negative_cases = []
    for name in ("duplicate_id", "unknown_dependency", "dependency_cycle", "runtime_enabled", "missing_source"):
        modified = copy.deepcopy(registry)
        first = modified["capabilities"][0]
        if name == "duplicate_id":
            modified["capabilities"][1]["id"] = first["id"]
        elif name == "unknown_dependency":
            first["depends_on"] = ["FM-99"]
        elif name == "dependency_cycle":
            first["depends_on"] = ["FM-02"]
            modified["capabilities"][1]["depends_on"] = ["FM-01"]
        elif name == "runtime_enabled":
            first["activation"]["runtime_enabled"] = True
        else:
            first["upstream_refs"] = ["SRC-MISSING"]
        try:
            validate(modified, schema, sources, scenarios)
        except (ValueError, ValidationError):
            negative_cases.append(name)
        else:
            raise ValueError(f"Validator accepted invalid fixture: {name}")

    verified = 0
    if args.verify_sources:
        repositories = {"osstack": args.osstack_repo, "firstmate": args.firstmate_repo}
        for source in sources["sources"]:
            raw = subprocess.check_output(
                ["git", "show", f'{source["commit"]}:{source["path"]}'],
                cwd=repositories[source["repository"]],
            )
            check(hashlib.sha256(raw).hexdigest() == source["sha256"], f"Source changed: {source['id']}")
            verified += 1
    print(json.dumps({
        "status": "passed",
        "scope": "design_consistency_only",
        "capabilities": len(registry["capabilities"]),
        "planned_runtime_scenarios": len(scenarios["scenarios"]),
        "planned_scenarios_by_stage": stage_counts,
        "planned_work_items": len(work_items),
        "pilot_dependency_closure": sorted(pilot_dependencies),
        "qualification_schema": "shape_checked_only_no_signature_or_runtime_verification",
        "declared_semantic_divergences": len(divergences["rules"]),
        "source_anchors": len(sources["sources"]),
        "source_hashes_verified": verified,
        "invalid_fixtures_rejected": negative_cases,
        "production_runtime_verified": False,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
