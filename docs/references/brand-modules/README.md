# OPL 品牌模块理想态

Owner: `One Person Lab`
Purpose: `brand_module_ideal_state_index`
State: `support_reference / family_capability_rebaseline_frozen / physical_cutover_active`
Machine boundary: 本文是人读目标态参考。机器真相继续归核心五件套、contracts、source、CLI/API 行为、runtime ledger、provider receipt、domain-owned manifests、App release/user-path evidence 和真实 workspace evidence。

## 读法

本文把 OPL 理想态拆成一组跨产品 family capability domains。它回答四个问题：

- 顶层设计应该分成哪些高内聚、低耦合的部分。
- 每个部分的品牌名、设计理念、核心对象和边界是什么。
- 这些模块如何服务维护、使用、持续开发和后续重构。
- 原 Framework 十品牌如何跨 Framework/App/Cloud 分配 authority、Package 和 Host/Client Cordis contributions，以及旧 `src/modules/<module_id>/` 如何 successor-first 迁到责任导向的物理组织。

本文不冻结当前完成度、receipt id、worklist 计数、branch、worktree 或 release 证据。当前事实继续回到 `docs/status.md`、`docs/active/current-state-vs-ideal-gap.md` 和 fresh CLI/read-model。

当前品牌系统冻结基线归 `contracts/opl-framework/brand-system-profile.json`。其中历史字段仍保留 Framework / App / Foundry 的责任视角；对外生态认知统一为 `OPL Base + OPL App + OPL Packages + OPL Cloud`。该 contract 只约束当前品牌系统语言和 pattern，不声明十模块是最终 authority/Package/plugin/profile 拓扑，也不声明 L5、domain ready、quality verdict、artifact authority、App release ready 或 production ready。

Cordis 全面迁移已冻结一条更高优先级的目标态约束：`family capability domain != authority surface != Package 发布单元 != Cordis contribution != composition profile`。P5-R 已依据真实 caller、authority、lifecycle、scope、trust、故障隔离和发布节奏形成五层目标图；下表是跨仓品牌/认知导航，不代表一 domain 一目录、一 Package或一 plugin。

### 产品层、权威层与运行层

品牌名是认知地图，不是仓库清单。当前生态对外仍只暴露 `OPL Base`、`OPL App`、
`OPL Packages` 和 `OPL Cloud`；内部按以下关系理解：

```text
OPL Framework = 唯一 Cordis Host / runtime authority
OPL Packages = 各 owner 独立发布的安装与能力单元；可贡献零个或多个 runtime/GUI contributions
one-person-lab-app = App 产品、Client profile、GUI ABI、发布 authority
opl-aion-shell = 当前 Stable AionUI Shell implementation carrier
opl-studio = DSH-derived 下一代候选 Shell implementation carrier
OPL Cloud = Console / Control Plane / Fabric / Ledger / Workspace 产品实现
```

GUI 是 Host/Client 双运行面：Framework 先冻结 Host composition，再通过 App-owned
contribution projection 供 Shell 创建 Client Cordis、挂载 typed slots/routes/actions。
AionUI 可用薄 bridge 承接，Studio 可原生采用 DSH 形态；二者都不能建立第二个 OPL
Host、Package registry、thread/history 或产品 release authority。

因此，十大品牌模块继续作为认知与源码导航，不强行一对一变成十个 Package 或十个
plugin；后续按 authority、独立 lifecycle、scope/trust、故障隔离和真实发布节奏决定
拆分/合并。Console 品牌跨产品复用时，Framework 的 Console 贡献只负责 read-model /
inspect projection，Cloud 的 OPL Console 负责账号、治理、额度、批准和 Cloud 服务，
两者不共享 authority。

## 外部经验吸收

OPL 借鉴的是成熟工程的分层原则；Cordis 是已授权采用的进程内组合 runtime，但仍不得成为第二真相源：

- Kubernetes Operator pattern：用声明式对象、status 和 control loop 管理长生命周期系统。
- Temporal durable execution：把 workflow history、task queue、timer、恢复、重试和 timeout 交给 durable substrate；worker process/service lifecycle 仍归 OPL Runway 和部署 substrate，业务判断留给 owner。
- Backstage Software Catalog：用 catalog 维护 owner、metadata、entity graph 和 discoverability。
- DDD bounded context：每个上下文有自己的语言、owner 和边界，跨上下文只走显式接口。
- Dagster software-defined assets：把产物、lineage、materialization 和观测状态作为一等资产。
- OpenAPI / MCP：外部调用面从机器可读描述派生，prose 不做接口真相。
- ADR：关键架构决策要留下原因、取舍和 supersession 关系。
- DeepSeek Harness / Cordis Host：用 Context、service injection、typed event、effect/disposer 和 scope teardown 组合 Host 进程内贡献；Package、Temporal、Workspace、Ledger、Foundry、domain 与 App/Cloud authority继续分离。
- DeepSeek Harness GUI：Host选择并投影 allowlisted client graph，Browser从投影创建 Client Cordis，GUI通过 typed slots、RPC和 events组合；不是“Node Cordis直接渲染React”，也不授权 Client独立发现、安装或拥有 currentness/product truth。

