# OPL Framework 合同

Owner: `One Person Lab`
Purpose: `opl_framework_contract_support_index`
State: `active_support`
Machine boundary: 本文是 OPL Framework contracts 的人读支撑索引。机器 truth 继续归 JSON contract files、source、tests、CLI/read-model、runtime ledger 和 provider/domain receipts。

这个目录保留 `OPL Framework` 当前活跃的 framework、runtime 与 family control-plane 合同语料。`One Person Lab App` 和已安装 OPL Packages 可以消费这些合同，但不在本目录定义 App、Package 或领域 owner 的第二套运行时真相。Foundry Agents 是专业 Package 家族，不是独立产品层。

## Release event 与 consumer 边界

`release-bundle-operation-event.schema.json` 与
`release-bundle-consumer-envelope.schema.json` 是现有 immutable Release Bundle
store 的只读投影。`opl release events` 从 operation receipts 确定性派生带 cursor
的 append-only feed；重复读取幂等，consumer ack 不修改 Framework 状态。`opl
release consumer envelope` 把 Standard 或 Full consumer trigger 绑定到 Bundle、
独立 operation control、checkpoint stage、精确 asset、source pin、evidence refs 和
latest event id；Full 还必须绑定精确 source checkpoint run id。两个 surface 都不
授予 dispatch、retry、reconcile、publication 或 release-state authority。恢复入口仍是
`opl release status`，只有 owner-authoritative unknown marker 存在时才进入 exact
`opl release reconcile`。

它继续被仓库跟踪，是因为当前 framework 需要稳定的机器可读输入：

- stage-led 任务选择
- `OPL Base`、`OPL App`、`OPL Packages` 与正在落地的 `OPL Cloud` 的生态所有权
- 已收录 domain-agent / Foundry package 目录投影
- provider-backed runtime attempt
- Codex-selected semantic route 的被动 transport/currentness readback；Framework 不运行 transition table、route oracle 或 matrix evaluator
- StageRun transport 覆盖 queue、raw artifact capture、refs-only memory writeback、human gate、retry、dead-letter 与 repair request
- domain pack compiler 与 generated interface 只读模型从 admitted domain pack 或标准智能体仓合同派生 CLI / MCP / Skill / product-entry / OpenAI / AI SDK / sidecar / status / workbench / harness 投影
- Pack Bundle 把大型 JSON consumer surface 拆成可编辑 source parts、可再生 aggregate 和 bundle manifest，避免继续手改巨大聚合文件，同时保持生成物只作为 consumer compatibility surface
- brand-module registries 和 CLI/read-model contracts 为 Charter、Atlas、Workspace、Pack、Stagecraft、Runway、Ledger、Console、Foundry Kernel 与 Connect 提供 Workspace-level structural baseline
- 复杂 domain agent 的 Stage graph / StageRun / 独立 Attempt / owner-route 输入 / ABI guard 边界，其中 Stage 是主要开放语义判断，只有 progress-terminal decisive Codex Attempt 才输出权威跨 Stage route
- Codex CLI 单一 stage 语义路由 owner：OPL 只做 declared-stage transport、identity/currentness、attempt durability 与被动投影
- target operating architecture 记录资源模型、Codex-owned 语义路由、Domain Pack ABI、运行时投影、App Console 默认字段和 Foundry Kernel 生命周期 owner
- cognitive computation kernel 声明 Stage 策略、tool affordance、knowledge 与独立 quality-gate refs；selected executor 执行策略，domain owner 提供 verdict
- advisory knowledge 以 domain-owned memory refs、prompt context、receipts 和 projection 进入 Framework
- workspace / source / artifact / memory 索引和 App/operator workbench 只投影 domain-owned content
- OPL-compatible agent 的 framework 运行依赖定位
- Runtime Manager readiness 与状态投影
- GUI 实现消费的 App runtime state/action CLI 边界
- 可选 native helper 生命周期检查

当前生态模型是 `OPL Base + OPL App + OPL Packages + OPL Cloud`。`one-person-lab` 实现 Base，并持有 `framework_runtime_package_graph_and_app_projection` scope 内唯一的 Cordis Host；`one-person-lab-app` 持有唯一 App 产品、GUI ABI、Client profile、发布组合和 active-shell 决策；`opl-aion-shell` 是当前 Stable Shell，`opl-studio` 实现 `dsh_profile_plugin_lifecycle_codex_and_delivery_transport_composition` scope 的候选 DSH/Cordis Application Host。Packages 是可独立安装、版本化和发布的能力产品，MAS/MAG/RCA 作为 Foundry Agent Package 家族成员保留各自领域 authority；Cloud 是正在落地的在线产品层。品牌/认知域、authority owner、Package 发布单元与 Cordis plugin contribution 是四种独立结构。执行链路仍是 `Codex CLI first-class executor + explicit OPL activation + configured family runtime provider + installed Package discovery`。

