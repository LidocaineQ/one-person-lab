# OPL Family 当前状态与理想目标差距

Owner: `One Person Lab`
Purpose: `family_ideal_state_gap_plan`
State: `active_plan`
Machine boundary: 本文是人读 current-state / gap / baton map。机器真相继续归 `contracts/`、源码、CLI/API 行为、runtime ledger、provider receipt、domain-owned manifest、真实 workspace 与 App evidence。

## 读法

本文只回答三个问题：

1. OPL family 当前理想形态是什么。
2. 当前相对理想形态还有没有 active 功能 / 结构 gap。
3. 如果有，下一轮 Agent 应该按什么写集、入口和完成门槛推进。

已经落地的功能/结构推进不再保存在本文。它们只作为 history / provenance 读取，入口见 [2026-06-30 OPL family functional gap closure foldback](../history/process/plans/2026-06-30-opl-family-functional-gap-closure-foldback.md) 和提交历史。本文也不冻结 receipt id、attempt id、worktree、branch、workflow run、counter 或某轮 closeout 输出。

Live Evidence 后置：release、production、Brand L5、owner-chain scaleout、真实项目运行、owner acceptance、physical delete、owner receipt、typed blocker 和 human gate 不在本文维护。需要这些证据时读取 [OPL Family Live Evidence 维护入口](../references/operating-governance/family-live-evidence-maintenance.md) 和各 owner repo 的 evidence contracts / runtime ledgers。

## 理想形态

理想形态仍按目标态定义，不因为当前实现情况降低标准：

- `one-person-lab` 持有 OPL framework runtime、activation、StageRun、stage-attempt request/projection、read-model、App/workbench contract、generated / hosted surface、no-second-truth guard 和跨仓 projection 边界。
- `med-autoscience`、`med-autogrant`、`redcube-ai` 是标准 OPL domain agent：domain truth、quality verdict、artifact authority、owner receipt、typed blocker 和 human gate 留在各自 owner repo；OPL 只承接 generic stage/runtime/control-plane substrate。
- `opl-meta-agent` 和 `opl-bookforge` 按标准 OPL Agent / Foundry Agent 目标态维护：domain pack、generated/hosted surface、default path、accepted owner-answer shape、source morphology、retired helper provenance 和 no-forbidden-write guard 清楚。
- `one-person-lab-app` 是普通用户与 operator 的产品入口：Docker/WebUI beginner path、Settings control plane、runtime proxy、release/operator progress、active shell policy 和 App-owned contract 归 App owner；Framework 只提供受控 read/action surface。
- Package 生态目标固定为 `OPL Base ≈ R`、`OPL App ≈ RStudio`、`OPL Package ≈ R Package`：Package 是唯一安装单元，标准 Agent 只是 `kind=agent` 的普通 Package；每个 owner 以独立 GHCR `latest-stable` 发布完整 runtime，shared manifest 只服务 Full/offline/integration/QA；Package identity、carrier 与 executor route 相互独立，Framework 只保留薄 OCI/native adapter、carrier-neutral installed aggregation、presence/callability 与 Runtime 投影。
- Support repos、Aion/Hermes、MAS Scholar Skills、Homebrew、OPL Doc retired tombstone 和 Native Workbench 只按 carrier / support / capability-pack / distribution / GUI candidate 边界读取；它们不成为 framework/domain/App release truth owner，也不替代对应 owner 的 evidence surface。当前文档治理工作流由 OPL Flow bundled `$opl-doc` Skill 提供。

North-star 参考仍归 [OPL 与 Foundry Agents 理想目标态](../references/runtime-substrate/opl-family-agent-ideal-state.md)、[OPL Family 理想系统评估](../references/runtime-substrate/opl-family-ideal-system-assessment.md)、[OPL Family Ideal Operating Model Redesign](./opl-family-ideal-operating-model-redesign.md) 和核心五件套。本文不复制这些目标态细节，只维护当前 gap 与 baton。

## 当前完成进度

