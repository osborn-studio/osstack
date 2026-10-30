# PR314 CI 最终证据

[CI run 41043889043](https://github.com/osborn-studio/osstack/actions/runs/41043889043) 对应 PR314 → PR313 的 synthetic 合并检查：metadata head 为 b161223bb3d2a3574a3ce9797ae07cbcd63c3fb3，实际 checkout 为 cb3b7d4c8ef5b3c52c955e54328f99edc6cdacb5。五个适用 job SUCCESS，Paid DeepSeek semantic smoke SKIPPED。check/Test 的 22 唯一包为 7420 passed / 7 skipped / 0 failed；单独 TAP 和矩阵重复执行未混入总数。

PR314 保持 Draft，等待 parent 合入 main 后再对实际 main 核验。本记录不是当前 main 的通过证明，也不是本次 P6 或新增 writableRoots 修复的 CI 结果。

full.log.gz 是完整原始 full.log 的无损 gzip，已逐字节解压比较：原 2,285,637 bytes，SHA256 1ebb49006f27516c9afecef7e9e5d2c1c096f31751400e3865d2681d05d83018。其他输入原件逐字节保留，包括 manifest.json、pending-receipt.json 和三次状态查询，旧 pending 不表示最终状态。

publication-manifest.json 绑定本目录全部 payload 的 size/hash；原 manifest.json 仍按原 full.log 名称记录原输入。读取 full.log.gz 后可按原 hash 校验。report.json/report.md/parse.py 保留独立统计及边界。本次仅本地证据出版，没有重跑 CI、下载或重哈希远端 artifact、运行产品或更新 PR。