### Host scope 边界

`cordis-architecture-profile.json#host_scope_boundary` 是两 Host 边界的机器 owner。
Framework Host 在 runtime、Package graph 与 App projection scope 内保持唯一；Studio
可以在不转移 authority 的前提下运行独立 Application Host，因为它只消费 App
state/action、authentication 和 channel callback 公开合同。两者不得形成第二套 OPL
runtime、Package registry/currentness、App state/action、domain、product 或 release
authority，也不共享内部 registry、session 或 service graph。

## 当前真相应去哪里看

当前 `OPL Base / App / Packages / Cloud` 四层生态模型应优先回到：

- `README*`
- `docs/project.md`
- `docs/status.md`
- `docs/architecture.md`
- `docs/decisions.md`
- `contracts/README.md`

如果要恢复当前 repo-owned capability surface，则继续阅读已收录 domain 仓及其被 `opl connect sync-skills` 激活的 app skill。

## 目标架构合同组

这些 schema 文件是 OPL target architecture 的机器可读面。它们的 machine boundary 只覆盖 framework-owned 形状、refs、launch / audit / fail-closed 语义与 App/operator 投影；不把 domain truth、artifact body、memory body、owner receipt authority、quality verdict、production readiness 或 App release authority 移入 OPL。

### Target Operating Architecture

- `target-operating-architecture-contract.json`：顶层目标操作架构合同。它冻结资源词汇、Codex CLI 单一 stage 语义 route owner、任意可读 artifact 即可推进、Domain Pack + generated surfaces + authority functions 标准 ABI，以及 OPL 只做被动 transport/currentness/runtime projection 的边界。
- `advisory-knowledge-boundary-contract.json`：family-level domain-owned Markdown memory 边界合同。它固定默认规则：memory refs 是 `reference_only_prompt_context`，OPL 默认只运输 body-free refs，缺少 advisory memory 不阻断 launch；只有 source/data authority、owner identity、forbidden write、不可逆 mutation、hard reviewer / publication / final export / submission claim 或 owner-receipt / typed-blocker claim 才升级为 hard gate。

### Owner Delta Kernel

- `current-owner-delta.schema.json`：紧凑的默认 owner / delta / hard-gate / action payload 与 ordinary next-action root。
- `owner-answer.schema.json`：owner receipt、typed blocker、human decision 与 route-back 的统一 return shape。

### Stage Artifact Unit

