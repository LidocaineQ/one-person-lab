# OPL Framework Source Topology

Owner: `OPL Framework`
Purpose: `source_topology_physical_index`
State: `candidate_source_index_pending_canonical_absorption`
Machine boundary: 当前 task branch 已按责任重排 Framework 源码；机器真相归 `contracts/opl-framework/source-module-map.json`、`contracts/opl-framework/package-topology.json`、source boundary scripts、source 和 tests。本文不声明 canonical/main 已吸收、Package 已发布、App/Cloud 已完成或 production ready。

## 读法

维护源码时先区分六个 target roots：

| Layer | Path | Responsibility |
| --- | --- | --- |
| Authority | `src/authority/**` | Framework-owned contracts、workspace/packages/stages/evidence/evolution authority surfaces。 |
| Adapters | `src/adapters/**` | execution 与 integration 的 carrier/provider/executor 外部边界。 |
| Read models | `src/read-models/**` | catalog/discovery 与 operator/product projections。 |
| Host | `src/host/**` | Framework 唯一 Cordis Host、composition profiles、plugin contributions 与 Host projection。 |
| Entrypoints | `src/entrypoints/**` | CLI/App/runtime 的薄接线层，不拥有产品或 domain truth。 |
| Kernel | `src/kernel/**` | brand-neutral shared types、ports 和 runtime primitives。 |

`source-module-map.v3` 将上述路径细分为 13 个 responsibility source units。每个扫描文件必须恰好归属一个 source unit；跨 unit 消费走目标 public entrypoint 或显式 Host injection，不通过品牌 barrel、deep import 或 global singleton。

`src/modules/**` 是 `retired`/`must_be_absent` legacy root，当前分支不存在该目录。它只能出现在历史 provenance 或 negative fixture 中，不得恢复 compatibility source、public barrel 或第二 owner。

## Source Units

| Source unit | Physical root | Primary responsibility |
| --- | --- | --- |
| `framework.authority.contracts` | `src/authority/contracts` | contracts、naming、policy authority。 |
| `framework.authority.workspace` | `src/authority/workspace` | workspace protocol 与 binding authority。 |
| `framework.authority.packages` | `src/authority/packages` | Package descriptor/ABI/compiler authority。 |
| `framework.authority.stages` | `src/authority/stages` | stage context、policy 与 handoff authority。 |
| `framework.authority.evidence` | `src/authority/evidence` | refs-only evidence、receipt 与 provenance authority。 |
| `framework.authority.evolution` | `src/authority/evolution` | Foundry evaluation/version/activation orchestration authority。 |
| `framework.adapters.execution` | `src/adapters/execution` | executor/provider/Temporal transport adapters。 |
| `framework.adapters.integration` | `src/adapters/integration` | connector、carrier、provider/source discovery adapters。 |
| `framework.read-models.catalog` | `src/read-models/catalog` | catalog、capability 与 agent discovery read models。 |
| `framework.read-models.operator` | `src/read-models/operator` | readiness/operator/action projections。 |
| `framework.host` | `src/host` | Host composition、profiles 与 Cordis contributions。 |
| `framework.entrypoints` | `src/entrypoints` | CLI/App/runtime wiring。 |
| `framework.kernel` | `src/kernel` | shared brand-neutral types、ports 与 primitives。 |

品牌域不是上表的物理 owner。`Charter/Atlas/Workspace/Pack/Stagecraft/Runway/Ledger/Console/Foundry/Connect` 继续作为跨 Framework/App/Cloud 的 family capability-domain 导航；其边界不预先决定 authority owner、Package、Cordis contribution 或 source unit 数量。

## Package Boundary

当前分支保留两个独立 workspace Package：

- `@one-person-lab/cordis-abi`
- `@one-person-lab/package-host`

Connect descriptor discovery、Runway executor 和 Foundry evaluation 已内联到 Framework Host；它们的 Cordis descriptor 保留真实 caller、ABI 和 authority boundary，但 `package_ref` 为 `null`，不再形成独立 workspace Package。现有两个 workspace Package 仍只是 source-extracted/candidate packages，不是已发布 Package、独立仓库、installed/current 或 production-ready 证明。正式 publication 仍需真实 consumer、独立发布节奏、currentness/readback、回退证据和 owner gate。

## 维护规则

1. 新源码进入最小 responsibility source unit；不要按品牌名新建平行目录。
2. 同 unit 内使用相对 import；跨 unit 只走 public entrypoint 或显式 Host injection。
3. Host 是唯一 composition authority；authority/adapters/read-models 不反向持有 Host registry 或创建第二 runtime。
4. Package、plugin API/source identity、composition snapshot、authority truth 和 App product profile 分开版本化与回读。
5. 提交前运行 strict source/package boundaries、typecheck/build 和相应 focused tests；candidate pass 不能外推 canonical、release 或 production 完成。
