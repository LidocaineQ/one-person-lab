# OPL 当前状态与理想目标差距

本文是 OPL 文档树唯一 active gap owner。只保留尚未达到目标、且存在明确 owner 和验收面的工作；完成后删除对应条目。

机器事实以 contracts、源码、真实 caller 和 fresh readback 为准。本文不保存计数、commit、branch、receipt 或历史过程。

## 目标

- Base、App、Packages 和 Cloud 各自只有一个产品 truth owner。
- Package 从 owner descriptor 经 native carrier 到 installed/effective contribution 的链路可独立验证。
- Cordis Host/Client composition 只负责进程内组合，运行、证据和领域判断保持原 owner。
- Stage/Attempt 能在失败、恢复、交接和长期运行中保持清楚的责任、产物和下一动作。
- 文档、contract、源码和真实 user path 对同一主题没有竞争答案。

## 当前 gaps

### 1. Installed、release 与 user-path 证据仍按 owner 分散闭合

Framework 可以投影 Package、provider 和 App 状态，但不能替代各 owner 的安装、发布、签名、真实 contribution 和用户路径验收。

**Owner**：App、Cloud、Package owner 和对应 release lane。

**完成面**：canonical source、owner publication、installed/effective readback 和真实 user-path 均一致。

### 2. Domain production acceptance 不能由 runtime projection 推导

Stage/Attempt、Temporal、evidence refs 和 operator action 已提供通用底座；专业产物仍需要 domain owner 的 receipt、typed blocker、quality/export verdict 和 human gate。

**Owner**：各专业 Agent repo。

**完成面**：真实项目产物、owner acceptance 和必要 production evidence 可从 owner surface 回读。

### 3. App 与 Cloud 的跨端组合仍需产品 owner 持续验证

Framework 已提供 `app-full` Host graph 和 Client contribution contract，但 App renderer、Cloud resource、远端 session、release 和设备 E2E 由各产品 owner 验证。

**Owner**：One Person Lab App 与 OPL Cloud。

**完成面**：受支持平台上的安装、启动、连接、恢复、升级和卸载路径通过。

### 4. Package 拓扑只在真实复用出现时继续晋升

当前多数 capability 与其 repo 同生命周期，应保持仓内。只有出现真实跨仓 consumer、独立 owner、不同发布节奏或独立回滚需求时，才创建新的独立 repo/publication。

**Owner**：能力当前 owner 与首个真实 consumer。

**完成面**：调用关系和生命周期证据足以支持 [项目概览](../project.md#package-拓扑) 中的下一层拓扑。

### 5. 残留结构复杂度按 caller 证据继续删除

source unit、public entrypoint 和 contract 已收敛，但后续仍可能出现无 caller helper、重复 projection 或过时 fixture。它们只有在结构调用和受影响行为证明后才删除，不建立新的兼容层。

**Owner**：对应 source unit。

**完成面**：caller 切换、受影响测试和 public behavior 通过，旧 reader/writer/schema/fixture 同批消失。

## 选择下一项工作的规则

1. 先读取 fresh machine state 和真实 caller。
2. 优先修复阻断当前用户路径的最深断点。
3. 没有真实 consumer 或验收影响的候选不升级为 active gap。
4. 完成后更新对应 owner 文档并从本页删除，不追加完成记录。

## 不能从本页声明

本页的存在、条目减少或 Framework 测试通过都不能声明 App released、Package published、domain ready、artifact accepted、Cloud current 或 OPL production-ready。