- `stage-run-kernel-contract.json`：refs-only StageRun transport/event-log/read-model、currentness、quality budget、failure diagnostic 与 domain authority boundary。
- `stage-artifact-unit.schema.json`：physical output、manifest、content hashes、owner answer、current pointer、lineage 与 progress truth 边界。
- `workspace-topology-profile.schema.json`：`Workspace Group -> Project Unit -> Stage Artifact Unit -> Owner Receipt / Typed Blocker` profile schema，固定 `workspace_modes=one_off|series|portfolio`、默认 physical `project_collection_path=projects`、canonical `projects/<project-id>` roots；`studies` / `deliverables` 等 domain-declared 名称只作为 display 或 provenance terminology，不定义 Framework profile、physical root 或 lifecycle。该 schema 同时固定 `project_stage_outputs_root=artifacts/stage_outputs`、profile version/fingerprint binding、migration history、topology event provenance 与 runtime-state-as-provider-backing/provenance 边界。
- `pack-bundle-contract.json`：大型 JSON consumer surface 的 source-parts 到 generated-aggregate 合同。它由 `src/pack-bundle.ts` 与 `opl pack bundle manifest|write|check --assembly <path> --json` 消费。可编辑 source parts 是真相源；generated aggregate JSON 只是带 generated metadata 和 `do_not_edit=true` 的 tracked consumer compatibility surface；bundle manifest 记录 source entries、source digest、expected aggregate hash、generator commands 和 false-authority flags。Bundle validation 只证明 source/aggregate 一致性，不声明 domain ready、production ready、quality verdict、artifact authority、owner receipt、typed blocker 或 domain truth mutation。
- `pack-native-helper-probe-contract.json`：Pack 对 domain-owned native helper 的 provider/domain-neutral 探测合同。`opl pack native-helper probe --descriptor <path> --json` 只解析 descriptor-relative helper entrypoint 与声明的 runtime/tool commands，返回由 descriptor/content SHA-256 绑定的确定性 `resolved|missing` receipt；它不执行 helper、不渲染 PDF/image asset、不修改 artifact、不签 owner receipt、不创建 typed blocker，也不授权 quality/publication/export readiness。
- `pack-native-helper-execution-contract.json`：Pack + Runway 的通用 Python helper 执行载体。`opl pack native-helper run --catalog <catalog.json> --helper <id> --request <request.json> --json` 只解析 domain 声明且 containment 通过的 source root / module / argv，持有有界进程生命周期并要求 stdout 为单一 JSON；receipt 只记录 transport provenance，不授权 domain truth、视觉质量、artifact mutation、export readiness 或 production readiness。
- `agent-scaffold-materialization-request.schema.json` 与 `agent-scaffold-materialization-contract.json`：OPL Foundry Kernel 在 Pack 内部消费 producer-authored scaffold request 的物理物化边界。v2 ABI 通过 `producer_agent_id` 保持 producer-neutral；已退役的 producer-specific request version 直接 fail closed，不保留 active 兼容 adapter。只替换声明文件，只允许 descriptor/capability map 浅合并，path/symlink escape fail closed，最终文件 SHA-256 与 build receipt 由 OPL 按写后 bytes 生成；producer 输入仍是 candidate，validation refs 仍是待执行请求而不是通过或 readiness claim。
- `standard-agent-implementation-profile.schema.json`：标准 Agent 的实现语言与 helper 边界。`implementation_profile` 只把 identity 固定为 declarative Markdown/JSON pack，允许 authority/domain/native helper 可替换，明确 helper 语言不是 Agent kind，`rust_policy=framework_hot_path_only`；generated surfaces 仍归 OPL。新 scaffold 默认生成该 profile，legacy pack 缺失在 conformance 中作为迁移缺口读取。
- `source-derived-agent-design-abi.json`：OMA 等 producer 向 OPL Foundry Kernel 提交 source-derived Agent design typed objects 时使用的通用 identity；producer 保留设计语义，Framework 持有校验、物化 digest 和最终 `AgentBuildReceipt`。
- `python-executor-client-contract.json`：`opl executor run` 的共享 Python carrier，持有临时 request 与 process-group cleanup，解包 canonical `AgentExecutionReceipt`，并对 timeout、非零退出、JSON 或 receipt shape 漂移 fail closed，不接管 executor 或 domain authority。
- `pack-os-contract.json`：通用 Pack OS lifecycle 合同，覆盖 capability-pack descriptors、install registry entries、content-addressed cache manifests、refs-only distribution bundles、refs-only lock projection、artifact lifecycle refs 与 review receipt transport。它由 `src/authority/packages/pack-os.ts` 与 `opl pack os inspect|install|registry|cache|distribute|lock|validate --json` 消费。domain-owned adapter 负责产出通用descriptor；Pack OS不再保留MAS专用conversion或smoke contract。lock和distribution bundle只记录descriptor refs、本地存在文件的content hashes、artifact locator refs、lifecycle state refs、review receipt refs、provenance与authority-boundary flags，不存artifact body、不改domain artifact、不签owner receipt、不授权quality/readiness claim。
- `submission-resource-requirements.schema.json`、`submission-resource-provision-request.schema.json` 与 `submission-resource-provision-receipt.schema.json`：定义 `opl_pack_provision_submission_resource` / `opl pack provision-submission-resource` 的 exact-local-file 供应 ABI。OPL 只消费 domain-owned `provisioning/package_path/path_env` 声明；`path_env` 只作 operator guidance，运行时不读环境变量、不下载、不做 URL fallback。package path 必须 containment 且无 symlink，host file 必须由 caller 显式给 absolute exact path并稳定读取；输出只进入 OPL content-addressed cache和false-authority receipt，dry-run零写入。这不是 Agent Package install/update/repair 生命周期，也不授权 submission ready、quality verdict、artifact authority或owner receipt。

### Evidence Ledger

