# OPL 品牌模块理想态

Owner: `One Person Lab`
Purpose: `brand_module_ideal_state_index`
State: `support_reference / cordis_rebaseline_landed`
Machine boundary: 本文是人读目标态参考。机器真相继续归核心五件套、contracts、source、CLI/API 行为、runtime ledger、provider receipt、domain-owned manifests、App release/user-path evidence 和真实 workspace evidence。

## 读法

本文把 OPL 理想态拆成一组品牌化模块。它回答四个问题：

- 顶层设计应该分成哪些高内聚、低耦合的部分。
- 每个部分的品牌名、设计理念、核心对象和边界是什么。
- 这些模块如何服务维护、使用、持续开发和后续重构。
- 当前 Framework 十大模块如何对齐 App / Cloud 产品语义，以及它们在 Cordis-native 重基线前如何维持 `src/modules/<module_id>/` 的现有物理组织。

本文不冻结当前完成度、receipt id、worklist 计数、branch、worktree 或 release 证据。当前事实继续回到 `docs/status.md`、`docs/active/current-state-vs-ideal-gap.md` 和 fresh CLI/read-model。

当前品牌系统冻结基线归 `contracts/opl-framework/brand-system-profile.json`。其中历史字段仍保留 Framework / App / Foundry 的责任视角；对外生态认知统一为 `OPL Base + OPL App + OPL Packages + OPL Cloud`。该 contract 只约束当前品牌系统语言和 pattern，不声明十模块是最终 authority/Package/plugin/profile 拓扑，也不声明 L5、domain ready、quality verdict、artifact authority、App release ready 或 production ready。

Cordis 全面迁移已冻结一条更高优先级的目标态约束：`品牌模块/认知地图 != authority owner != Package 发布单元 != Cordis plugin 运行单元`。P5-R 已依据真实 caller、authority、lifecycle、scope、trust、故障隔离和发布节奏形成四层目标图；下表继续作为文档与源码导航基线，不代表一模块一 plugin，也不授权目录对称化 churn。

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
- DeepSeek Harness / Cordis：用 Context、service injection、typed event、effect/disposer 和 scope teardown 组合进程内贡献；Package、Temporal、Workspace、Ledger、Foundry、domain 与 App authority 继续分离。

## 当前十个品牌模块（重基线输入）

| 模块 | 品牌一句话 | 默认 owner |
| --- | --- | --- |
| [OPL Charter](./charter.md) | 顶层宪章、命名、边界、ADR/RFC 和品牌组合治理。 | OPL Framework |
| [OPL Atlas](./atlas.md) | Agent、capability、tool-card、surface、owner、dependency 和 lifecycle catalog。 | OPL Framework |
| [OPL Workspace](./workspace.md) | 用户项目空间、共享素材、stage outputs、handoff 和可检查文件结构。 | OPL Framework + domain workspace owner |
| [OPL Pack](./pack.md) | Declarative Domain Pack、Capability Invocation ABI、authority ABI、execution view、operational card、result envelope、pack compiler、generated/hosted surfaces 和 standard authority functions。 | OPL Framework + Foundry Agent owners |
| [OPL Stagecraft](./stagecraft.md) | Stage 设计、认知计算、capability use policy、tool affordance、quality gate 和 handoff。 | OPL Framework + Foundry Agent |
| [OPL Runway](./runway.md) | Durable execution、stage-attempt request/projection、lease、retry/dead-letter、wakeup 和 human gate。 | OPL Framework |
| [OPL Ledger](./ledger.md) | Evidence、receipt、typed blocker、artifact lineage、restore/provenance 和 refs-only ledger。 | OPL Framework + domain authority owner |
| [OPL Console](./console.md) | App/operator 工作台，消费 execution view、operational card、result envelope、current owner、invocation plan、next action、阻塞、产物和 drilldown。 | One Person Lab App |
| [OPL Foundry Kernel](./foundry-kernel.md) | 消费 OMA 的 blueprint / eval / evolution semantics，负责候选物化、评测、`EvidenceBundle`、版本、canary、activation 和 rollback。 | OPL Framework |
| [OPL Connect](./connect.md) | CLI、MCP、OpenAI/AI SDK tools、execution view / operational card / ToolResultEnvelope descriptor、Skill/plugin、release/install 分发。 | OPL Framework + App release owner |

