# Evidence archive / 证据归档

The original inputs, model responses, logs and scenario matrix remain byte-for-byte at commit `cf3bc68c71c336b59d0b3735b24bcd22209813b0` on the retained `codex/capability-registry-pilot` branch. [Integrity index](archive-index.json) records every archived file, its SHA-256, byte count and immutable GitHub link. This split does not delete that branch or rewrite the original commit.

原始材料是历史证据，不代表拆分后各 PR 的 CI 已通过。特别是原 #251 的 GitHub CI 存在一项 drain 测试竞态；修复及新验证见[拆分报告](../../../reports/2026-10-26-pr251-split.md)。旧测试日志和旧审计输入保持原样。

[本次拆分复审](split-2026-10-26/README.md)保存三轮小型模型返回、哈希和处置。

[Sonnet 逐项处置](sonnet-5.5/disposition.md)保留在当前树中。该报告的冻结来源、原始模型返回与执行日志通过固定提交链接读取。真实环境缺口保持未验证。

To verify the archived bytes without executing them:

```sh
git fetch origin codex/capability-registry-pilot
python3 - <<'PYTHON'
import hashlib, json, subprocess
from pathlib import Path
index = json.loads(Path("docs/design/2026-10-25-engineering-agent/evidence/archive-index.json").read_text())
for entry in index["files"]:
    data = subprocess.check_output(["git", "show", index["source_commit"] + ":" + entry["path"]])
    assert len(data) == entry["bytes"]
    assert hashlib.sha256(data).hexdigest() == entry["sha256"]
print("Archived evidence hashes match")
PYTHON
```
