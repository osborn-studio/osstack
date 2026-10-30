# P2/P3 adoption 原件归档独立核验

结果：PASS（归档完整性与绑定核验范围），没有确认遗漏或差异。

- archive SHA256 `f38dbe9453ec706a77f6122409c86beb74a4ed446a100ebbc9481b400f120d60` 与 root 记录及清单一致。
- 1286 成员 = 1064 文件 + 222 目录，0 symlink，文件总计 30,450,418 bytes。逐成员核对 tar/manifest/冻结 source 的类型、mode、size、SHA256；target 机制亦覆盖但本包无链接。无重复 tar 路径；冻结 source 全量扫描没有未归档成员。未解包执行任何文件。
- 15 份 final-source 与 `b36d97567d6ad0b3ab7458649583079512bf4dce` Git blob 精确一致。另核首审17份/复审10份 inputs 的实际内容与输入hash和完整prompt一致，共42项源码/输入绑定通过。
- 首审完整原文 PASS_WITH_CONCERNS 和限定复审 PASS 均存在；report 与实际 response.result 一致，prompt/response 摘要匹配 binding，exit0。两次 modelUsage 报 `claude-sonnet-5-5`，这是CLI报告，不是独立模型身份认证。
- 原始作者 RED、未知digest域失败与修正、后审计 source/provenance RED→GREEN、独立 freeze、旧新6例和核验脚本自身失败/修正均保留；具体索引见 coverage.json。
- 三次 full 都绑定历史 `2389dcd9f9f556df4c79e419bdc3e68561cba128`，exit依次1/1/0；两次失败原日志未替换。成功日志独立重数22包 **7334通过/5跳过/0失败**。该成功在后审计修订前，不能称最终 b36 全仓通过；最终修订靠另存定向/独立/静态复审证据，不合并计数。

本核验不重跑产品/build/full，不验证宿主送达或理解，不认证来源真实性/安装激活，不改变原始失败/意见。hash证明留存一致性。原目录和仓库文件均未修改。
