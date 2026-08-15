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

- `one-person-lab` 持有 OPL Framework Host composition authority、runtime、activation、StageRun、stage-attempt request/projection、read-model、Host-to-Client allowlist/projection contract、generated/hosted surface、no-second-truth guard 和跨仓 projection 边界。
- `med-autoscience`、`med-autogrant`、`redcube-ai` 是标准 OPL domain agent：domain truth、quality verdict、artifact authority、owner receipt、typed blocker 和 human gate 留在各自 owner repo；OPL 只承接 generic stage/runtime/control-plane substrate。
- `opl-meta-agent` 和 `opl-bookforge` 按标准 OPL Agent / Foundry Agent 目标态维护：domain pack、generated/hosted surface、default path、accepted owner-answer shape、source morphology、retired helper provenance 和 no-forbidden-write guard 清楚。
- `one-person-lab-app` 是普通用户与 operator 的产品入口：Docker/WebUI beginner path、Settings control plane、runtime proxy、release/operator progress、App product profile、Client Contribution ABI、active shell policy 和 App-owned contract 归 App owner；Framework 只提供受控 Host graph 与 read/action projection。App renderer 可运行 Host 派生的 Client Cordis，但不得独立发现/安装 plugin或拥有第二 currentness/product truth。
- Package 生态目标固定为 `OPL Base ≈ R`、`OPL App ≈ RStudio`、`OPL Package ≈ R Package`：Package 是唯一安装单元，标准 Agent 只是 `kind=agent` 的普通 Package；每个 owner 以独立 GHCR `latest-stable` 发布完整 runtime，shared manifest 只服务 Full/offline/integration/QA；Package identity、carrier 与 executor route 相互独立，Framework 只保留薄 OCI/native adapter、carrier-neutral installed aggregation、presence/callability 与 Runtime 投影。
- Cordis 全面迁移的目标结构按 `family capability domain -> repo/product authority surface -> Package/artifact -> Host/Client Cordis contribution -> curated composition profile` 五层读取。家族品牌已收敛为唯一动态 portfolio：当前 11 个 capability domains 与真实 authority/caller 对齐，Framework 十项 registry 只是 surface projection；P5-R 已冻结目标图，物理 source/package cutover 已由真实 caller 和结构门完成，独立 publication 继续分账。
- AionUI 主线与 DSH GUI 候选只按 renderer/carrier 读取：二者必须共享 Host-projected client graph、Client Contribution ABI、App product profile和 typed slot/action语义，不成为 framework/domain/App release truth owner，也不各自创建 client registry。Support repos、Hermes、MAS Scholar Skills、Homebrew和 OPL Doc retired tombstone同样只按各自边界读取。当前文档治理工作流由 OPL Flow bundled `$opl-doc` Skill 提供。

North-star 参考仍归 [OPL 与 Foundry Agents 理想目标态](../references/runtime-substrate/opl-family-agent-ideal-state.md)、[OPL Family 理想系统评估](../references/runtime-substrate/opl-family-ideal-system-assessment.md)、[OPL Family Ideal Operating Model Redesign](./opl-family-ideal-operating-model-redesign.md) 和核心五件套。本文不复制这些目标态细节，只维护当前 gap 与 baton。

## 当前完成进度