| 范围 | 当前完成状态 | 证据边界 |
| --- | --- | --- |
| 非 live 功能 / 结构基线 | `opl_package_platform_composition_phase_2_controlled_breaking_cutover_in_progress` | 既有 Package platform-first composition 仍是独立 active migration slice；本仓 owner 边界见 [`opl-package-platform-composition-migration.md`](./opl-package-platform-composition-migration.md)，跨仓唯一实施计划归 App SSOT。Phase 2 已获用户批准，当前按 successor-only 纵向链路、production caller 切换、affected OUT / carrier 验收与 owner-gated bulk deletion 顺序执行。 |
| Cordis 进程内组合 | `planned_ssot_frozen_experiment_not_started` | 用户已确定正式 `@deepseek-ai/cordis` 为目标组合框架；当前只完成决策、架构和计划，尚未安装、尚未创建实验 composition、尚未切换默认 caller。首个 seam 是 Agent Executor，详细门槛见 [`cordis-adoption-plan.md`](./cordis-adoption-plan.md)。 |
| Bounded security hardening | `first_local_compatibility_batch_implemented_verified` | Codex Security scan `03a5506e-0f1b-4ddd-ba53-b33a0c8e6a83` 的处置由 [`security-hardening-worklist.json`](../../contracts/opl-framework/security-hardening-worklist.json) 持有。首批四项局部兼容修复已实现并通过回归；安全 lane 默认在真实受损边界内局部拒绝，在边界外 fail open，不把 finding 清零当成交付指标。 |
| Ponytail 低风险简化 | `low_risk_slice_landed_owner_gated_tail_remains` | OPL Framework 已删除已证明无生产 caller 的 pass-through facade 文件，同时通过 canonical kernel 保留既有 public symbols；并清理孤儿 runtime helpers、专属测试/脚本和无引用图片。对外 contracts、Package/payload 历史、release cohorts 与仍可能被外部消费的 schema 保持 owner-gated，不把仓内零引用当作物理删除授权。Fallow 动态入口只登记真实运行期拼接加载的模块；扫描配置校准不扩大删除授权。下一轮只从 fresh caller/consumer evidence 选择新的最小 cleanup slice。 |
| Active Truth 治理 | `single_owner_guard_active` | 本文是唯一 active truth owner，只保留当前 gap、完成口径与下一轮 baton，不保存 dated proof 或 closeout 流水。 |
| Live / release / production / owner evidence | `deferred_to_evidence_owners` | 继续由 App release、provider long-soak、Brand L5、domain owner receipt、typed blocker 与 human gate 等 owner surface 单独证明。 |

这些状态只描述当前文档治理与非 live 功能 / 结构 gap 选择，不表示 runtime ready、domain ready、App release ready、Brand L5、production ready、owner acceptance 或 physical delete authorized。

## 当前功能 / 结构读法

当前默认读法：默认 OPL family maintained repo 的非 live 功能/结构基线只能从 fresh repo truth、四份 `contracts/opl-framework/foundry-*.schema.json`、FoundryRun source/tests 与各 domain owner surface 读取。本文不冻结日期、branch、SHA、`origin/main` 状态、receipt id、worktree closeout、workflow run 或某轮 readback。

当前 active 非 live 功能/结构 gap 有三个相互独立、不互相替代的切片：

1. `cordis_runtime_composition_adoption` 是新的战略主线。用户已确定正式
   `@deepseek-ai/cordis` 为 OPL 长期进程内组合框架；P0 已冻结 SSOT，下一棒是 P1
   surface map 和 P2 隔离的 Agent Executor 实验。实现前不得安装到默认 production
   dependency graph，也不得把计划写成已插件化或已 Cordis-native。详细 owner、写集、
   验证和回退见 [`cordis-adoption-plan.md`](./cordis-adoption-plan.md)。
2. `opl_package_platform_composition` 是保留的独立迁移切片。Phase 1 已完成 SSOT 与冻结
   实施计划；Phase 2 已获用户批准并进入 successor-first controlled cutover。先让
   successor-only Package plane 形成可验证、可回退的真实纵向链路，再切换全部 production
   caller 并通过 affected OUT / real-carrier acceptance；只有 structural caller 为零且
   对应 owner decision / physical-delete gate 成立后，才进入受控 legacy bulk deletion。其
   计划见 [`opl-package-platform-composition-migration.md`](./opl-package-platform-composition-migration.md)。
