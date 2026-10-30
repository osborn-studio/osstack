# PR310 CI 独立日志核验

运行 `40988439592`，head `db0652dde3ec4695ef592b0d7f1c14a14a30917e`。五个适用 job 成功，Paid DeepSeek semantic smoke 跳过。

- 实际 synthetic checkout `db37d26669d6bcb155cd9b99d08859d5d32c9777`；checkout merge message 的 base 为 `e4643324b9de1d2db51c744e59ccd7c05146b0a6`。两个输入未独立提供 base 分支名。
- 仅 `check/Test` 的 22 个唯一包：**7259 passed / 7 skipped / 0 failed**。GitHub 224 passed，CLI 2764 passed / 6 skipped；其他 skip 来自 loop 1。
- GitHub 单项：PR candidate snapshot 47 tests，PR stack candidate 29 tests。
- standalone：export 94 总数＝93 pass＋1 skip；reader 14，journey 43，projection 88，map 24；单 PR CLI 14、新增 ordered stack CLI 29 全通过。Lint 与 Inventory freshness 成功。
- 真实 default journey 两项 product exits `0/1`；full journey 五项 `0/1/2/1/0`，每项 driver 0、verification passed。五项 map actual/expected 全部 matches。
- default/full 分别实际执行 project 和 check，均 `projected → valid`，对应 packet SHA 在日志内一致。该核验没有下载远端 artifact，未独立复算其内容 hash；stdout 的 cleanup/manifest 声明不扩展为全后代进程或宿主资格。

原日志逐行定位、22 包原始汇总、完整 step 状态及实际 JSON 在 `report.json` 与 `actual-logged-json.json`；输入 bytes/hash 在 `input-hashes.json`。未运行产品、模型或测试，未修改 PR/账本。
