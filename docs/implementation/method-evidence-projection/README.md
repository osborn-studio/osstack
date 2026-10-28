# Model-readable fixed journey evidence

This tool makes a small input packet from a sealed healthy/missing-ref journey. It opens the machine evidence read-only. Its CLI receipt reports `input_opened_read_only:true`, not a measured whole-tree immutability assertion. It does not run a driver, model, database, network request or credential lookup.

Use an absolute path to an existing journey directory. Select a new absolute output directory under the configured `OSSTACK_SCRATCH_ROOT` (or the platform temporary directory plus `osstack`). The output parent must exist. Keep this output separate from the original evidence.

```sh
node scripts/project-method-journey-evidence.mjs --input /absolute/machine-journey --output /absolute/scratch/osstack/runtime/new-model-packet
node scripts/project-method-journey-evidence.mjs --check /absolute/scratch/osstack/runtime/new-model-packet
```

These are the only CLI forms. Projection and check return exit 0 on success, exit 1 on rejection, and exit 2 for invalid arguments. CLI failures expose fixed lowercase error codes; path-bearing filesystem errors use a generic code. The projection process can succeed when the recorded journey failed. Its receipt means that a packet was produced, not that the product passed. It refuses an existing output, overlapping input/output trees, incomplete sealing, symlink evidence entries and files that do not match a manifest. A write failure can leave a partial new directory; check rejects it. Use another new directory after investigating a failure.

## Packet contract

The output contains exactly `packet.json` and `manifest.json`. `--check` validates the exact inventory, bounded regular files, canonical JSON bytes, manifest hash and recursive closed schema. It rejects additional fields at every projected object level, duplicate-key encodings, extra files, arbitrary reference IDs and non-allowlisted snippets, even if the packet manifest was re-signed. Canonical JSON uses the writer's two-space indentation, property order and trailing newline.

`packet.json` contains:

- Fixed version/kind and scope: healthy/missing-ref; drift/mixed/empty omitted; no live revalidation, model execution or formal gate.
- Recorded journey status and whether a failure was recorded. Arbitrary failure text is omitted.
- Exactly two feature rows, in fixed order. Rows contain verification, product/driver exits, product status, evidence state, cleanup, reported cleanup, cleanup consistency, and source/build digests. A failed or not-run row cannot present a verified product exit or healthy product status. `reported_product_exit` stays separate from `product_exit`. `reported_cleanup` is explicitly an unverified receipt claim; a failed receipt can disagree with `cleanup.json` while the journey's actual cleanup remains unknown. The mismatch is retained as `receipt_cleanup_consistent:false`. A `not_started` cleanup has `fixture_removed:null`; it cannot claim a cleanup action. Non-passed verification keeps cleanup unknown or not started, with no verified removal. A `not_created` row has no reported product/cleanup or binding evidence. A passed row has no unverified reported product exit.
- Logical evidence IDs, original byte lengths and SHA-256 hashes. IDs have a fixed vocabulary such as `journey.receipt` or `missing-ref.product.stdout`. There is no original local path or resolver in the packet.
- At most four stream views. Only exact fixed CLI summary/outcome lines can appear, at most eight lines and 1,024 selected bytes per view. Newline separators and all unselected bytes count as omitted. Selected lines in a passed row must agree with that case's fixed identity and failed-check count. A healthy passed row cannot carry a one-failure summary. No arbitrary stderr text crosses the boundary. Its hash, byte length and omission count remain available.

The package has no environment objects, environment values, argv/cwd records, socket paths, raw command files or full binding lists. Unknown source fields and arbitrary failure text are not forwarded. Only copy this two-file packet into a model workspace. Keep the original machine evidence outside the model's readable workspace. The tool does not change a host's filesystem permissions or prevent a separately exposed original from being read.

