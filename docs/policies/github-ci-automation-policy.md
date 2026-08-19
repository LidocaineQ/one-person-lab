# GitHub CI 自动化政策

本文定义 OPL repos 的 CI 发现、修复和报告边界。

## Current failure

只有同时满足以下条件的 run 才是当前故障：

- 属于当前 default branch、受支持release/tag或当前PR；
- workflow仍由该repo owner使用；
- 最新同scope run仍失败；
- failure可归因到当前source、workflow、permission、secret或provider。

旧run、已删除surface和已被新绿色run覆盖的失败不进入当前故障清单。

## Owner

- repo workflow/source失败 -> repo owner；
- App packaging/signing/release -> App owner；
- Package publication -> Package owner；
- hosted permission/secret/environment -> 对应GitHub repo/environment owner；
- external provider outage/quota -> provider owner。

Framework巡检不能替其他owner修改release strategy、credential或protected environment。

## Repair

1. 读取最新run、head SHA、job和失败step。
2. 在本地等价环境复现可复现部分。
3. 修复最深可证断点。
4. 运行focused和workflow syntax/permission验证。
5. 只在需要hosted OS、secret或protected environment时dispatch。
6. 回读exact head run结果。

不得反复rerun同一确定性失败；不得通过跳过test、放宽permission、泄露secret或改变release identity获得绿色。

## Reporting

报告只列：

- current failing surface；
- owner；
- exact head/run；
- 最深断点；
- 已执行修复或真实blocker；
- 下一动作。

绿色run只证明该workflow/head。它不自动证明publication可见、installed/effective、App user path或production ready。

## Scheduled patrol

定时巡检保持只读发现，只有明确owner和可安全修复的当前故障才进入mutation lane。外部permission、credential、billing、immutable artifact或用户审批缺失时停止对应operation并报告，不制造retry噪声。