- `evidence-ledger-event.schema.json`：raw evidence、provider trace、replay、receipt ledger、typed blocker group、soak、no-regression、cleanup 与 diagnostic refs 的 passive audit-only event envelope。
- `observability-semantic-conventions-contract.json`：OPL Ledger / Runway / Console 共享的 trace、metric、log/event 语义词汇，固定 `stage_run_id`、`attempt_id`、`domain_id`、`owner_id`、`route_ref`、`receipt_ref`、`typed_blocker_ref`、`workflow_id`、`task_queue`、`generation`、`source_fingerprint` 等 refs-only 字段；它不创建私有 ledger UI，不保存 payload body，不写 domain truth，不创建 owner receipt / typed blocker，也不声明 readiness。
- `cli-command-registry.json`：受保护 CLI 的 canonical metadata registry，记录 parser adapter、options、output schema ref 与 authority boundary。command spec 直接绑定该 metadata，不再内联重复；registry 不执行命令，也不声明 readiness。
- `src/entrypoints/cli/main.ts`：直接从 executable command builder（`private-command-specs.ts` / `public-command-specs.ts`）构建完整 CLI surface，不再维护生成式 metadata-only 镜像。

### Golden Path

- `golden-path-profile.schema.json`：每个 Foundry Agent 一个 ordinary route，以及显式 proof / diagnostic / cleanup / replay / debug variants。

### Cognitive Computation Kernel

- `cognitive-computation-kernel.json`：Stage 内部策略内核，覆盖 candidate generation、grounded reflection、comparative selection、evolution/revision、strategy retrospective、tool affordance boundary、knowledge binding 与 independent quality gates。工具 refs 是可用 affordance，不是 prescribed workflow；strategy retrospective 也不是跨 Stage Meta Review。

### Stage 内质量循环

- `stage-quality-cycle-contract.json`：定义非模型 Temporal `StageRunWorkflow` 父级 controller，以及有界的 `producer | reviewer | repairer | re_reviewer` child Attempt。同一目标的多次生成、审阅和修复是 Attempt；目标、owner、质量门或交付关系发生变化，就是新的 Stage。controller 只管理同一 StageRun 内的 child Attempt 拓扑；跨 Stage 专业路由仍归终局 Codex Attempt。OPL 只校验终局 role、route shape、legacy 字段缺失、finding-closure 和 declared target，再由 controller 物化通过校验的 transition，不判断 ABI 合法路线在专业上是否正确。终局决定缺失或被拒绝时，fallback 只能沿 action ordered `required_stage_refs`；没有 action route 时只能沿当前 Stage 唯一的 `next_stage_refs`，manifest 文件顺序不能替分叉做决定。
- `stage-quality-cycle.schema.json`：校验每个 Stage 的 domain quality policy，但不在 Manifest 枚举运行时 Attempt 实例，也禁止 Attempt overlay持有 Stage 拓扑或 transition authority。
- `epistemic-review-currentness-contract.json` 与 `epistemic-review-scope-v2.schema.json`：按显式 artifact、claim 与 provenance 依赖判断内容审查 currentness。默认是可信本地工作区中的认识论可追溯证据；hash 只作可选定位或 stale hint，软件发布完整性使用独立合同。
- `official-knowledge-deliverable-quality-profile.json`：要求 MAS、MAG、RCA、OMA、OBF 为每个 AI Stage 显式声明质量策略，并统一启用独立顶层 Meta Review；是否启动 Stage 内正式 Review 由该 Stage 的风险决定。Packaging/Handoff 若在 Meta Review 后生成需要专业判断的新/转换后交付 bytes、冻结 canonical bytes，或签发 quality/export/publication/ready claim，必须 fresh Review；只运输已审 immutable refs，或只对已审 bytes 做确定性机械封装，且 acceptance 留给下游 owner 时可保持 primary-only。
- 正式 Review 必须使用新的 child workflow和 provider session；`in_thread_refinement` 与 `protocol_closeout_resume` 都不是 Review。协议补全强制使用 read-only sandbox，只有返回包绑定既有 Attempt identity 且 resume 期间没有 command / unsupported function event 后才记成功，且不消耗质量轮次。三轮修复预算与 provider/activity/structured-output/runtime retry完全分账。领域包一旦在 Stage Manifest 声明内部质量循环，就必须在机器策略和 reviewer/re-reviewer 提示片段中分清“当前 Stage 内继续修复”与“预算耗尽前跨 Stage route-back”；任何由该 policy 引用且使用机器 outcome token `repair_required` 的 Markdown 提示都必须命名两条分支。`opl agents conformance` 还会拒绝已退役的单分支 `repair_required_with_budget_remaining_route_output`、scope 不清的 `producer_or_repairer_may_return_terminal_route_decision`、越界/非法 ref，以及缺失或反转的 scoped route authority。primary-only producer 仍可作终局判断，formal Review producer 不作终局判断，repairer 始终不作终判断。带 exact ref/hash 的 no-output 或 failure diagnostic 是可消费进展 artifact；只有 candidate 与这种 diagnostic 都不存在时才是 literal zero。只有草稿 policy 文件、但未在 Manifest 声明的 Agent 不受影响。
- StageRun 创建必须绑定 domain pack：`opl family-runtime attempt create` 把已编译 Stage manifest 与 quality policy 解析成 `opl_pack_bound_stage_quality_runtime_binding`。`stage_run_id` 只由 domain + stage + durable invocation 派生；manifest SHA 与其他不可变启动输入进入 `stage_run_spec_sha256`。raw `family-runtime stage-run start` 已退役；`stage-run` 只保留 query。
- 进入任一非 producer Attempt 前，本地 artifact 由 OPL transport 分块读取稳定的当前 bytes、重算 SHA，并校验文件名绑定 receipt exact bytes 的 content-addressed `opl_transport_artifact_identity_receipt`；外部 artifact 必须提供可信 authority root 下、可独立读取且同样 content-addressed 的 domain-owned identity receipt。`artifact_producer_attempt_ref` 独立于 `parent_attempt_ref`，必须精确绑定当前 artifact 的 producer/repairer。正式 review receipt 绑定这些 exact refs/hashes、fresh producer/reviewer session、rubric、finding lineage 与 controller verdict，不能由文件存在或 provider completion 合成。Temporal 行为演进必须通过 patch marker 与旧 history replay fixture 保持可重放。

