# OPL Package 平台组合迁移

Owner: `One Person Lab Framework`
Purpose: `framework_package_platform_composition_migration`
State: `controlled_breaking_cutover_in_progress`
Status: `active_implementation`
Decision date: `2026-07-24`
Machine boundary: 本文只维护 Framework 的兼容现状、仓内迁移责任和删除证明。跨仓
目标架构、用户功能等价矩阵、总体顺序和 App/Shell 验收的唯一计划是
[`one-person-lab-app/docs/active/opl-package-platform-composition-migration.md`](https://github.com/gaofeng21cn/one-person-lab-app/blob/main/docs/active/opl-package-platform-composition-migration.md)。
当前机器真相继续归 contracts、source、tests、native carrier inventory 和 fresh CLI/App
readback。

## 阶段边界

- **Phase 1 - SSOT 与冻结计划**：已完成。目标边界、兼容面、功能不降级证明和
  删除门禁已经进入 canonical documentation authority。
- **Phase 2 - controlled breaking cutover**：已获用户批准并执行中。先让 successor
  Package plane 通过公共动作与 fresh readback 验收，再切换全部 production caller，最后
  在一个受控删除批次中移除 legacy Manager。逐字段、逐 family 迁移不再是主路径。

Phase 2 已获授权不表示迁移已完成，也不自动授权 Package publication、Stable/Latest、
真实用户 managed state 或其他 public mutation。当前仍存在的 installed lock、payload、
materialization、receipt、LKG/rollback、scope activation 与 transaction 只作为待切断的
兼容实现；它们不得阻止 successor source cutover，也不得在切换后继续充当 runtime fallback
或第二 writer。docs、测试、checkpoint 或兼容数据静止不能替代真实 caller、OUT 和 fresh
carrier readback 证明。

## 结论

Framework 支持下面的开放生态，但不再自建完整 Package Manager：

```text
OPL Base    ≈ R
OPL App     ≈ RStudio / 可替换 GUI 与部署载体
OPL Package ≈ R Package

owner bytes
  -> Base OCI download / verify / handoff
  -> configured carrier or Package runtime adapter
  -> native installed / callable readback
  -> Framework aggregation
  -> App projection
```

Package 是安装单元；Skill、Tool、Plugin、MCP、workflow 和 entrypoint 是 descriptor
可发现 capability。标准 Agent 只是 `kind=agent` 的普通 Package。Package identity、
physical carrier 和 executor route 相互独立；GHCR 是 first-party publication store，
不是本机 carrier 或 installed truth。

普通 dependency 只声明 required/optional identity。缺 required dependency 时，薄操作只
ensure 当前 root 的 required closure，例如显式 `mas` 只处理 MAS 与 ScholarSkills；
不比较 SemVer、ABI、lock、payload 或 digest，也不选择其他 installed roots。breaking
interface 通过新 identity 或 owner-side compatibility adapter 演进。

## Framework 目标边界

Framework 只保留：

- owner descriptor 的 carrier-neutral discovery；
- OCI bytes 的 download、integrity verification 和 handoff；
- configured carrier / Package runtime adapter 的委托；
- native carrier fresh readback 的 installed/callable aggregation；
- required/optional presence 与 declared entrypoint callability；
- executor route readiness，且 route unavailable 不改变 Package identity；
- Agent Work Item inventory、Temporal execution refs 和 typed-view proxy；
- compact status、通用 actions 和局部故障聚合。

Framework 不再拥有：

- 固定 Package、Agent、Plugin、Module 或 Skill 清单；
- 中央版本/ABI resolver 或跨 Package latest-compatible 求解；
- OPL installed lock、payload/content lock、generation/LKG、lifecycle receipt；
- materializer、scope activation、rollback 或 durable Package transaction；
- App Official Profile、Home preference、GUI renderer 或 domain view schema；
- shared manifest 对普通 Package currentness 的解释权。

一次 release artifact 的 checksum、digest、SBOM、attestation 和 exact ref 继续由 release
owner保留。Temporal Worker Versioning 与 domain artifact/evidence digest 也继续有效；
它们不属于普通 Package composition。

## Controlled Breaking Cutover

当前 `opl packages`、first-party manifests、registry cache、installed lock、receipt、
payload/materialization、LKG/rollback、scope activation 和 Release Set bridge 仍可能有
active consumer。它们是 compatibility-to-delete，不是目标架构，也不再要求按字段或
family 单独完成 retirement ceremony。

迁移期规则：

1. successor facade 是唯一新增生产写路径；production caller 一经切换，不得再 dual-write
   或自动回落旧 Manager。
2. native carrier fresh readback 是 installed/callable/actions truth；descriptor、App metadata、
   旧 lock 或 cache 不能覆盖实际物理状态。
3. 旧状态只允许一次性、幂等、最小读取，用于迁移无法从 native carrier 或 App preference
   重建的用户 preference、显式 uninstall intent。可重建的 lock、receipt、payload、LKG、
   generation 和物理路径不迁移。
4. explicit root update 必须保持 Package-local。required dependency 失败只影响该 root；
   无关 Package、Base 和 App 继续。
5. developer/local source shortcut 只在用户明确选择时保留。外部 mutation 结果 unknown 时
   只做有界 fresh inspect；在 readback 前不重试、不虚报成功。
6. shared `one-person-lab-manifest:latest-stable` 只保留 Full/offline/integration/QA snapshot；
   普通 install/update/currentness 读取 owner 的 per-Package OCI `latest-stable`。
7. 回滚使用 canonical Git revert、上一版 immutable artifact 和受控安装回退；新 runtime
   不保留 legacy dual-write、automatic fallback 或私有 rollback state machine。

### No-resurrection 不变量

- `installed lock`、`payload`、`materializer`、`lifecycle receipt`、`LKG`、
  `rollback` 和 `durable transaction` 只属于 `compatibility-to-delete`；不得作为新
  Package lifecycle、普通 currentness 或裸 carrier adoption 的实现依据，也不得通过改名、
  新 schema 或新 writer 恢复为 Framework authority。
- 普通 first-party install/update/currentness 的唯一顺序是 per-Package owner OCI
  `latest-stable` -> native carrier adapter -> fresh native readback。旧 shared manifest 只可作为
  compatibility snapshot 输入，不再是产品概念，也不得参与该路径的选择、成功判定或
  currentness 结论。
- 裸 carrier shortcut 仅在用户明确选择 developer/local source 时保留。普通 first-party
  操作必须经过 owner channel 与 native lifecycle，并以 fresh readback 证明真实生效；仅有
  descriptor、cache、旧 lock 或命令 exit 0 不得报告成功。

## 切换里程碑

### M1 successor-only public actions

- owner descriptor 动态发现，per-Package owner OCI `latest-stable` download/verify/handoff，
  configured/native carrier `install|update|remove|repair|enable|disable`，以及 fresh
  physical installed/callable/status/actions readback 形成一条可实际使用的纵向链路。
- Framework 公共动作只调用该 facade；旧 lock/payload/materializer/receipt/LKG/rollback/
  transaction 不再是普通动作 fallback 或 success authority。
- 禁止新增 resolver、lock、payload、LKG、receipt、materializer、scope activation、
  rollback 或 durable-intent 字段和公共动作。

### M2 App/Shell consumers and preference migration

- App/Shell 只消费 generic directory、presence、status、actions、Agent task 和 typed-view
  projection；不解析 lock、payload、receipt、materializer 或 carrier 私有路径。
- 只迁移无法从 fresh carrier 重建的用户 preference 与显式 uninstall intent；Home shortcut
  visibility/order 继续由 App preference authority 持有。
- producer 与 consumer 可在独立 worktree 并行准备，canonical main 与同路径 replay 短时串行。

### M3 OUT01-17 and real carrier acceptance

- 对 install/update/remove/repair/enable/disable、unknown Package、Home、Runtime 和 failure
  isolation 尽早执行自动化与隔离真实 acceptance；发现缺口只修 successor plane。
- MAS/MAG/RCA/OMA/OBF 是五个同级 first-party roots；`mas-scholar-skills` 只作为 MAS
  required closure，不是第六个 root。
- required dependency 只做 root-local presence ensure；更新单包不得选择其他 roots。

### M4 legacy bulk deletion and parity

- M1/M2 已 canonical 且受影响 OUT green 后，停止 legacy writer；用 structural call graph、
  TypeScript/build 和 exact literal guards 证明 production caller=0。
- 一次删除中央 registry/resolver/lock/payload/materializer/activation/LKG/receipt/rollback/
  transaction reader、writer、schema 与 fixture；删除前后复跑同一 affected OUT 集合。
- Release receipt、Temporal durability、Foundry/domain evidence、用户 preference/config
  atomic write 不在删除范围内。
- Framework/App/Shell canonical parity、fresh carrier readback 与 task-owned lifecycle cleanup
  全部闭合后，才能声明迁移完成。

Bulk delete 不机械要求每个字段单独 consumer-zero。它的硬门禁是 successor facade 已
canonical、所有 production callers 已切换、structural caller=0、受影响 OUT 通过，并在删除
后复跑同一 gate。write-set overlap 只影响最终 replay 顺序；共享 main、真实 installed/public
mutation 和 heavy aggregate 使用短时唯一 baton。

## 功能不降级证明

Framework 删除旧 lifecycle 前至少要提供：

- first-party owner GHCR 完整 runtime 与独立 `latest-stable` 匿名 readback；
- OCI download/verify/handoff 和 configured carrier install/list/update/remove readback；
- MAS 安装/更新只 ensure MAS + ScholarSkills required closure；
- 一个 Package 更新失败不连坐无关 Package、Base 或 App；
- 用户删除后普通 maintenance 不回装；
- dynamic `kind=agent` discovery、Work Item/Temporal join 和 unknown typed-view fallback；
- developer/local source 不被覆盖；
- executor route 切换不重装 Package，不丢 preference、Work Item 或 typed view；
- 唯一 physical carrier 移除后报告 `physical_unavailable`，无 cache/metadata 虚假 installed；
- ordinary currentness 不消费 shared manifest；
- 旧 registry/resolver/lock/payload/LKG/receipt/materializer/activation/rollback/transaction
  production caller=0、生产实现物理删除，且删除后同一受影响 OUT 再次通过。

docs、schema、tests、dry-run、candidate、旧 writer “不再默认调用”或兼容数据静止都不是
terminal proof。

## Durable 调研裁决

2026-07-23 的 Durable 轻量调研正确拒绝通用 filesystem transaction 和跨独立 Package
原子事务，也正确强调幂等 mutation、fresh inspect、external drift 保护、unknown result
不盲重试以及 Package-local failure isolation。这些原则保留。

其 `Package intent + installed lock + receipt + LKG/generation + reconcile state machine`
仍会在 native platform 之外建立第二 truth，已被本计划取代。只有 fresh production
evidence 证明某个具体 carrier 缺口会导致用户功能降级时，才允许增加 adapter-local、
无第二真相的最小补丁；不能据此恢复统一 Package Manager。

历史裁决见
[`2026-07-24-package-manager-superseded-designs.md`](../history/process/plans/2026-07-24-package-manager-superseded-designs.md)。
