# 独立归档核验收据

**通过：688 个成员全部与 manifest 和两个冻结源目录相符。**

- 460 个普通文件、228 个目录、0 个 symlink；文件总字节数 10,817,650。
- 逐 name/type/mode/size/hash 核验，无重复或路径越界；未解包、未解引用 symlink。
- archive SHA256：`41375939d745385d3cf64831586e5aee266cc60bed02b65c37b11f19afde2e16`
- manifest SHA256：`eb8d2b541fe6d37c8a74057a9e1c6339c4660cae67040502c0f1b3345e6cae15`

两个原目录的完整路径集合恰好等于归档成员加两份声明排除的 generated SQLite。database-0.sqlite、database-1.sqlite 均仍在本地，各 1,519,616 bytes，SHA256 均为 `901cdf8c4bf119da4929f1057edccf4f15aeaf949fa00230b1dda9279f8d75c0`；SQLite 文件头及原诊断 manifest 一致，归档中不存在。仅按只读字节计算 hash，没有用 SQLite 打开、执行或嵌入数据库。其 generated/local 排除理由与原诊断目录及清单一致；不声称认证其内部数据来源。

归档内的 native 源快照、审计三份源输入和实际 prompt、response/dispositions、实际 argv 与两 durable receipts 均再次匹配；原独立清单也逐项复核。full 仍绑定 cd30b6cc，22 包 7449 pass / 5 skip / 0 fail，9172 tracked 前后相同。后续文档和 changeset note 不升级为 whole-tree full。审计是 PASS_WITH_CONCERNS，无确认缺陷；不冒称审计者运行了 full 或 native 实验。

PP01 配置阻塞、PP02 named-profile 有界成功、NP adapter 诊断与实际 native 长路径修复各自保留。原 Node26 BLOCKED 不变，assisted U1 不升级 formal/local_verified，provider wire、principal、全部 OS 围栏不认证。

首次内部清单读取因 list/object 格式假设发生 harness 错误，初始脚本和错误记录已保留；没有归档成员失败。修正格式处理后的同范围核验完成。未执行模型、产品测试、build 或任何产品/中央写入。本目录现停止写入。