## 这个目录应该怎么读

- `workstreams.json`、`domains.json`、`stage-selection-vocabulary.json`、`task-topology.json`、`family-capability-domain-registry.json`、`brand-module-registry.json`、`brand-cli-governance.json`、`brand-module-surfaces.json`、`brand-module-l5-operating-evidence.json`、`brand-system-profile.json`、`target-operating-architecture-contract.json` 和 `public-surface-index.json` 定义当前选择、owner、模块、L5 evidence、目标架构和公共 surface。`family-capability-domain-registry.json` 是 family portfolio source；brand registries 供对应 CLI 读面消费；`public-surface-index.json` 列出 active surfaces、owners、refs、routes 和 notes。domain verdict 归 domain owner，App release truth 归 App 仓。
- `family-product-operator-projection.json` 同时声明 GUI runtime 边界：`opl app state --profile fast --json` 继续提供默认页面状态；`opl app state --profile runtime --json` 是通过 `opl_app.runtime_state_profile.v1` 发现的显式 runtime capability，尚不代表 App 默认切换；`--profile full` 仅用于显式刷新。`opl app action execute ... --json` 承接 App mutation，`opl runtime app-operator-drilldown --detail full --json` 是运行状态 full drilldown 的按需例外。沿用稳定文件名的 `app-runtime-fast-work-item-projection-contract.json` 约束 runtime/fast bounded 投影包含 Agent -> Project -> Work Item 导航、Stage 弹层、当前 Attempt、Token 和归档状态所需的全部已登记 Work Item 摘要，同时限制 Attempt refs 并排除诊断正文。OPL Framework 只做 GUI-ready state/action producer；GUI 产品真相、release gate、页面状态政策与 active-shell validation 仍归 `one-person-lab-app`；`opl-aion-shell` 是当前 App-owned contract 的 implementation carrier，且不能把 raw full drilldown 当成正常 GUI state。
- `family-runtime-online-substrate-contract.json`、`family-runtime-attempt-contract.json`、`stage-route-transport-contract.json`、`cognitive-computation-kernel.json`、`stage-artifact-runtime-contract.json`、`state-index-kernel-contract.json`、`domain-pack-compiler-contract.json`、`pack-os-contract.json`、`generic-substrate-projection-contract.json`、`foundry-agent-series-contract.json`、`standard-domain-agent-skeleton-contract.json`、`functional-privatization-audit-envelope-contract.json`、`managed-runtime-three-layer-contract.json` 和 `runtime-manager-contract.json` 是当前 provider-backed family runtime / generated-surface / generic pack lifecycle 主线的活跃机器合同。`foundry-agent-series-contract.json` 是 MAS/MAG/RCA/OMA/new agent 共享的 Progress-First 系列合同：每个 Foundry Agent 都声明同一组 identity、stage authority、progress/currentness/closeout packet、typed blocker lineage 与 App projection 边界，同时把 domain truth 和 verdict authority 留在 domain repo。`stage-route-transport-contract.json` 固定 OPL 的 graph/reconciliation/read-model 调度边界：OPL 持有 stage graph、route hydration、attempt ledger 和 reconciliation loop；domain owner 持有 route 语义、owner receipt、typed blocker、truth、quality verdict 和 artifact authority。`cognitive-computation-kernel.json` 定义 Stage 内部认知策略层：generation、reflection、comparative selection、evolution、strategy retrospective、available tool affordances、knowledge use 与 independent quality gates 都是 stage-pack declarations 和 refs，不是 OPL-held domain truth、route execution semantics 或工具 workflow script。`stage-artifact-runtime-contract.json` 固定 Stage Folder Contract：`runtime-state/domains/<domain>/deliverables/<program>/<topic>/<deliverable>/stages/<nn-stage>/attempts/<attempt_id>`、attempt 必备条目、`opl stage open`、receipt-backed `opl stage commit`、物理目录优先的 `status` / `explain`、可重建 index、latest/current pointer 维护、refs-only canonical pointer promote、sha256 content hash、lineage event、strict conformance、artifact-native workbench projection 和 dry-run-first retention/restore 边界。`state-index-kernel-contract.json` 固定 SQLite sidecar 分工：file / Stage Folder 仍是 portable truth，SQLite 只存 stage-attempt / lifecycle / artifact / lineage / outbox / read-model 的可重建索引和有界 payload envelope，Temporal 仍是 production durable execution substrate；SQLite 不存 domain truth、memory body、artifact blob、owner receipt authority、quality/export verdict、provider authority 或 production readiness authority。`opl index doctor|rebuild|checkpoint|integrity-check|backup --json` 是这条分工的可执行维护面：`doctor` 只读诊断，`rebuild` 维护 `${OPL_STATE_DIR}/family-runtime` 四个 OPL sidecar 数据库，并从物理 Stage Folder 的 manifest、receipt refs、content hash、lineage 和 retention proof 回填 `artifact-index.sqlite` 与 `read-model.sqlite` refs-only rows。标准 Foundry Agent 通过 `contracts/stage_run_kernel_profile.json`、`contracts/stage_run_canary_evidence.json` 和 `contracts/stage_artifact_kernel_adoption.json#/opl_state_index_kernel_adoption` 声明 domain 侧接入分工；独立 state-index adoption 文件只保留兼容读取且不由 scaffold 生成。`opl agents conformance` 会阻止缺失 StageRun profile、缺失 controlled canary evidence、SQLite truth store、大 body、owner receipt、verdict、未知 ownership declaration 和 generic persistence owner 声明。Stage 路由由 Codex CLI 根据 declared stage context 选择；OPL 不再编译 transition runner 或 functional harness。`functional-privatization-audit-envelope-contract.json` 定义 AI-first、contract-light 的 envelope，供 descriptor 与 App/operator drilldown 归一化 MAS、MAG、RCA 和标准 scaffold 的私有功能审计形状，但不声明 domain truth 或 readiness。`domain-pack-compiler-contract.json` 定义 `opl agents pack-compiler`、`opl agents interfaces` 和 `opl agents conformance` 只读把 descriptor、标准仓 action/stage 合同、runtime surface 和 `functional_privatization_audit` 投影成 OPL-owned generated-surface、generated interface bundle 与 family-wide standard-agent conformance report，并在 pack compiler list/inspect 中输出 `generated_artifact_drift_manifest`，记录 domain pack/source input fingerprint、generated bundle fingerprint、`generated_from` refs 与 `aligned` / `drift_detected` 状态。`pack-os-contract.json` 定义 `opl pack os inspect|install|registry|cache|distribute|lock|validate --json`，把 capability-pack descriptor解析为refs-only registry entry、content-addressed cache manifest、distribution bundle、lock、content hash、artifact locator refs、lifecycle refs和review receipt transport；domain-owned adapter负责产出通用descriptor，Pack OS不保留domain-specific conversion或smoke contract。`agents conformance` 把 scaffold validation、canonical `agent/` pack root、README-only path guard、generated-surface owner、generated interface readiness、private-surface generic-owner guard、StageRun profile、controlled StageRun canary evidence、Stage Artifact adoption、State Index adoption、Foundry series contract 和 production evidence tail 拆成机器读面；它只证明结构归位和 controlled fixture 证据形态，不声称 live soak、App 真实用户路径或 domain readiness 已完成。这些命令可从同一份 canonical action/stage metadata 派生 CLI、MCP、Skill、product-entry、OpenAI 和 AI SDK 描述；它们不生成 domain handler，不写 domain truth / memory body / artifact，也不授权 quality 或 export verdict。`generic-substrate-projection-contract.json` 定义 OPL 对 domain-declared workspace、source、artifact、memory refs 的 locator / index / lifecycle projection，以及 App/operator drilldown workbench 分组；它不读取或写入 domain truth / body / verdict / authority。`family-runtime-online-substrate-contract.json` 同时声明 Temporal provider SLO cadence action envelope，用于路由 supervised production proof 执行，但不授权 domain readiness。
- 当前 durable StageRun 澄清：`stage_run_id` 只由 domain + stage + invocation 派生；不可变 pack/manifest/policy/source/checkpoint/input/rubric/lineage 进入 `stage_run_spec_sha256`；`stage_run_launches` 是 Temporal start 前的窄 transport registry，不是 domain truth。终局 decisive Codex Attempt 持有语义 route decision，StageRun controller 只校验并持久化启动目标 Run；本条机器边界覆盖上段旧简写。
- `family-runtime-attempt-contract.json` 同时定义 `current_provider_readiness` 与 `stage_progress_log` 作为 OPL family-runtime attempt/progress canonical projection。`current_provider_readiness` 暴露在 `attempt query` 顶层 wrapper、嵌套 `stage_attempt_query` 与 operator visibility；它是当前 provider inspection，并显式标记创建时 `provider_receipt` 只是 snapshot。`stage_progress_log` 的 `surface_kind=opl_stage_progress_log`，该读面把 intended work、actual work、timeline、usage、Temporal visibility refs、evidence refs、authority boundary、provider status refs 和 domain receipt refs 投到 `attempt query`、operator visibility、Foundry Kernel evidence inputs 与 runtime-tray workbench summary。其 `user_stage_log` 子面向用户回答 stage 名称、问题、做了什么、耗时、token/cost 状态、结果、剩余 blocker 和证据 refs；OPL 只拥有 timing / usage / refs 与显式 missing/null 状态，人话 domain 语义必须来自 domain typed closeout 的 `user_stage_log`、`stage_log_summary` 或 `human_stage_log`。同一合同现在包含 clean-room 吸收 PilotDeck 模式后的 `memory_trace_projection` 与 `model_route_cost_projection`：memory trace 只投影 consumed memory refs、recall/retrieval trace refs、writeback receipt refs、rejected write refs 和 source refs，不读 memory body；route/cost 只把 selected model/executor route refs、route reason/tier/fallback refs 与 observed token/cost telemetry 关联起来，不改 executor、不自动降级、不替代 quality gate。summary 同时区分原始 usage duration telemetry 与 user-facing duration：`duration_observed_attempt_count` 只统计 usage/provider telemetry，`user_duration_observed_attempt_count` / `user_duration_fallback_attempt_count` 统计 `user_stage_log.duration` 中由 usage、provider started/completed 或 attempt created/updated 时间戳支撑的用户可读 duration，不把 fallback 写成 token/cost telemetry。标准 OPL Agent 使用 `stage_work_done` / `changed_stage_surfaces` 描述 domain deliverable 改动。Temporal provider 持有 durable workflow history、activity heartbeat、workflow query 与 searchable visibility；OPL 只把 `temporal_visibility` / `temporal_webui_ref` 投影为 refs-only metadata，Temporal Web UI ref 只用于 operator debug，不是 App 主状态页。Foundry Kernel 只消费这些 refs 作为 evaluation、root-cause、candidate design 和 follow-up read model 证据；它不拥有 runtime log、不执行 domain action、不写 domain truth，也不授权 quality 或 domain-ready verdict。退役 execution-log wording 只能出现在 tombstone/provenance 语境。
- `advisory-knowledge-boundary-contract.json` 是 family-level advisory knowledge 边界。它保持 domain Markdown memory 作为小集合、body-free、reference-only prompt context，并禁止 OPL 品牌模块把 memory refs 升级成 route scoring、winning-path generation、controller decision、quality gate、export / publication / submission gate、owner receipt 或 typed blocker。
- `attempt_true_path_proof` 是 refs-only 证明面，用来把同一 stage attempt 在 `attempt query`、stage-attempt projection、App full drilldown、`stage_progress_log`、Temporal visibility 和 Temporal Web UI debug refs 中的路径绑定起来。它只证明当前真路径可追踪，不声明 long-soak、domain ready、artifact authority 或 quality verdict。
- `contracts/family-orchestration/family-stage-proof-bundle.schema.json`、`contracts/family-orchestration/family-stage-graph-projection.schema.json` 和 `contracts/family-orchestration/family-stage-integrity-metadata.schema.json` 是 stage-pack proof、graph、integrity、claim-support、evidence-handoff、data-access 与 human-checkpoint metadata 的 companion contracts。它们属于 family orchestration，因为 MAS/MAG/RCA 把 domain projection 或 adapter 投影到这些 schema，同时把 domain truth 与 verdict authority 留在各自仓库；legacy citation-support 只作为 profile alias，不再是通用 ontology。
- `family-executor-adapter-defaults.json` 继续作为共享 executor 合同使用。
- 已退役的 gateway、federation、routed-action、onboarding、acceptance、governance 与 example corpora 不再保留在这个活跃 contract root 中。

