# 原始 pstack 命名盘点

固定版本 `99b609a72323b70204eab407c622f436e858e112`；完整 pstack Git 对象，只读扫描，没有改上游或候选。

计数：{"tracked_files": 200, "utf8_files": 193, "skills_total_including_dormant_automation": 61, "registered_skills": 58, "dormant_automation_skills": 3, "agents": 2, "playbooks": 23, "principle_skills": 24, "matched_lines": 359, "unique_provenance_urls": 5}

## 建议品牌映射

| 类别 | 原标识 | 目标标识 |
| --- | --- | --- |
| plugin | `pstack` | `osstack` |
| skill | `poteto-mode` | `osstack-mode` |
| skill | `poteto-help` | `osstack-help` |
| skill | `setup-pstack` | `setup-osstack` |
| agent | `poteto-agent` | `osstack-agent` |
| namespace | `/pstack:<skill>` | `/osstack:<mapped-skill>` |
| agent_namespace | `pstack:poteto-agent / pstack:comment-sicko` | `osstack:osstack-agent / osstack:comment-sicko` |
| config | `~/.cursor/rules/pstack-models.mdc` | `~/.cursor/rules/osstack-models.mdc` |
| config | `~/.claude/rules/pstack-models.md` | `~/.claude/rules/osstack-models.md` |
| package | `@cursor-skill/poteto-mode-tools` | `@cursor-skill/osstack-mode-tools` |
| cache_marker | `.poteto-mode-tools-install-key` | `.osstack-mode-tools-install-key` |
| local_path | `skills/poteto-mode/**; skills/poteto-help/**; skills/setup-pstack/**; agents/poteto-agent.md; docs/guide/02-poteto-mode.md` | `skills/osstack-mode/**; skills/osstack-help/**; skills/setup-osstack/**; agents/osstack-agent.md; docs/guide/02-osstack-mode.md` |
| referenced_external_generator | `scripts/generate-pstack-harness-trees.mjs; harness/pstack/` | `scripts/generate-osstack-harness-trees.mjs; harness/osstack/` |

## 完整技能和 agent 清单

| 来源类型 | 原名称 | 目标名称 |
| --- | --- | --- |
| dormant automation skill | `reproduce-and-fix-issues` | `reproduce-and-fix-issues` |
| dormant automation skill | `setup-benny` | `setup-benny` |
| dormant automation skill | `triage-issue-reports` | `triage-issue-reports` |
| registered skill | `architect` | `architect` |
| registered skill | `arena` | `arena` |
| registered skill | `automate-me` | `automate-me` |
| registered skill | `benchmark-checklist` | `benchmark-checklist` |
| registered skill | `blast-radius` | `blast-radius` |
| registered skill | `bro` | `bro` |
| registered skill | `correct` | `correct` |
| registered skill | `create-formal-verification-skill` | `create-formal-verification-skill` |
| registered skill | `create-verification-skill` | `create-verification-skill` |
| registered skill | `figure-it-out` | `figure-it-out` |
| registered skill | `how` | `how` |
| registered skill | `in-your-own-words` | `in-your-own-words` |
| registered skill | `interrogate` | `interrogate` |
| registered skill | `ketchup-video` | `ketchup-video` |
| registered skill | `ketchup` | `ketchup` |
| registered skill | `maintain-formal-verification-skill` | `maintain-formal-verification-skill` |
| registered skill | `maintain-verification-skill` | `maintain-verification-skill` |
| registered skill | `make-bot-ui` | `make-bot-ui` |
| registered skill | `no-comments` | `no-comments` |
| registered skill | `poteto-help` | `osstack-help` |
| registered skill | `poteto-mode` | `osstack-mode` |
| registered skill | `principle-attack-the-premise` | `principle-attack-the-premise` |
| registered skill | `principle-boundary-discipline` | `principle-boundary-discipline` |
| registered skill | `principle-build-the-lever` | `principle-build-the-lever` |
| registered skill | `principle-encode-lessons-in-structure` | `principle-encode-lessons-in-structure` |
| registered skill | `principle-exhaust-the-design-space` | `principle-exhaust-the-design-space` |
| registered skill | `principle-experience-first` | `principle-experience-first` |
| registered skill | `principle-explain-the-number` | `principle-explain-the-number` |
| registered skill | `principle-fix-root-causes` | `principle-fix-root-causes` |
| registered skill | `principle-foundational-thinking` | `principle-foundational-thinking` |
| registered skill | `principle-guard-the-context-window` | `principle-guard-the-context-window` |
| registered skill | `principle-laziness-protocol` | `principle-laziness-protocol` |
| registered skill | `principle-make-operations-idempotent` | `principle-make-operations-idempotent` |
| registered skill | `principle-migrate-callers-then-delete-legacy-apis` | `principle-migrate-callers-then-delete-legacy-apis` |
| registered skill | `principle-minimize-reader-load` | `principle-minimize-reader-load` |
| registered skill | `principle-model-the-domain` | `principle-model-the-domain` |
| registered skill | `principle-never-block-on-the-human` | `principle-never-block-on-the-human` |
| registered skill | `principle-outcome-oriented-execution` | `principle-outcome-oriented-execution` |
| registered skill | `principle-prove-it-works` | `principle-prove-it-works` |
| registered skill | `principle-redesign-from-first-principles` | `principle-redesign-from-first-principles` |
| registered skill | `principle-separate-before-serializing-shared-state` | `principle-separate-before-serializing-shared-state` |
| registered skill | `principle-sequence-verifiable-units` | `principle-sequence-verifiable-units` |
| registered skill | `principle-subtract-before-you-add` | `principle-subtract-before-you-add` |
| registered skill | `principle-test-behavior-not-implementation` | `principle-test-behavior-not-implementation` |
| registered skill | `principle-type-system-discipline` | `principle-type-system-discipline` |
| registered skill | `recall` | `recall` |
| registered skill | `reflect` | `reflect` |
| registered skill | `setup-pstack` | `setup-osstack` |
| registered skill | `sharpen` | `sharpen` |
| registered skill | `show-me-your-work` | `show-me-your-work` |
| registered skill | `statechart` | `statechart` |
| registered skill | `swarm` | `swarm` |
| registered skill | `tdd` | `tdd` |
| registered skill | `teach` | `teach` |
| registered skill | `technical-writing` | `technical-writing` |
| registered skill | `typescript-best-practices` | `typescript-best-practices` |
| registered skill | `unslop` | `unslop` |
| registered skill | `why` | `why` |
| agent | `comment-sicko` | `comment-sicko` |
| agent | `poteto-agent` | `osstack-agent` |

