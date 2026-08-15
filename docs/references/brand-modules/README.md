# OPL 家族品牌能力组合

Owner: `One Person Lab`
Purpose: `family_capability_brand_portfolio_reference`
State: `support_reference / dynamic_portfolio_active / physical_cutover_landed`
Machine boundary: 本文是人读目标态参考。机器真相继续归核心五件套、contracts、source、CLI/API 行为、runtime ledger、provider receipt、domain-owned manifests、App release/user-path evidence 和真实 workspace evidence。

## 读法

本文把 OPL 理想态拆成一组跨产品 family capability domains。它回答四个问题：

- 顶层设计应该分成哪些高内聚、低耦合的部分。
- 每个部分的品牌名、设计理念、核心对象和边界是什么。
- 这些模块如何服务维护、使用、持续开发和后续重构。
- 当前家族品牌如何跨 Framework/App/Cloud 分配 authority、Package 和 Host/Client Cordis contributions，以及旧 `src/modules/<module_id>/` 如何 successor-first 迁到责任导向的物理组织。

本文不冻结当前完成度、receipt id、worklist 计数、branch、worktree 或 release 证据。当前事实继续回到 `docs/status.md`、`docs/active/current-state-vs-ideal-gap.md` 和 fresh CLI/read-model。

家族品牌组合的唯一机器 SSOT 是 `contracts/opl-framework/family-capability-domain-registry.json`。`brand-system-profile.json` 继续约束视觉和产品语言 pattern，`brand-module-registry.json` 只投影 Framework CLI / L4 / L5 surfaces；二者都不再定义一份平行品牌清单。对外生态认知统一为 `OPL Base + OPL App + OPL Packages + OPL Cloud`。这些 contracts 不声明 L5、domain ready、quality verdict、artifact authority、App release ready 或 production ready。

Cordis 全面迁移冻结的结构约束仍是 `family capability domain != authority surface != Package 发布单元 != Cordis contribution != composition profile`。区别在于品牌层不再被历史数量冻结：品牌组合直接反映当前真实 capability domains，并在相应 authority/caller 合并、拆分或新增时同步调整。下表是唯一组合的人读投影，不代表一 domain 一目录、一 Package 或一 plugin。

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

因此，品牌展示与实际 capability portfolio 只有一份真相：当前 11 个品牌按四段用户旅程组织，
Framework 只投影自己真实拥有 surface 的 10 个；以后不以“维持十大”作为合并、拆分或命名依据。
Console 品牌跨产品复用时，Framework 的 Console 贡献只负责 read-model / inspect projection，
Cloud 的 OPL Console 负责账号、治理、额度、批准和 Cloud 服务，两者不共享 authority。

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

## 当前品牌组合与命名判断

| 旅程 | 品牌 | 一句话承诺 | 命名判断 | Authority 分布 |
| --- | --- | --- | --- | --- |
| Foundation | [OPL Charter](./charter.md) | 定规则、守边界。 | 保留：短、独特，准确表达宪章而非执行。 | OPL family policy owner；Framework 承载合同。 |
| Foundation | [OPL Workspace](./workspace.md) | 让每项工作有正确位置。 | 保留：虽通用，但最易理解且已有跨端产品认知。 | Framework、文件 carrier、Cloud Workspace owner。 |
| Build | [OPL Atlas](./atlas.md) | 找到所有可用能力。 | 保留：发现隐喻强，与 Connect 的外部接通职责不同。 | Framework catalog/discovery；App/Cloud 消费投影。 |
| Build | [OPL Pack](./pack.md) | 把能力变成可描述、可安装单元。 | 保留：简短，直接对应 Package/ABI 责任。 | Framework + Package / Foundry Agent owners。 |
| Build | [OPL Stagecraft](./stagecraft.md) | 设计一次专业工作的阶段与上下文。 | 保留：辨识度最高，且不暗示拥有领域判断。 | Framework + Foundry Agent。 |
| Run | [OPL Runway](./runway.md) | 让工作启动、持续、恢复和收口。 | 保留：执行隐喻清楚，与 Stagecraft、Ledger 分工明确。 | Framework executor/attempt owners。 |
| Run | [OPL Ledger](./ledger.md) | 留下可追溯的证据与事件。 | 保留：天然表达可核验记录，不冒充 artifact body。 | Framework + domain evidence owners。 |
| Run | [OPL Connect](./connect.md) | 接通外部来源、carrier 与生态。 | 保留：动作性强；不与只读发现的 Atlas 合并。 | Framework + App release / provider owners。 |
| Operate | [OPL Console](./console.md) | 看清状态并采取行动。 | 保留：虽通用，但 App、Cloud、Framework 已有真实分层 surface。 | Cloud 托管产品；App 本地产品；Framework projection。 |
| Operate | [OPL Foundry](./foundry.md) | 用证据锻造更好的 Agent。 | 简化：品牌去掉 `Kernel`；Kernel 只保留为内部实现角色。 | Framework evolution / activation owners。 |
| Operate | **OPL Fabric** | 供给并治理托管资源。 | 保留：基础设施隐喻鲜明，且已有独立 Cloud authority/lifecycle。 | OPL Cloud Fabric owner。 |