## 十个 family capability domains（稳定认知地图）

| Domain | 品牌一句话 | Authority 分布 |
| --- | --- | --- |
| [OPL Charter](./charter.md) | 顶层宪章、命名、边界、ADR/RFC 和品牌组合治理。 | OPL family policy owner；Framework承载合同。 |
| [OPL Atlas](./atlas.md) | Agent、capability、tool-card、surface、owner、dependency 和 lifecycle catalog。 | Framework catalog/discovery；App/Cloud消费产品投影。 |
| [OPL Workspace](./workspace.md) | 用户项目空间、共享素材、stage outputs、handoff 和可检查文件结构。 | OPL Framework + domain workspace owner |
| [OPL Pack](./pack.md) | Declarative Domain Pack、Capability Invocation ABI、authority ABI、execution view、operational card、result envelope、pack compiler、generated/hosted surfaces 和 standard authority functions。 | OPL Framework + Foundry Agent owners |
| [OPL Stagecraft](./stagecraft.md) | Stage 设计、认知计算、capability use policy、tool affordance、quality gate 和 handoff。 | OPL Framework + Foundry Agent |
| [OPL Runway](./runway.md) | Durable execution、stage-attempt request/projection、lease、retry/dead-letter、wakeup 和 human gate。 | OPL Framework |
| [OPL Ledger](./ledger.md) | Evidence、receipt、typed blocker、artifact lineage、restore/provenance 和 refs-only ledger。 | OPL Framework + domain authority owner |
| [OPL Console](./console.md) | 托管/本地 control plane与 operator工作面，消费 current owner、next action、阻塞、产物和 drilldown。 | Cloud持有托管 Console产品；App持有本地 product/page/action；Framework只持有 read-model/projection。 |
| [OPL Foundry Kernel](./foundry-kernel.md) | 消费 OMA 的 blueprint / eval / evolution semantics，负责候选物化、评测、`EvidenceBundle`、版本、canary、activation 和 rollback。 | OPL Framework |
| [OPL Connect](./connect.md) | CLI、MCP、OpenAI/AI SDK tools、execution view / operational card / ToolResultEnvelope descriptor、Skill/plugin、release/install 分发。 | OPL Framework + App release owner |

## Domain 关系

下图只是品牌文档导航顺序，不是启动顺序、依赖图、源码 topology、Package graph或 Cordis composition：

```text
OPL Charter
  -> OPL Atlas
  -> OPL Workspace
  -> OPL Pack
  -> OPL Stagecraft
  -> OPL Runway
  -> OPL Ledger
  -> OPL Console
  -> OPL Foundry Kernel
  -> OPL Connect
```

更具体地说：

- `Charter` 冻结语言、设计原则、ADR/RFC 和品牌组合边界。
- `Atlas` 是可发现目录和 tool-card catalog，不执行、不签 receipt、不拥有 domain truth。
- `Workspace` 是用户和 Agent 共同检查文件的默认落点。
- `Pack` 固定 domain pack、Capability Invocation ABI、authority ABI、execution view、operational card、result envelope、pack compiler 和 generated-surface 输入，不接管 domain handler 或 owner verdict。
- `Stagecraft` 是 stage 内认知工作设计和 capability use policy，不承担 durable runtime。
- `Runway` 只负责把 stage attempt 跑起来、恢复和收口，不创建 domain verdict。
- `Ledger` 只保存 refs、receipt、blocker、lineage 和 provenance，不保存 memory/artifact body。
- `Console` 只消费 projection、invocation plan、execution view、operational card 和 result envelope，不读取 MAS 原始合同细节，也不成为第二 runtime 或第二 domain truth。
- `Foundry Kernel` 调用 OMA `engineer-agent` 获取设计与演进语义，并持有候选物化、评测执行、`EvidenceBundle`、版本、canary、activation 与 rollback；它不接管 target owner 持有的保护测试正文、最终验收、权限授权、生产采用或 domain authority。
- `Connect` 只把同一合同派生为不同外部调用面的 descriptors，不导出 MAS 原始合同细节，不重新解释语义或把 tool result envelope 写成 authority outcome。

