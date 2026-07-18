# neat R0 golden evaluation

Label source: Accepted neat product specification section 15.4, frozen before final tuning.

The scorer is a separate deterministic process from the production engine and consumes only strict CLI JSON plus the frozen label manifest. The maker also ran this first score, so self-evaluation bias remains declared; release-owner review is still required before publication.

## Result

| Metric | Result | Gate |
|---|---:|---:|
| Scenario classes | 12 | 12 |
| Blocking precision | 100.0% | >=95% |
| Warning precision | 80.0% | >=80% |
| False negatives | 0 | 0 |

## Scenario review

| Scenario | Expected labels | Actual findings | Review |
|---|---|---|---|
| 01-clean-agents-canonical: clean osstack-style AGENTS canonical repository | none | none | matches labels |
| 02-valid-claude-import: valid one-line CLAUDE import | none | none | matches labels |
| 03-valid-symlink-mirror: valid symlink mirror | none | none | matches labels |
| 04-conflicting-instructions: independent conflicting instruction files | `error|instruction.mirror_drift|CLAUDE.md` | `error|instruction.mirror_drift|CLAUDE.md` | matches labels |
| 05-docs-only: docs-only repository with no instructions | none | none | matches labels |
| 06-missing-required-surface: missing configured required surface | `warning|surface.required_missing|docs/architecture.md` | `warning|surface.required_missing|docs/architecture.md` | matches labels |
| 07-relative-links: valid and broken relative Markdown links | `warning|reference.markdown_target_missing|docs/guide.md`<br>`warning|reference.markdown_target_missing|docs/other.md` | `warning|reference.markdown_target_missing|docs/guide.md`<br>`warning|reference.markdown_target_missing|docs/other.md` | matches labels |
| 08-code-fence-paths: code fences containing path-like text | none | none | matches labels |
| 09-advisory-contract: TypeScript change triggering an advisory contract | `warning|contract.review_required|src/app.ts` | `warning|contract.review_required|src/app.ts` | matches labels |
| 10-reviewed-no-target-edit: triggered contract reviewed with no target edit | none | `warning|contract.review_required|src/app.ts` | labelled false positive: `warning|contract.review_required|src/app.ts` |
| 11-non-git-full-audit: non-Git full audit | none | none | matches labels |
| 12-scan-limit-incomplete: scan-limit/incomplete repository | `error|scan.incomplete|.` | `error|scan.incomplete|.` | matches labels |

## Error analysis

- False positives: `10-reviewed-no-target-edit:warning|contract.review_required|src/app.ts`.
- False negatives: none.
- The sole expected false positive is the R0 change-contract limitation: a real human review without a review-target edit cannot yet be represented. R1 `reviewed_no_change` resolution evidence is the planned closure path.
- No fixture accesses network services, user memory, or the real home directory; every repository is generated under a temporary directory and removed after scoring.

## Reproduce

```bash
pnpm eval:neat-goldens
```