## Domain 关系

下图是产品展示分组，不是启动顺序、依赖图、源码 topology、Package graph 或 Cordis composition：

```text
Foundation -> OPL Charter / OPL Workspace
Build      -> OPL Atlas / OPL Pack / OPL Stagecraft
Run        -> OPL Runway / OPL Ledger / OPL Connect
Operate    -> OPL Console / OPL Foundry / OPL Fabric
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
- `Foundry` 是对外品牌；其内部 Kernel 调用 OMA `engineer-agent` 获取设计与演进语义，并持有候选物化、评测执行、`EvidenceBundle`、版本、canary、activation 与 rollback；它不接管 target owner 持有的保护测试正文、最终验收、权限授权、生产采用或 domain authority。
- `Connect` 只把同一合同派生为不同外部调用面的 descriptors，不导出 MAS 原始合同细节，不重新解释语义或把 tool result envelope 写成 authority outcome。
- `Fabric` 只由 Cloud authority 供给、操作和回读托管资源，不因为进入家族品牌组合而成为 Framework Host service。

Agent Tool Arsenal / Capability Invocation OS 不新增品牌模块。它以 `OPL Pack` 为 ABI owner；合同是生成/校验材料，Agent ordinary path 只消费 Pack 派生的 execution view、operational card 和 result envelope。`Atlas`、`Stagecraft`、`Console`、`Connect` 分别消费 catalog、use-policy、current-owner projection / ordinary execution view 和 descriptor/export 边界；`Runway` / `Ledger` 只承运执行与 refs evidence。

`OPL Fabric` 已进入家族品牌组合，因为 Cloud 已存在独立资源 authority、provider operation store 和 resource readback；它不进入 Framework surface projection，也不新增 Framework 源码单元。具体可用性仍以真实 account、storage、isolation、backend、owner policy 与运行证据为准。

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
contracts/opl-framework/family-capability-domain-registry.json
contracts/opl-framework/brand-module-registry.json（Framework surface projection）
contracts/opl-framework/source-module-map.json
contracts/opl-framework/package-topology.json
src/authority/、src/adapters/、src/read-models/、src/host/、src/entrypoints/、src/kernel/（当前责任拓扑）
src/modules/（retired / must be absent；仅历史 provenance 或 negative fixture）
opl contract validate --json
node --experimental-strip-types --test tests/src/cli/cases/brand-modules.test.ts
```

## 代码组织对齐

OPL Framework 的历史物理代码组织曾以 `src/modules/` 作为品牌导航入口；当前源码已按责任重排为 13 个 source units / 6 个 target roots，`src/modules/**` 已退休并要求 absent。源码边界、public entrypoint 规则、完成度口径和后续依赖治理读法见 [OPL Framework 源码模块边界](../source-module-boundary.md)。下列只是 Framework projection 与常见责任单元的导航映射，不代表家族品牌数量、Package 或 plugin：

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

App / Cloud 产品语义可以跨多个 domain/authority/Package 组合面向用户；Framework 实现不再以品牌目录作为终局 owner。`source-module-map.v3` 管理 13 个 source units 与 retired root，`package-topology.v2` 管理 Package/source/plugin 关联；二者都不是 Cordis registry。真实 caller 已切换且旧 root 已删除；不以目录移动、零引用扫描或 docs alone 声明独立发布、runtime 或 production 完成。

源码边界的默认门仍是 public interface，但入口归 authority/adapter/read-model/host source-unit exports、薄 entrypoints 与 brand-neutral kernel。source-unit 恰好一次归属、deep import、forbidden dependency、cycle 和 legacy-root absence必须保持通过；不得恢复 `src/modules/**` compatibility export或永久双入口。当前源码满足物理 cutover 的结构门；独立 Package publication、runtime、release 和 production 仍须对应 owner readback。

## Package 发布边界

品牌域不预先决定 Package 数量。当前已建立五个独立 workspace Package：`@one-person-lab/cordis-abi`、`@one-person-lab/package-host`、`@one-person-lab/connect-discovery`、`@one-person-lab/runway-executor` 和 `@one-person-lab/foundry-evaluation`。它们只是 source-extracted/candidate packages，尚未证明独立发布、安装、currentness、回退或独立仓库完成。正式拆分仍要求独立安装/发布/升级节奏、真实 consumer、currentness/readback 和回退价值；Package identity、plugin API/source identity、composition snapshot 和 App product profile 分开回读。