| 范围 | 当前完成状态 | 证据边界 |
| --- | --- | --- |
| 非 live 功能 / 结构基线 | `opl_package_platform_composition_phase_2_controlled_breaking_cutover_in_progress` | 既有 Package platform-first composition 仍是独立 active migration slice；本仓 owner 边界见 [`opl-package-platform-composition-migration.md`](./opl-package-platform-composition-migration.md)，跨仓唯一实施计划归 App SSOT。Phase 2 已获用户批准，当前按 successor-only 纵向链路、production caller 切换、affected OUT / carrier 验收与 owner-gated bulk deletion 顺序执行。 |
| Framework Host Cordis | `full_host_migration_landed_default_base_headless_with_package_host_abi_and_explicit_caller_parity` | P1-P6 已进入 canonical main；`base-headless`、`app-full`、`foundry-dev` Host profiles具有精确 allowlist、child snapshot/digest、teardown和 source replay。CLI/App action/Workspace/managed Agent/Runtime caller显式消费 profile service；Package currentness、Temporal、Workspace bytes/binding、Ledger persistence、Foundry activation、domain truth和 App/Cloud product authority继续由各 owner持有。 |
| Family capability/source topology | `physical_cutover_landed_brand_portfolio_aligned` | 唯一家族 portfolio 当前登记 11 个 capability domains，Framework 十项 registry 只是 CLI/L4/L5 projection；源码已按 13 个 responsibility source units、6 个 target roots（`authority/adapters/read-models/host/entrypoints/kernel`）完成物理重排，`src/modules/**` 为 retired/must-be-absent legacy root。该结构完成不外推 release、production、App 或 Cloud 完成。 |
| Host-derived Client Cordis / dual GUI | `aionui_admitted_studio_candidate_conformance_landed` | Framework Host projection、App Client Contribution contract、AionUI active renderer admission 与 Studio candidate conformance/E2E 已在各 owner canonical source/tests/readback 闭合。Studio 仍是 candidate；是否替换 active shell 继续由 App owner 显式选择并重新准入，本文不外推 release-ready。 |
| High-value Package topology | `workspace_source_candidates_landed_publication_open` | Runway executor、Foundry evaluation、Connect discovery、`opl-package-host` 与 Cordis ABI 已形成 workspace/source candidates 和真实 caller；只在有真实独立发布节奏、consumer 和 currentness/readback 时独立发布或拆仓，不按品牌或 plugin 数量机械拆分。 |
| Bounded security hardening | `first_local_compatibility_batch_implemented_verified` | Codex Security scan `03a5506e-0f1b-4ddd-ba53-b33a0c8e6a83` 的处置由 [`security-hardening-worklist.json`](../../contracts/opl-framework/security-hardening-worklist.json) 持有。首批四项局部兼容修复已实现并通过回归；安全 lane 默认在真实受损边界内局部拒绝，在边界外 fail open，不把 finding 清零当成交付指标。 |
| Ponytail 低风险简化 | `low_risk_slice_landed_owner_gated_tail_remains` | OPL Framework 已删除已证明无生产 caller 的 pass-through facade 文件，同时通过 canonical kernel 保留既有 public symbols；并清理孤儿 runtime helpers、专属测试/脚本和无引用图片。对外 contracts、Package/payload 历史、release cohorts 与仍可能被外部消费的 schema 保持 owner-gated，不把仓内零引用当作物理删除授权。Fallow 动态入口只登记真实运行期拼接加载的模块；扫描配置校准不扩大删除授权。下一轮只从 fresh caller/consumer evidence 选择新的最小 cleanup slice。 |
| Active Truth 治理 | `single_owner_guard_active` | 本文是唯一 active truth owner，只保留当前 gap、完成口径与下一轮 baton，不保存 dated proof 或 closeout 流水。 |
| Live / release / production / owner evidence | `deferred_to_evidence_owners` | 继续由 App release、provider long-soak、Brand L5、domain owner receipt、typed blocker 与 human gate 等 owner surface 单独证明。 |

这些状态只描述当前文档治理与非 live 功能 / 结构 gap 选择，不表示 runtime ready、domain ready、App release ready、Brand L5、production ready、owner acceptance 或 physical delete authorized。

## 当前功能 / 结构读法

当前默认读法：默认 OPL family maintained repo 的非 live 功能/结构基线只能从 fresh repo truth、四份 `contracts/opl-framework/foundry-*.schema.json`、FoundryRun source/tests 与各 domain owner surface 读取。本文不冻结日期、branch、SHA、`origin/main` 状态、receipt id、worktree closeout、workflow run 或某轮 readback。

当前 active 非 live 功能/结构 gap 有六个相互关联但不互相替代的切片：