Agent Tool Arsenal / Capability Invocation OS 不新增品牌模块。它以 `OPL Pack` 为 ABI owner；合同是生成/校验材料，Agent ordinary path 只消费 Pack 派生的 execution view、operational card 和 result envelope。`Atlas`、`Stagecraft`、`Console`、`Connect` 分别消费 catalog、use-policy、current-owner projection / ordinary execution view 和 descriptor/export 边界；`Runway` / `Ledger` 只承运执行与 refs evidence。

`OPL Fabric` 属于正在落地的 Cloud / Product 层资源底座语义，不新增 Framework 第 11 个源码单元。它由 `Connect`、`Runway`、`Pack`、`Workspace` 和 `Ledger` 协作承接，并由 Cloud authority surface 组合成用户可见能力；具体可用性以真实 account、storage、isolation、backend、owner policy 与运行证据为准。Cloud Console 组织托管治理与 drilldown，App Console 组织本地产品工作面，Framework 只提供所需 projection。

## Host / Client 与产品 authority

Framework 是唯一 Host composition authority：Host 根据 `base-headless`、`app-full`、`foundry-dev` 等受控 profile 选择并冻结 Host graph，再把带 version/source identity 的 allowlisted client graph 投影给 App。App renderer可以创建 Host 派生的 Client Cordis Context；AionUI主线与 DSH GUI候选必须共享：

- 同一 Host-projected client graph 和 composition snapshot；
- 同一 Client Contribution descriptor、typed slot/action ABI 与 App product profile；
- 同一 RPC/event transport 与 no-second-registry/no-independent-install guard。

Client 只能消费 projection，不能独立发现/安装 plugin、拥有 Package currentness、签发 release-operation、改写 App/Cloud/domain truth 或把 renderer fallback 当成 ready。`OPL App` 是产品 owner，不是普通 Cordis plugin；AionUI/DSH 只是可替换 renderer/carrier。Console 同样按 authority 分层：Cloud control-plane、App 本地产品工作面、Framework readiness/operator projection。

## 当前完成度对照

以 `OPL Workspace` 为基线的现状评估见 [OPL 品牌模块完成度对照](./current-maturity-against-workspace.md)。

品牌系统冻结基线的机器入口：

```text
contracts/opl-framework/brand-system-profile.json
contracts/opl-framework/source-module-map.json
contracts/opl-framework/package-topology.json
src/authority/、src/adapters/、src/read-models/、src/host/、src/entrypoints/、src/kernel/（当前责任拓扑）
src/modules/（retired / must be absent；仅历史 provenance 或 negative fixture）
opl contract validate --json
node --experimental-strip-types --test tests/src/cli/cases/brand-modules.test.ts
```

## 代码组织对齐

OPL Framework 的历史物理代码组织曾以 `src/modules/` 作为品牌导航入口；当前源码已按责任重排为 13 个 source units / 6 个 target roots，`src/modules/**` 已退休并要求 absent。源码边界、public entrypoint 规则、完成度口径和后续依赖治理读法见 [OPL Framework 源码模块边界](../source-module-boundary.md)。下列只是品牌域与常见责任单元的导航映射，不代表十个 source owners、Package 或 plugin：

```text
src/authority/contracts
src/read-models/catalog
src/authority/workspace
src/authority/packages
src/authority/stages
src/adapters/execution
src/authority/evidence
src/read-models/operator
src/authority/evolution
src/adapters/integration
```

App / Cloud 产品语义可以跨多个 domain/authority/Package 组合面向用户；Framework实现不再以十个目录作为终局 owner。`source-module-map.v3` 管理 13 个 source units 与 retired root，`package-topology.v2` 管理 Package/source/plugin 关联；二者都不是 Cordis registry。真实 caller 已切换且旧 root 已删除；不以目录移动、零引用扫描或 docs alone 声明独立发布、runtime 或 production 完成。

源码边界的默认门仍是 public interface，但入口归 authority/adapter/read-model/host source-unit exports、薄 entrypoints 与 brand-neutral kernel。source-unit 恰好一次归属、deep import、forbidden dependency、cycle 和 legacy-root absence必须保持通过；不得恢复 `src/modules/**` compatibility export或永久双入口。当前源码满足物理 cutover 的结构门；独立 Package publication、runtime、release 和 production 仍须对应 owner readback。

## Package 发布边界

品牌域不预先决定 Package 数量。当前已建立五个独立 workspace Package：`@one-person-lab/cordis-abi`、`@one-person-lab/package-host`、`@one-person-lab/connect-discovery`、`@one-person-lab/runway-executor` 和 `@one-person-lab/foundry-evaluation`。它们只是 source-extracted/candidate packages，尚未证明独立发布、安装、currentness、回退或独立仓库完成。正式拆分仍要求独立安装/发布/升级节奏、真实 consumer、currentness/readback 和回退价值；Package identity、plugin API/source identity、composition snapshot 和 App product profile 分开回读。