Limits are fixed: each input file at most 8 MiB, at most 128 members and 32 MiB per sealed directory, at most two case directories, at most 22 logical references, packet at most 64 KiB, packet manifest at most 4 KiB. Input members use one flat filename component. Directory enumeration stops at 132 entries for a root, 129 for a case, two for the case list and two for the packet. Read buffers are sized to the file and returned without retaining an 8 MiB backing buffer for each tiny member. These are resource bounds for this format, not a generic evidence platform.

## Input integrity and meaning

The projector reads the final `journey-manifest.json`, verifies its retained file hashes, and binds each sealed case manifest to its declared hash. Every case manifest member is checked. Extra flat files and unexpected case directories are rejected. A created case with no sealed manifest or receipt is rejected. A legitimate `not_created` row after a failed doctor is kept; the untouched second case remains `not_run`.

For a recorded passed case, the projector reuses the existing `evaluateCase` predicate against retained command output and input hashes. It requires `run.json`, checks manifest/receipt/run identity, passed run/receipt state, unchanged run bindings, input identity, command/detail agreement, and receipt/cleanup/binding consistency. A successful journey must use matching source/build digests across both cases. Source/build digest lists are hash-checked but not copied to the model packet. A driver may report passed before the enclosing verifier fails. Its row remains failed with unknown cleanup; reported outcomes remain unverified. A late journey-level failure does not erase previously verified rows, including two individually passed rows with a cross-case binding mismatch that made the journey fail. Expected missing-ref product exit 1 is an unrecovered failed source, even when its driver exit is 0.

This is retained-file consistency and a projection of recorded claims. It does not authenticate the producer, repeat the complete original verifier, recheck a live checkout, prove a compiler invocation, re-observe fixture removal, or attest descendant termination. The full original verifier checks live fixture ownership and absolute execution identity; replaying it on a portable historical archive would conflate those checks with this operation. The standalone packet check has no original-evidence access and cannot prove that a producer honestly generated a re-signed packet. Keep the machine archive and its hashes for separate audit.

## Validation and follow-up

Run the targeted tests with:

```sh
node --test scripts/project-method-journey-evidence.test.mjs
```

Tests cover the real CLI surface, expected-negative preservation, failed/not-run/unknown states, contradictory raw results, integrity failures, file escape/symlink cases, output ownership and re-signed forbidden packet fields. The author also projected the existing real two-case journey and compared all original file hashes before and after. Controlled historical failure seams are separately identified as synthetic failure evidence, not new product executions.

This change addresses the input design conflict exposed by the earlier host-assisted experiment. It does not repair the old Codex environment-reading boundary failure, the Claude response-length failure, or an unknown model identity. A future host experiment needs its own explicit packet-reading protocol, word-count criterion, independent freeze and call authorization. No new host experiment is included here.

The current projection also rejects a sealed early driver failure whose cleanup status is `not_required` (for example, failure before fixture allocation). This is an unsupported retained failure shape, alongside unsealed evidence; keep its raw machine evidence for audit. Rejection is not evidence of a healthy product. No claim is made to project every possible driver failure.

## Delivery evidence

The final projector source is author `1cfbf3ad`, integrated with the method recipe and CI at root `6512cde7`. It passed 49 focused tests; the recipe/export suite passed 74. Independent validation retained the original 33 challenges, then ran 24 explicitly post-audit calls. First failures remain archived. Actual Sonnet 5.5 review requested changes; F1–F5 closure passed as a static review, with candidate bytes separately bound by root. Reference review likewise closed its two blockers; actual exports and shell execution supply separate evidence.

The package full regression passed 7,144 tests with 5 skips at `c04f7ed2`. Later standalone-script and material changes have final focused, real projection and independent coverage; that earlier full run is not relabelled a final whole-tree run. Current published-head CI is still required. See [evidence manifest](evidence/manifest.json), [root full summary](evidence/full-summary.json), and [independent final validation](evidence/independent-final.md). The archive preserves all original audit reports, intermediate failures, commands, source bindings and author evidence. No new model-host experiment was performed.