1. `cordis_host_runtime_composition_adoption` 已完成默认 Framework Host cutover。正式
   `@deepseek-ai/cordis` 是 OPL 进程内组合框架；P1-P4 契约、P5 vertical seams 与 P6
   `base-headless` profile/default caller 已落地。真实 CLI/Runtime 路径通过显式 service injection
   消除隐式 singleton/启动顺序，profile snapshot/digest 保留 child composition refs，finally
   teardown 保证 fiber 生命周期闭合。收益是 provider、observer、executor、catalog、stage route
   可独立替换、诊断、版本化和按 profile 组合，为 Harness 自进化提供可冻结、可评估、可回退的
   composition substrate。Package/native carrier、Temporal durability、Workspace bytes/binding、
   Ledger receipts/evidence、Foundry activation、domain truth 和 App/Cloud product authority 不迁入 Cordis。
   Package 托管兼容由 Framework 的 `opl-package-host` 统一提供：标准 Agent、能力 Package 和
   workflow profile 按 manifest kind 解析 host contract，绑定最终 profile 与 root/child snapshot；
   required capability 缺失阻断本次托管启动，optional capability 缺失只产生 degraded 诊断。
   该 ABI 覆盖 MAS/MAG/RCA/OMA/BookForge、MAS Scholar Skills/OPL Persona/OPL Relay 与 OPL Flow，
   不要求这些 owner 仓各自创建 Cordis Host，也不取消其 standalone 运行路径。
   Post-cutover caller parity 进一步要求 App action、Workspace adopt/ensure 和 managed Agent checkout
   使用同一 profile-bound Connect discovery service；Atlas catalog、managed-provider projection 和
   pack compiler source mode 也必须由 caller 显式选择，缺失依赖 typed fail，不得静默回到旧 wiring。
2. `host_derived_client_cordis_and_dual_gui_abi` 是当前产品层 cutover。Framework 是唯一 Host
   composition authority，并向 App 投影 allowlisted client graph；AionUI 主线和 DSH GUI候选必须
   从同一 App product profile、Client Contribution descriptor、typed slots/actions和 RPC/events创建
   Client Cordis。Client不得独立发现/安装 plugin、维护第二 registry/currentness、获得 release-operation
   service或签发 product/domain verdict。具体实现与验收归 App/AionUI/DSH GUI owner source。
3. `family_capability_domain_and_source_topology` 已把品牌层收敛为跨 Framework/App/Cloud 的
   唯一动态 capability portfolio，并把 Framework 源码从历史 `src/modules/<brand>/` 迁到
   `authority/adapters/read-models/host/entrypoints/kernel` 责任拓扑。13 个 source units、6 个 target roots
   的物理 cutover 已完成，legacy root 已 retired/absent。后续调整仍必须 successor-first、切真实 caller、验证 affected outcome/public
   exports，并以 structural caller=0和 owner readback维持退役语义。Console明确分层为
   Cloud control-plane、App product/page/action和 Framework read-model/projection。
4. `high_value_package_topology` 为 Runway executor、Foundry evaluation、Connect discovery和
   `opl-package-host` 建立独立版本/发布候选。只有真实 consumer、独立发布节奏、currentness/readback
   和回退证据齐备才提升为独立 Package 或仓库；不按品牌或全部 plugin 机械拆包。
5. `opl_package_platform_composition` 是保留的独立迁移切片。Phase 1 已完成 SSOT 与冻结
   实施计划；Phase 2 已获用户批准并进入 successor-first controlled cutover。先让
   successor-only Package plane 形成可验证、可回退的真实纵向链路，再切换全部 production
   caller 并通过 affected OUT / real-carrier acceptance；只有 structural caller 为零且
   对应 owner decision / physical-delete gate 成立后，才进入受控 legacy bulk deletion。其
   计划见 [`opl-package-platform-composition-migration.md`](./opl-package-platform-composition-migration.md)。
6. `bounded_security_hardening` 只处理当前可证的安全边界。第一批 Host、Git URL evidence、
   Provider response body 和 Workspace projection 采用局部兼容修复；Redirect 与 Python handler
   只在 caller/runtime inventory 后 canary；CAS、E2B、Carrier 与 mutable channel 保持
   evidence/owner route，不增加 Framework 第二 resolver、lock、LKG 或签名 registry。

