# Shared Runtime Contract

本文解释 OPL Family 共享的 runtime 行为。machine shape 由 `contracts/family-orchestration/*.schema.json` 和 `contracts/opl-framework/*runtime*.json` 持有。

## Owner split

- Framework：StageRun/Attempt envelope、provider adapter、runtime projection、refs-only evidence 和 operator action。
- provider：workflow history、queue、retry、timeout 和 worker transport。
- Package/domain：专业执行入口、artifact body、quality verdict、owner receipt 和 typed blocker。
- App：用户交互、session UI 和 product truth。

## Required runtime surfaces

### Event envelope

event 必须绑定 run/attempt identity、source、sequence、timestamp 和 payload kind。event 只描述观察到的事实，不直接声明专业完成。

### Checkpoint lineage

checkpoint 绑定父 run、workspace scope、artifact refs 和恢复 cursor。恢复必须延续同一 lineage，不能把“最新文件”猜成当前任务。

### Attempt projection

projection 至少表达 request identity、provider/executor、状态、最新事件、输出 refs、阻塞和可执行恢复动作。它可重建，不能成为 provider history 或 domain truth 的第二 copy。

### Runtime supervision

supervision 观察 service、worker、queue 和 source freshness。自动 repair 只处理 Framework/provider owner 的运行面；存在 active mutation、权限或数据风险时 fail closed。

### Human gate

human gate 必须有明确 owner、reason、所需输入和恢复动作。没有授权时不能自动越过；普通诊断和低风险可恢复操作不应被升级为 human gate。

## State semantics

- `queued`：等待 provider 消费；
- `running`：Attempt 正在执行；
- `checkpointed`：已有可恢复点；
- `blocked`：需要 owner input、typed blocker resolution 或受保护条件；
- `failed`：Attempt 终止且有诊断；
- `completed`：transport/executor 已产生终态输出。

`completed` 不等于 owner accepted、artifact ready 或 production ready。

## Composition boundary

Cordis Host 提供进程内 service graph。StageRun 发起后冻结必要的 composition identity；durable history 仍在 provider，Package installed truth 仍在 native carrier。

## Failure and recovery

1. 先读取同一 Attempt 和 provider history。
2. 区分 transport failure、executor failure、owner blocker 和 artifact rejection。
3. 只对当前 owner 的状态执行 repair。
4. 保留已有 artifact refs 和 lineage。
5. 重新运行必须产生新 Attempt identity，并明确关联原 Attempt。

## Forbidden claims

Framework/provider 不得因为 workflow complete、worker healthy、evidence present 或 queue empty而声明：

- domain ready；
- artifact accepted；
- quality/export/publication verdict；
- App released；
- production ready。

这些结论必须来自对应 owner receipt、human gate 或 release readback。