## 冲突与不可机械替换

按完整路径、技能名、agent名分别计算，当前固定pstack树内部替换后冲突：0。这不证明目标宿主无同名安装。

- osstack plugin key/command prefix shares existing product branding; verify installed catalogs before registration, do not overwrite an existing plugin
- pstack and poteto both map to osstack but refer to package vs author; author identity poteto/Lauren Tan must not be renamed
- setup-osstack is a prospective skill, not an existing OSStack CLI subcommand or global model setup authorization
- osstack-models files may already exist; migration must avoid overwrite and retain user choices; no migration performed
- @cursor-skill scope is upstream packaging ownership, not automatically OSStack-owned; only local identity mapping, do not publish
- Upstack/upstack/pendingUpstack/upstack-build contain literal pstack substring but refer to PR stack semantics, not branding; never replace to uosstack
- Existing OSStack repo design evidence pstack.* IDs and source pins are immutable provenance; adapt public surface separately, not historical mass replacement

保留作者 poteto / Lauren Tan、LICENSE、原始来源链接/固定Git pin及历史审计证据。README里的第一人称作者自述必须保持归属或改写为引用说明，不能直接换成OSStack自述。

所有58注册技能的Claude命令命名空间若未来实际注册为osstack，则由 `/pstack:<name>` 映射 `/osstack:<mapped-name>`；无品牌token的技能叶子名保持，例如create/maintain-verification-skill、how、why等。23 playbooks仍是mode内部流程，不因改名变成独立slash命令。3个benny自动化技能仍属未注册pack。

安装坐标 `pstack@cursor-plugins` 是实际上游产品地址，不能把源文链接或安装说明机械改成未经注册的 `osstack@cursor-plugins`。未来自有安装坐标需实际marketplace归属，当前只读材料包不声称可安装。配置路径的名称映射同样不授权创建/覆盖配置，也不选模型。

完整每文件SHA、逐行命中、受保护URL与原manifest在 naming-inventory.json。二进制图像只记录hash/路径，没有OCR；如导入品牌资产需单独视觉检查。包外harness生成脚本只是树内引用，本轮没有扫描其实现。

现有 `.osstack` / `OSSTACK_HOME` / `skills.config.yaml` 是OSStack控制面和来源清单，不能把上游模型规则机械迁入或覆盖它们。固定树实际发现的是 `pstack-models.mdc/.md`，未发现名为pstack-config的配置文件。JSON中的目标路径仅指未来本地适配副本；上游模块路径作为来源标识保持原样，作者/许可/授权语义不随改名改变。