这些切片共享 Framework Integrator，但 authority 不合并：Cordis contribution只做进程内组合，
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
| Framework Host Cordis | `landed_default_base_headless_explicit_caller_parity` | Framework Integrator；owner-specific live readback 仍归各 owner | P0-P6 已进入 canonical main。`base-headless` 是 CLI/Runtime 默认 Host profile，P5 vertical seams、P5-R 五层目标图、snapshot/digest/teardown、legacy WorkspaceBindingPort caller-zero，以及 CLI/App/Workspace/managed Agent/Runtime 显式 service caller parity 已闭合。后续保持 DSH/Cordis上游兼容；不得新增第二 registry/lifecycle，或越过 Package/Temporal/Workspace/Ledger/Foundry/domain/App/Cloud owner边界。 |
| Host-derived Client Cordis / dual GUI | `aionui_admitted_studio_candidate_conformance_landed` | Framework Host projection + App product owner；AionUI/Studio renderer owner | Host allowlisted client graph、Client Contribution ABI、App product profile、typed slots/actions、RPC/events 与 state semantics 已统一，并由两个 renderer 的真实 caller/E2E 证明。AionUI 是当前 admitted active renderer；Studio 是已验证 candidate，只有 App owner 显式选择并重新执行 compatibility/release admission 后才能替换，不建立第二 discovery/install/currentness/action truth。 |
| Family capability/source topology | `physical_cutover_landed_brand_portfolio_aligned` | Framework Integrator + 各产品/authority owner | 当前 11 个品牌 capability domains 由唯一 portfolio 管理，Framework 十项 registry 是 surface projection；13 个 source units / 6 个 target roots 已完成 successor-first 物理重排，`src/modules/**` retired/absent；Console 分层为 Cloud product、App product 与 Framework projection。 |
| High-value Package topology | `workspace_source_candidates_landed_publication_open` | Framework/Package owners | Runway executor、Foundry evaluation、Connect discovery、`opl-package-host` 与 Cordis ABI 已形成 workspace/source candidates；独立 publication/拆仓必须有真实发布节奏、consumer 与 currentness/readback，不按品牌或 plugin 数量机械拆分。 |
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

Framework Host 默认切换、动态品牌组合、source topology 和双 renderer conformance 已完成。下一轮只在
App owner 决定切换 active shell 时重开 Studio compatibility/release admission；Framework 不把候选存在本身
当作待完成迁移。其余优先级回到 `high_value_package_topology`：先读取 fresh consumer、独立发布节奏、
source/package exports 和 owner currentness，再为每个真实 publication slice 冻结唯一 owner、exact write set、
affected outcome 与回退门禁。品牌组合只在真实 owner/caller 变化时更新；独立 Package 不能因命名或
plugin 数量机械拆包。
不得因上游新能力恢复平行 registry/event bus/lifecycle；任何 Host或 Client caller必须显式选择 profile、
source identity与 disposer。Package platform composition仍按其独立 M1-M4 baton推进，不能被 Cordis docs
或 workspace package候选替代。
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
- Cordis 默认 composition 已落地，但 plugin inspect、snapshot、contract pass 或 focused tests仍不等于 DSH 上游兼容闭合、Harness 自进化 live ready、Package/Temporal/Ledger/Foundry/domain/App ready 或 production ready。
- Docs foldback、contract pass、focused tests、projection clean、doctor clean、native-check pass 或 refs-only ledger 不能替代 runtime/live/owner evidence。
- Support repo、Aion/Hermes、MAS Scholar Skills、Homebrew、OPL Doc retired tombstone 或 Native Workbench 不能反向定义 domain/App/framework truth。
- 历史归档不能替代实现清理；旧模块、旧接口、旧测试和旧文档入口被当前 owner surface 替代后，只能按 owner decision 直接退役或 tombstone。