## 模块关系

下图只是文档导航顺序，不是启动顺序、依赖图或 Cordis composition：

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

`OPL Fabric` 属于正在落地的 Cloud 产品资源底座语义，不新增 Framework 第 11 个源码模块。`Fabric` 由 `Connect`、`Runway`、`Pack`、`Workspace` 和 `Ledger` 协作承接：`Connect` 负责连接、分发和可调用 surface，`Runway` 负责 durable execution / queue / retry-dead-letter，`Pack` 负责 ABI、descriptor 和 generated surface，`Workspace` 负责可检查物理落点，`Ledger` 负责 refs-only evidence / receipt / lineage；`Console` 把这些能力组织成治理、投影、current owner、next action 和 drilldown 页面。具体产品能力以各自的 account、storage、isolation、backend、owner policy 与运行证据为准。

## 当前完成度对照

以 `OPL Workspace` 为基线的现状评估见 [OPL 品牌模块完成度对照](./current-maturity-against-workspace.md)。

品牌系统冻结基线的机器入口：

```text
contracts/opl-framework/brand-system-profile.json
contracts/opl-framework/source-module-map.json
src/modules/
opl contract validate --json
node --experimental-strip-types --test tests/src/cli/cases/brand-modules.test.ts
```

## 代码组织对齐

OPL Framework 的当前物理代码组织以 `src/modules/` 作为品牌模块入口。源码边界、public entrypoint 规则、完成度口径和后续依赖治理读法见 [OPL Framework 源码模块边界](../source-module-boundary.md)。这些目录是当前源码 owner 和迁移导航，不是永久 plugin/package 边界；物理重排必须在新 owner、caller-zero 和 fresh readback 之后进行。每个当前顶层品牌模块都有对应目录：

```text
src/modules/charter
src/modules/atlas
src/modules/workspace
src/modules/pack
src/modules/stagecraft
src/modules/runway
src/modules/ledger
src/modules/console
src/modules/foundry
src/modules/connect
```

App / Cloud 产品语义可以把这些模块组合成面向用户的能力、页面、任务入口或托管产品面；Framework 实现目前仍以这十个目录为源码 owner。`contracts/opl-framework/source-module-map.json` 负责归属校验和历史 root 文件 readback，不替代模块目录，也不是 Cordis registry。`entrypoints/` 和 `kernel/` 是非品牌技术层：`entrypoints/` 负责 CLI / App / Cloud / adapter 启动连接，`kernel/` 负责共享 runtime primitive；它们不拥有品牌模块，不直接接管产品语义。新代码进入当前 owning module，跨模块从 owning module `index.ts` public exports 或 `public/**` 薄入口走；需要总入口时使用 `src/modules/index.ts` 的模块身份常量或命名空间聚合，避免把不同模块的同名 API 压成一个无边界 barrel。后续目录或 registry 调整继续受 P5-R 冻结的 owner、Package、plugin、profile 和 source-to-target mapping 约束。

源码边界的默认门已经切到 public interface：模块内代码保持在同一 owning module 内聚，优先使用相对 import；跨模块使用 owning module public index 或 `public/**` 薄入口。薄入口用于高频、低依赖、容易被多个模块消费的稳定 API，避免大 index eager-load 造成初始化循环。跨模块内部文件 import 不再作为迁移债存在，`npm run source:modules -- --strict-imports` 默认按 strict policy 失败。若一个内部符号确实需要被其他模块消费，先把它加入目标模块 `index.ts` 或 `public/**` 薄入口，再迁移调用方。当前完成口径是“物理归位 + public entrypoint 硬门 + deep import 清零”；public-level 依赖热点和 cycle 收薄作为后续依赖方向治理处理。