3. `bounded_security_hardening` 只处理当前可证的安全边界。第一批 Host、Git URL evidence、
   Provider response body 和 Workspace projection 采用局部兼容修复；Redirect 与 Python handler
   只在 caller/runtime inventory 后 canary；CAS、E2B、Carrier 与 mutable channel 保持
   evidence/owner route，不增加 Framework 第二 resolver、lock、LKG 或签名 registry。

三条切片共享 Framework Integrator，但 authority 不合并：Cordis plugin 只做进程内组合，
Package 仍持有安装/currentness；Cordis adoption 不授权 Package publication、Stable/Latest、
真实用户 managed state 或其他 public mutation。每条实施切片仍须 fresh 登记唯一 owner 与
exact write set。本文只持有 gap/baton，不复制两份执行计划，也不能把 docs、focused tests、
composition inspect 或 compatibility bridge 写成迁移完成。

## 八条调研建议 Current Tracker

本 tracker 只保留用户原始 8 条调研建议的当前 owner route 与后置 evidence lane；它不是 readback ledger、branch ledger 或完成史。所有 proof 细节回提交历史、runtime ledger、owner repo evidence surface 和 `docs/history/`。

| # | 建议主题 | 当前功能/结构读法 | 后置 lane / 下一 owner |
| --- | --- | --- | --- |
| 1 | Docker WebUI beginner path | Settings/Docker WebUI 只按 App/OPL read-model 与 doctor 入口读取。 | App release cohort、真实用户路径、Aion shell/App owner consumption 后置；不写成 App release-ready。 |
| 2 | Settings SSOT | Settings Control Center v2 由 App/OPL policy/action source 持有；Aion/host shell 只消费 adapter/view model。 | App page-state、release artifact、active-shell validation 继续归 App repo。 |
| 3 | MAS blocker action route | MAS typed blocker owner handoff 与 OPL transition receipt 只作为 projection/transport 边界读取。 | MAS `PaperMissionRun`、owner receipt、typed blocker/human gate 和 paper-progress truth 继续归 MAS。 |
| 4 | StageRun default | StageRun/owner-route structural baseline 只按 standard-agent landing evidence 与 Foundry target owner 读法读取。 | Live StageRun owner receipt、typed blocker、human gate、owner acceptance 和 production evidence 仍后置。 |
| 5 | Foundry registry | Standard agent/Foundry series 分类与 public projection 只证明 OPL-generated/hosted surface 结构边界。 | real target owner route、production generated-surface consumption、Brand L5 和 owner acceptance 仍后置。 |
| 6 | MAS Scholar Skills refs-only | MAS Scholar Skills 是 framework capability package/refs-only skill sync，不是 standard domain agent 或第二 runtime truth。 | domain owner consumption、target quest/workspace 真实使用和 package release path 继续走 owner evidence。 |
| 7 | active legacy caller | `opl agents default-callers` 是 deletion-gate read model；worklist/closed gate 不授权 physical delete。 | 物理删除必须等 no-active-caller、replacement owner、tombstone/provenance、no-forbidden-write 和 owner decision。 |
| 8 | docs / readback thinning | status/tracker 只保留机器入口和 forbidden-claim 读法，不恢复过程 proof、branch、counter 或 closeout 流水。 | 后续发现新 gap 时从 fresh audit 重新开 lane；不恢复长 readback/closeout 清单。 |

## Plan Completion Audit 入口

本轮审计对象是上表 8 条建议的文档 / readback 收薄覆盖，不是各功能 lane、App release、MAS paper progress 或 production readiness 完整验收。完成审计时必须逐条读取 fresh `main` / owner repo / lane evidence，并按下列口径给出 `done`、`partial`、`not_started` 或 `blocked`：

| 审计项 | 可标 `done` 的证据 | 不足以标 `done` 的证据 |
| --- | --- | --- |
| 功能 / 结构闭环 | 已在 target ref 上存在 source / contract / CLI-readback / docs owner 折回，且没有同写集 active lane 冲突。 | 只存在历史计划、候选 worktree、未吸收分支、docs 总结或 focused test pass。 |
| 后置 Live Evidence 分账 | 对应 owner lane 明确指向 App release、owner acceptance、Brand L5、provider long-soak、真实项目运行或 physical delete gate。 | 把 `functional_structure_baseline_landed`、read-model clean、projection clean、refs-only ledger 或 docs foldback 写成 ready。 |
| 文档 / readback 收薄 | active owner 只保留 current gap、next owner、verification entry、forbidden claims 和 compact tracker；过程细节进入 history / runtime ledger / 提交历史。 | 在 active docs 追加 receipt id、attempt id、branch/worktree、workflow run、dated proof 或 closeout 流水。 |

