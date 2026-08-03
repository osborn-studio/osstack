# Probe Production-Acceptance Dogfood Intent

Probe is implemented, tested, and published in `@osstack/cli@0.14.0`, but the
repository does not yet have enough real-use evidence to claim production
acceptance.

## Production acceptance behavior

The owner accepted the following observable behavior on 2026-08-03:

> 全新安装后，CLI 与 daemon 版本一致，doctor 全部通过；Neat 能发现并安全修复知识卫生问题；Probe 能生成可审计产物；全过程不得发生未授权写入或泄露凭证。

The dogfood program must establish all of the following without inventing or
backfilling evidence:

1. The stable daemon and installed CLI run the same current release.
2. The repository Probe skill is installed through the supported skill path.
3. The repository carries an explicit report-only Probe policy and portable
   rendered session evidence.
4. Report-only use runs for at least fourteen real elapsed days without a
   false blocking incident.
5. At least five genuinely rough product or technical specifications complete
   the skill-driven, one-question-at-a-time workflow with repository-backed
   evidence for every dynamic item.
6. A human audit of `probe restate` finds no systematic pattern where mere text
   differences are treated as semantic errors.
7. The collected outcomes are sufficient for the owner to freeze a baseline;
   otherwise observation continues and no completion claim is made.

This bootstrap may create the report-only configuration, the first durable
session, and its portable artifact set. It must not enable block mode, answer
owner questions on the owner's behalf, fabricate elapsed time or task counts,
or mark the remaining design checkpoints complete before their evidence
exists.