## 文件清单

- `workstreams.json`
- `domains.json`
- `stage-selection-vocabulary.json`
- `foundry-design-request.schema.json`
- `foundry-agent-blueprint.schema.json`
- `foundry-evidence-bundle.schema.json`
- `foundry-evolution-proposal.schema.json`
- `external-suites/mag-live-acceptance-suite.json`
- `agent-platform-surface-ownership-contract.json`
- `family-capability-domain-registry.json`
- `family-capability-domain-registry.schema.json`
- `brand-module-registry.json`
- `brand-cli-governance.json`
- `brand-module-surfaces.json`
- `brand-module-l5-operating-evidence.json`
- `brand-system-profile.json`
- `cli-command-registry.json`
- `connect-reference-provider-profile.schema.json`
- `connect-scientific-search-provider-profile.schema.json`
- `external-skill-source-metadata.schema.json`
- `target-operating-architecture-contract.json`
- `observability-semantic-conventions-contract.json`
- `advisory-knowledge-boundary-contract.json`
- `codex-default-profile.json`
- `family-executor-adapter-defaults.json`
- `managed-runtime-three-layer-contract.json`
- `runtime-manager-contract.json`
- `family-runtime-online-substrate-contract.json`
- `family-runtime-attempt-contract.json`
- `stage-quality-cycle-contract.json`
- `stage-quality-cycle.schema.json`
- `official-knowledge-deliverable-quality-profile.json`
- `stage-run-kernel-contract.json`
- `stage-route-transport-contract.json`
- `cognitive-computation-kernel.json`
- `stage-artifact-runtime-contract.json`
- `current-owner-delta.schema.json`
- `stage-artifact-unit.schema.json`
- `workspace-topology-profile.schema.json`
- `owner-answer.schema.json`
- `evidence-ledger-event.schema.json`
- `golden-path-profile.schema.json`
- `state-index-kernel-contract.json`
- `family-domain-quality-projection-contract.json`
- `family-incident-learning-loop.json`
- `family-product-operator-projection.json`
- `domain-pack-compiler-contract.json`
- `pack-bundle-contract.json`
- `pack-os-contract.json`
- `generic-substrate-projection-contract.json`
- `foundry-agent-series-contract.json`
- `standard-domain-agent-skeleton-contract.json`
- `functional-privatization-audit-envelope-contract.json`
- `fresh-install-test-matrix.json`
- `native-helper-contract.json`
- `public-surface-index.json`
- `task-topology.json`

## 阅读规则

- 本目录按活跃 OPL framework contract set 读取
- `opl framework locate` / `opl_framework_locator` 是 standalone OPL-compatible agents 找到外部 OPL Framework 依赖环境的稳定入口
- Runtime Manager、family runtime attempt、domain pack compiler、generated interface bundle 与 standard domain-agent skeleton 合同按 provider-backed family runtime / generated-surface 主线活跃依据读取
- domain truth 继续归对应 domain 仓所有，而不是归这个目录所有
- Foundry Agents 应声明并适配这些 framework contracts；不应 vendored / fork 一份 OPL runtime 作为独立真相
- One Person Lab App 按 projection consumer 和工作台 surface 读取；它不是 runtime provider 或 domain authority
