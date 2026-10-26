# Capability registry / 能力注册表

This machine-readable design registry records 24 Firstmate capabilities, 74 fixed source anchors, 66 staged scenarios, and 37 work items. It does not activate runtime features or grant authority.

这是设计注册表。运行时启用状态保持关闭；本地测试、模型审计和生产资格是不同证据。

The [2026-10-26 adoption roadmap](../2026-10-26-firstmate-upgrade/README.md) adds current scope, source anchors and 50 mapped work packages. It preserves these frozen records. 新路线图补充当前交付范围与后续工作，不改写此处的历史验证状态。

Run the structural and dependency validator with Python 3 and `jsonschema >= 4`:

```sh
python3 docs/design/2026-10-25-engineering-agent/validate-design.py
```

Use `--verify-sources --osstack-repo PATH --firstmate-repo PATH` to verify the 74 hashes against fixed Git objects. This only reads source objects; it does not open an OSStack database.

- [Capabilities](capabilities.json) · [schema](capability-registry.schema.json)
- [Source anchors](sources.json) · [staged scenarios](pilot-scenarios.json)
- [Work items](work-items.json) · [qualification shape](qualification-contract.schema.json)
- [Permitted semantic differences](semantic-divergences.json)

The architecture prose and user guides follow in separate PRs in the #251 replacement stack. [Original frozen design](https://github.com/osborn-studio/osstack/blob/cf3bc68c71c336b59d0b3735b24bcd22209813b0/docs/design/2026-10-25-engineering-agent/README.md).