## Current-State vs Ideal-State Gaps / 当前差距

| Gap class | Status | Owner | 当前处理 |
| --- | --- | --- | --- |
| Cordis runtime composition adoption | `planned_ssot_frozen_experiment_not_started` | OPL Charter + Framework Integrator；P2 由 Runway/Connect 负责 | 只采用 DSH scoped `@deepseek-ai/cordis`；先做 P1 surface map，再做隔离 Agent Executor 实验，后续按 P3 inspect、P4 version contract、P5 分批迁移、P6 默认切换推进。当前不安装、不切默认 caller、不新增第二 registry/lifecycle。 |
| Package platform-first composition | `phase_2_controlled_breaking_cutover_in_progress` | OPL Framework + OPL App | Phase 1 的 SSOT、旧 resolver/lock/payload/receipt/Durable 扩张禁令与 no-resurrection 边界已冻结；Phase 2 按 M1 successor-only public actions、M2 App/Shell caller switch、M3 affected OUT / real-carrier acceptance、M4 owner-gated legacy bulk deletion 与同 outcome 复验推进。 |
| Bounded security hardening | `first_local_compatibility_batch_implemented_verified` | OPL Framework | 10 条 finding 的当前 disposition 归 `security-hardening-worklist.json`；首批已验证修复只收紧 Host 请求、durable Git URL evidence、Provider body consumption 与 Workspace Skill projection。单一危险输入不得阻断无关 Provider、Workspace、Carrier、Attempt 或已安装 generation。 |
| 文档 SSOT / active gap 污染 | `active_governance_guard` | OPL + OPL Flow `$opl-doc` Skill | 理想态定义保留在 support/reference；active gap 文档只保留当前 gap、完成口径和下一轮 baton；已完成过程进 history。 |
| Live / release / production / owner evidence | `deferred_evidence_lane` | 对应 evidence owner | 单独走 live evidence 维护入口，不混入本文 active gap。 |
| 不可逆 cleanup / physical delete | `owner_decision_gated` | 对应 repo owner | 只有 owner decision、no-active-caller、replacement owner、no-forbidden-write 和 tombstone/provenance 齐备时才开 lane。 |

## 文档治理规则

- 理想态文档只定义目标边界和不变量；已经实现的细节应压缩为当前状态或机器入口指针。
- Gap 文档是当前 active work tracker。没有当前 gap 时，它必须保持精简，不能保存历史任务清单。
- 已完成 gap、worktree closeout、dated proof、receipt 流水、branch/SHA、workflow run 和执行过程只能进入 `docs/history/**`、runtime ledger、owner repo provenance 或提交历史。
- Active docs 只保留当前 owner、当前状态、仍开放 gap、后置 evidence 指针、forbidden claims 和下一轮 baton。
- Live evidence 不混入 ideal-state、active gap 或 active development 文档；如果需要维护，单独使用 live evidence 文档。
- 新增或恢复任何 active gap 前，必须说明 semantic theme、SSOT owner、fresh truth inputs、allowed/forbidden write set、验证命令和 completion gate。

## Next-Round Agent Prompt

当前默认非 live 功能/结构主题是 `cordis_runtime_composition_adoption`，
`next_action=完成 P1 surface map，并在独立实验 lane 启动 P2 Agent Executor spike`。每轮先
读取本计划、fresh source/module caller、DSH scoped package/source lock 和对应 owner
contracts，再冻结唯一 owner、exact write set、composition snapshot、affected outcome 与
回退门禁。P2 前不得把 Cordis 依赖写入默认 production graph；P5/P6 前不得切换默认 caller。
Package platform composition 仍按其独立 M1-M4 baton 推进，不能被 Cordis docs 或实验替代。
安全 hardening 的四项局部兼容修复已实现并通过回归，完成态仍须回读 canonical `main`；其余 finding 只按
`security-hardening-worklist.json` 的 canary、evidence 或 owner route 推进，不为清零 finding
建立全局 gate、第二控制面或无证据的冷启动。
不得把计划、docs、inspect、测试、候选 branch 或未吸收 composition 写成完成，也不得把本
授权扩展到 Package publication、真实用户 managed state 或其他 public mutation。

