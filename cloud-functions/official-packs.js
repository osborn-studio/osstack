export const officialPacks = [
  {
    "id": "osstack-core/agent-routing-policy",
    "version": "2026.06.22",
    "name": "Osstack Agent Routing Policy",
    "license": "Osstack-native",
    "source_kind": "osstack_native",
    "quality_score": 91,
    "scope": "official",
    "taxonomy": ["osstack-core/agent-routing-policy"],
    "generated_at": "2026-06-22T00:00:00.000Z",
    "last_reviewed_at": "2026-06-22T00:00:00.000Z",
    "review": {
      "status": "approved",
      "reviewer_id": "osstack-knowledge-review",
      "reviewed_at": "2026-06-22T00:00:00.000Z",
      "summary": "Reviewed as osstack-native official knowledge for Knowledge Cloud publication."
    },
    "source_attribution": ["osstack-native product knowledge"],
    "source_provenance": [
      {
        "source_id": "osstack-product-skills-and-agent-registry",
        "path": "docs/product/06_SKILLS_AND_AGENT_REGISTRY.md",
        "sha256": "444fad67a4e00b503b76cb01c5b2a035b58e90d545f54682375394e912a8b9ad",
        "license": "Osstack-native",
        "scope": "official",
        "imported_at": "2026-06-22T00:00:00.000Z"
      }
    ],
    "chunks": [
      {
        "chunk_id": "routing-scorecard",
        "title": "Agent scorecard routing",
        "body": "Osstack routing should explain why an agent was selected using capability fit, cost tier, recent failures, success rate, and policy decisions recorded in the run evidence.",
        "tags": ["agent", "routing", "policy", "scorecard"],
        "source_refs": ["osstack-native"]
      }
    ]
  },
  {
    "id": "osstack-core/architecture-control-plane",
    "version": "2026.06.23",
    "name": "Osstack Architecture Control Plane",
    "license": "Osstack-native",
    "source_kind": "osstack_native",
    "quality_score": 93,
    "scope": "official",
    "taxonomy": ["osstack-core/architecture-control-plane", "software-engineering/architecture"],
    "generated_at": "2026-06-23T00:00:00.000Z",
    "last_reviewed_at": "2026-06-23T00:00:00.000Z",
    "review": {
      "status": "approved",
      "reviewer_id": "osstack-knowledge-review",
      "reviewed_at": "2026-06-23T00:00:00.000Z",
      "summary": "Reviewed as Osstack-native architecture knowledge after translating the UmaDev reference taxonomy into Osstack control-plane language."
    },
    "source_attribution": ["osstack-native product knowledge"],
    "source_provenance": [
      {
        "source_id": "osstack-system-architecture",
        "path": "docs/product/04_SYSTEM_ARCHITECTURE.md",
        "sha256": "93e961699d2643ffb459263026b9017593654e7161ca8fe9d98724ba392a15d8",
        "license": "Osstack-native",
        "scope": "official",
        "imported_at": "2026-06-23T00:00:00.000Z"
      },
      {
        "source_id": "osstack-umadev-code-benchmark",
        "path": "docs/external/2026-06-23-umadev-code-benchmark.md",
        "sha256": "f4b6e89dbf837f22a1297f449cacd84d46b09b2c4da0aa5f956bb978b5215ff2",
        "license": "Osstack-native analysis",
        "scope": "official",
        "imported_at": "2026-06-23T00:00:00.000Z"
      }
    ],
    "chunks": [
      {
        "chunk_id": "architecture-control-plane",
        "title": "TypeScript control-plane architecture",
        "body": "Osstack should keep its TypeScript control plane as the product center: CLI, daemon, loop engine, agent routing, worktree isolation, governance, proof packs, and Knowledge Cloud are one evidence-oriented architecture rather than a forked Rust shell.",
        "tags": ["architecture", "control-plane", "daemon", "loop"],
        "source_refs": ["osstack-system-architecture", "osstack-umadev-code-benchmark"]
      }
    ]
  },
  {
    "id": "osstack-core/contract-validation",
    "version": "2026.06.23",
    "name": "Osstack Contract Validation",
    "license": "Osstack-native",
    "source_kind": "osstack_native",
    "quality_score": 92,
    "scope": "official",
    "taxonomy": ["osstack-core/contract-validation", "software-engineering/development"],
    "generated_at": "2026-06-23T00:00:00.000Z",
    "last_reviewed_at": "2026-06-23T00:00:00.000Z",
    "review": {
      "status": "approved",
      "reviewer_id": "osstack-knowledge-review",
      "reviewed_at": "2026-06-23T00:00:00.000Z",
      "summary": "Reviewed as Osstack-native contract-validation knowledge after adapting the UmaDev contract-layer lesson into Osstack proof evidence."
    },
    "source_attribution": ["osstack-native product knowledge"],
    "source_provenance": [
      {
        "source_id": "osstack-task-breakdown",
        "path": "docs/product/10_TASK_BREAKDOWN.md",
        "sha256": "53c03f0ae34d15c134feaef2a57f3a98a21139c8c93d0752a638eb086e68b374",
        "license": "Osstack-native",
        "scope": "official",
        "imported_at": "2026-06-23T00:00:00.000Z"
      },
      {
        "source_id": "osstack-umadev-code-benchmark",
        "path": "docs/external/2026-06-23-umadev-code-benchmark.md",
        "sha256": "f4b6e89dbf837f22a1297f449cacd84d46b09b2c4da0aa5f956bb978b5215ff2",
        "license": "Osstack-native analysis",
        "scope": "official",
        "imported_at": "2026-06-23T00:00:00.000Z"
      }
    ],
    "chunks": [
      {
        "chunk_id": "contract-validation-proof",
        "title": "Contract validation proof evidence",
        "body": "Osstack contract validation should compare frontend fetch calls, backend routes, and osstack.contracts.json expectations, then write contract-validation.json into proof packs so API alignment becomes release evidence.",
        "tags": ["contracts", "api", "proof", "frontend", "backend"],
        "source_refs": ["osstack-task-breakdown", "osstack-umadev-code-benchmark"]
      }
    ]
  },
  {
    "id": "osstack-core/loop-engineering",
    "version": "2026.06.22",
    "name": "Osstack Loop Engineering",
    "license": "Osstack-native",
    "source_kind": "osstack_native",
    "quality_score": 92,
    "scope": "official",
    "taxonomy": ["osstack-core/loop-engineering"],
    "generated_at": "2026-06-22T00:00:00.000Z",
    "last_reviewed_at": "2026-06-22T00:00:00.000Z",
    "review": {
      "status": "approved",
      "reviewer_id": "osstack-knowledge-review",
      "reviewed_at": "2026-06-22T00:00:00.000Z",
      "summary": "Reviewed as osstack-native official knowledge for Knowledge Cloud publication."
    },
    "source_attribution": ["osstack-native product knowledge"],
    "source_provenance": [
      {
        "source_id": "osstack-run-spec-v1",
        "path": "docs/specs/OSSTACK_RUN_SPEC_V1.md",
        "sha256": "2e462b514cb62a073c4ed720cbcfb5324233890c826d17cf813509809eb04223",
        "license": "Osstack-native",
        "scope": "official",
        "imported_at": "2026-06-22T00:00:00.000Z"
      }
    ],
    "chunks": [
      {
        "chunk_id": "loop-hot-loop",
        "title": "Hot-loop execution",
        "body": "Osstack loop engineering turns a task queue or git diff into repeated execute, verify, review, and iterate cycles until the goal passes or escalation is required.",
        "tags": ["loop", "iterate", "verify"],
        "source_refs": ["osstack-native"]
      }
    ]
  },
  {
    "id": "osstack-core/operations-runbook",
    "version": "2026.06.23",
    "name": "Osstack Operations Runbook",
    "license": "Osstack-native",
    "source_kind": "osstack_native",
    "quality_score": 91,
    "scope": "official",
    "taxonomy": ["osstack-core/operations-runbook", "software-engineering/operations"],
    "generated_at": "2026-06-23T00:00:00.000Z",
    "last_reviewed_at": "2026-06-23T00:00:00.000Z",
    "review": {
      "status": "approved",
      "reviewer_id": "osstack-knowledge-review",
      "reviewed_at": "2026-06-23T00:00:00.000Z",
      "summary": "Reviewed as Osstack-native operations knowledge for release, cloud health, and rollback guidance."
    },
    "source_attribution": ["osstack-native product knowledge"],
    "source_provenance": [
      {
        "source_id": "osstack-runbook",
        "path": "docs/product/12_RUNBOOK.md",
        "sha256": "f1b1679dc7fc7b86b1ec49224c91efd3ffb880beef0a3a6e5a5c529f080978b7",
        "license": "Osstack-native",
        "scope": "official",
        "imported_at": "2026-06-23T00:00:00.000Z"
      },
      {
        "source_id": "osstack-umadev-code-benchmark",
        "path": "docs/external/2026-06-23-umadev-code-benchmark.md",
        "sha256": "f4b6e89dbf837f22a1297f449cacd84d46b09b2c4da0aa5f956bb978b5215ff2",
        "license": "Osstack-native analysis",
        "scope": "official",
        "imported_at": "2026-06-23T00:00:00.000Z"
      }
    ],
    "chunks": [
      {
        "chunk_id": "operations-release-runbook",
        "title": "Release and Knowledge Cloud operations",
        "body": "Osstack operations should use release doctor, release plan, release handoff, npm validation, EdgeOne Knowledge Cloud health checks, search checks, audit checks, feedback summaries, rollback notes, and proof packs as the standard release runbook.",
        "tags": ["operations", "release", "edgeone", "runbook"],
        "source_refs": ["osstack-runbook", "osstack-umadev-code-benchmark"]
      }
    ]
  },
  {
    "id": "osstack-core/pr-and-release",
    "version": "2026.06.22",
    "name": "Osstack PR and Release",
    "license": "Osstack-native",
    "source_kind": "osstack_native",
    "quality_score": 90,
    "scope": "official",
    "taxonomy": ["osstack-core/pr-and-release"],
    "generated_at": "2026-06-22T00:00:00.000Z",
    "last_reviewed_at": "2026-06-22T00:00:00.000Z",
    "review": {
      "status": "approved",
      "reviewer_id": "osstack-knowledge-review",
      "reviewed_at": "2026-06-22T00:00:00.000Z",
      "summary": "Reviewed as osstack-native official knowledge for Knowledge Cloud publication."
    },
    "source_attribution": ["osstack-native product knowledge"],
    "source_provenance": [
      {
        "source_id": "osstack-report-templates-and-outputs",
        "path": "docs/product/07_REPORT_TEMPLATES_AND_OUTPUTS.md",
        "sha256": "74b613fd7225d3eae406f1bde5b33c8e570e4638fd1a8d1ea5ed736d0da85b4b",
        "license": "Osstack-native",
        "scope": "official",
        "imported_at": "2026-06-22T00:00:00.000Z"
      }
    ],
    "chunks": [
      {
        "chunk_id": "pr-evidence-body",
        "title": "PR evidence body",
        "body": "Osstack PR bodies summarize tasks completed, agent selection, policy reasoning, verification, governance findings, reviewer output, proof pack path, risks, and manual fallback steps.",
        "tags": ["pr", "release", "evidence"],
        "source_refs": ["osstack-native"]
      }
    ]
  },
  {
    "id": "osstack-core/proof-and-scorecard",
    "version": "2026.06.22",
    "name": "Osstack Proof and Scorecard",
    "license": "Osstack-native",
    "source_kind": "osstack_native",
    "quality_score": 94,
    "scope": "official",
    "taxonomy": ["osstack-core/proof-and-scorecard"],
    "generated_at": "2026-06-22T00:00:00.000Z",
    "last_reviewed_at": "2026-06-22T00:00:00.000Z",
    "review": {
      "status": "approved",
      "reviewer_id": "osstack-knowledge-review",
      "reviewed_at": "2026-06-22T00:00:00.000Z",
      "summary": "Reviewed as osstack-native official knowledge for Knowledge Cloud publication."
    },
    "source_attribution": ["osstack-native product knowledge"],
    "source_provenance": [
      {
        "source_id": "osstack-report-templates-and-outputs",
        "path": "docs/product/07_REPORT_TEMPLATES_AND_OUTPUTS.md",
        "sha256": "74b613fd7225d3eae406f1bde5b33c8e570e4638fd1a8d1ea5ed736d0da85b4b",
        "license": "Osstack-native",
        "scope": "official",
        "imported_at": "2026-06-22T00:00:00.000Z"
      }
    ],
    "chunks": [
      {
        "chunk_id": "proof-checksum-pack",
        "title": "Checksumed proof packs",
        "body": "Osstack proof packs collect report, scorecard, loop state, events, verify results, governance findings, knowledge traces, worktree status, and a manifest with SHA-256 checksums.",
        "tags": ["proof", "scorecard", "checksum", "evidence"],
        "source_refs": ["osstack-native"]
      }
    ]
  },
  {
    "id": "osstack-core/testing-and-eval",
    "version": "2026.06.23",
    "name": "Osstack Testing And Eval Gates",
    "license": "Osstack-native",
    "source_kind": "osstack_native",
    "quality_score": 92,
    "scope": "official",
    "taxonomy": ["osstack-core/testing-and-eval", "software-engineering/testing"],
    "generated_at": "2026-06-23T00:00:00.000Z",
    "last_reviewed_at": "2026-06-23T00:00:00.000Z",
    "review": {
      "status": "approved",
      "reviewer_id": "osstack-knowledge-review",
      "reviewed_at": "2026-06-23T00:00:00.000Z",
      "summary": "Reviewed as Osstack-native testing knowledge with retrieval fixtures before official publication."
    },
    "source_attribution": ["osstack-native product knowledge"],
    "source_provenance": [
      {
        "source_id": "osstack-test-and-eval-plan",
        "path": "docs/product/11_TEST_AND_EVAL_PLAN.md",
        "sha256": "0c2defcbfd10ff455e880e480d6745985e450b04f0070c1744f947a27d5716d7",
        "license": "Osstack-native",
        "scope": "official",
        "imported_at": "2026-06-23T00:00:00.000Z"
      },
      {
        "source_id": "osstack-umadev-code-benchmark",
        "path": "docs/external/2026-06-23-umadev-code-benchmark.md",
        "sha256": "f4b6e89dbf837f22a1297f449cacd84d46b09b2c4da0aa5f956bb978b5215ff2",
        "license": "Osstack-native analysis",
        "scope": "official",
        "imported_at": "2026-06-23T00:00:00.000Z"
      }
    ],
    "chunks": [
      {
        "chunk_id": "testing-eval-gates",
        "title": "Retrieval and proof eval gates",
        "body": "Osstack testing should prove each product slice with deterministic Vitest coverage, retrieval eval fixtures, publish-gate validation, npm install smoke, proof validation, and Knowledge Cloud deployment smoke before release.",
        "tags": ["testing", "eval", "smoke", "retrieval"],
        "source_refs": ["osstack-test-and-eval-plan", "osstack-umadev-code-benchmark"]
      }
    ]
  },
  {
    "id": "osstack-core/verifier-and-governance",
    "version": "2026.06.22",
    "name": "Osstack Verifier and Governance",
    "license": "Osstack-native",
    "source_kind": "osstack_native",
    "quality_score": 90,
    "scope": "official",
    "taxonomy": ["osstack-core/verifier-and-governance"],
    "generated_at": "2026-06-22T00:00:00.000Z",
    "last_reviewed_at": "2026-06-22T00:00:00.000Z",
    "review": {
      "status": "approved",
      "reviewer_id": "osstack-knowledge-review",
      "reviewed_at": "2026-06-22T00:00:00.000Z",
      "summary": "Reviewed as osstack-native official knowledge for Knowledge Cloud publication."
    },
    "source_attribution": ["osstack-native product knowledge"],
    "source_provenance": [
      {
        "source_id": "osstack-system-architecture",
        "path": "docs/product/04_SYSTEM_ARCHITECTURE.md",
        "sha256": "93e961699d2643ffb459263026b9017593654e7161ca8fe9d98724ba392a15d8",
        "license": "Osstack-native",
        "scope": "official",
        "imported_at": "2026-06-22T00:00:00.000Z"
      }
    ],
    "chunks": [
      {
        "chunk_id": "governance-fail-open",
        "title": "Fail-open governance verifier",
        "body": "Osstack governance is deterministic and should default to fail-open warnings unless strict mode is requested, while still recording findings in report, scorecard, proof, and PR evidence.",
        "tags": ["governance", "verifier", "fail-open"],
        "source_refs": ["osstack-native"]
      }
    ]
  },
  {
    "id": "osstack-core/worktree-safety",
    "version": "2026.06.22",
    "name": "Osstack Worktree Safety",
    "license": "Osstack-native",
    "source_kind": "osstack_native",
    "quality_score": 89,
    "scope": "official",
    "taxonomy": ["osstack-core/worktree-safety"],
    "generated_at": "2026-06-22T00:00:00.000Z",
    "last_reviewed_at": "2026-06-22T00:00:00.000Z",
    "review": {
      "status": "approved",
      "reviewer_id": "osstack-knowledge-review",
      "reviewed_at": "2026-06-22T00:00:00.000Z",
      "summary": "Reviewed as osstack-native official knowledge for Knowledge Cloud publication."
    },
    "source_attribution": ["osstack-native product knowledge"],
    "source_provenance": [
      {
        "source_id": "osstack-system-architecture",
        "path": "docs/product/04_SYSTEM_ARCHITECTURE.md",
        "sha256": "93e961699d2643ffb459263026b9017593654e7161ca8fe9d98724ba392a15d8",
        "license": "Osstack-native",
        "scope": "official",
        "imported_at": "2026-06-22T00:00:00.000Z"
      }
    ],
    "chunks": [
      {
        "chunk_id": "worktree-isolation",
        "title": "Worktree isolation evidence",
        "body": "Osstack uses git worktrees to isolate attempts, keep failed iterations away from the main workspace, and record branch and commit context in proof evidence.",
        "tags": ["worktree", "isolation", "git"],
        "source_refs": ["osstack-native"]
      }
    ]
  }
];