若 fresh audit 发现新的非 live gap，使用以下 prompt 形状开启，而不是复用历史清单：

```text
Objective: 使用 OPL Flow bundled `$opl-doc` Skill / SSOT 原则，为 <repo-or-theme> 重新审计当前理想态与实际实现差距。
Write scope: 先限定到目标 repo 的 active truth owner、核心五件套、直接相关 support/reference/history 文档，以及必要的 source / contract / tests / CLI read-model 证明面；编辑前输出 governance_worklist / authority-aware matrix，标注 semantic theme、SSOT owner、owner surface、allowed/forbidden write set、verification command、completion gate 和 forbidden claims。
Non-goals: 不复活已完成历史清单；不把 docs、doctor、contract pass、focused tests、projection clean 或 refs-only ledger 写成 release-ready、production-ready、Brand L5、domain ready、owner acceptance、owner receipt、typed blocker、human gate 或 physical delete。
Live truth inputs: AGENTS.md、核心五件套、ideal-state reference、active truth owner、source、contracts、tests、CLI/read-model、runtime/evidence owner surfaces 和相关 owner docs。历史 proof、branch、SHA、receipt id、worktree closeout 和 dated command transcript 只作 provenance。
Required actions: 只选择当前 fresh evidence 证明仍开放的非 live 功能/结构 gap；把已关闭内容压缩为 current status 或 history pointer；按语义主题确定 SSOT 后再治理 peer docs。
Verification commands: docs-only 使用 rtk git diff --check、rtk rg -n '^(<<<<<<<|=======|>>>>>>>)' docs、tracked relative-Markdown-link check 和必要的 JSON parse；OPL Flow `$opl-doc` 是语义治理 workflow，不是 machine validator。触及 source/contract/runtime/App 行为时使用对应 repo-native verification。
Completion gate: active owner 只保留当前状态、开放 gap、后置 evidence 指针、forbidden claims 和下一轮 baton；没有完成过程长清单、live evidence 混写或第二 backlog。
Foldback target: 当前结论折回 active owner、核心五件套、contracts/source/tests/read-model 或对应 owner doc；过程材料折回 docs/history、runtime ledger、owner repo provenance 或提交历史。
```

## 验证入口

Docs-only inventory / baton updates:

```bash
rtk git diff --check
rtk rg -n '^(<<<<<<<|=======|>>>>>>>)' docs
```

触及 source / contract / runtime / App 行为时，按 owner repo 验证：

- OPL: `rtk ./scripts/verify.sh` 或 focused `npm run test:fast` / `npm run test:meta`
- MAS: `rtk ./scripts/verify.sh` 或 MAS repo-local focused tests
- MAG: `rtk ./scripts/verify.sh`、`rtk make test-meta` 或 focused product-entry/autonomy tests
- RCA: `rtk npm run test:fast` 或 focused product-entry/sidecar/native helper tests
- OMA: `rtk npm test`、`rtk npm run typecheck`
- BookForge/App: 使用各自 repo-native focused verification

## Forbidden Claims

- `functional_structure_baseline_landed` 不等于 release-ready、production-ready、Brand L5、domain ready、artifact ready、quality/export ready、owner acceptance 或 physical delete authorized。
- Cordis adoption 的 SSOT/计划、真实包版本观察、plugin inspect、composition snapshot 或 P2 demo 不等于已安装、已默认运行、已 Cordis-native、已支持独立模块版本组合、DSH 兼容已闭合或 Harness 自进化 ready。
- Docs foldback、contract pass、focused tests、projection clean、doctor clean、native-check pass 或 refs-only ledger 不能替代 runtime/live/owner evidence。
- Support repo、Aion/Hermes、MAS Scholar Skills、Homebrew、OPL Doc retired tombstone 或 Native Workbench 不能反向定义 domain/App/framework truth。
- 历史归档不能替代实现清理；旧模块、旧接口、旧测试和旧文档入口被当前 owner surface 替代后，只能按 owner decision 直接退役或 tombstone。
