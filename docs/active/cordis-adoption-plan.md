# Cordis Adoption Plan

Owner: `OPL Framework`
Purpose: `cordis_adoption_support_plan`
State: `roadmap_complete / full_migration_authorized_p4_landed_p5a_active_p5b_p6_not_started`
Updated: `2026-08-14`
SSOT role: 本文是详细支撑计划；当前 active gap、优先级和下一棒仍只归 [`current-state-vs-ideal-gap.md`](./current-state-vs-ideal-gap.md)。
Machine boundary: 用户已明确授权把长期终态推进到 Cordis 全面迁移；本文的阶段状态仍只由 canonical source、contracts、tests 和 owner-authoritative readback 证明。P4/P5/P6 尚未完成时，不得把计划、候选分支或 focused test 写成默认/production 已 Cordis-native。Package currentness、Temporal、Foundry、Ledger、domain 和 App 的事实必须分别回到对应 owner surface。

## 1. 结论

OPL 采用 DeepSeek Harness（DSH）所使用的正式 `@deepseek-ai/cordis` 作为长期目标的进程内组合框架。目标是最终使用 Cordis 本身，不再另造 `Cordis-like` 内核、平行 event bus、平行 service registry 或平行 plugin lifecycle。

这是一项已经完成 P0-P3、正在按用户授权推进 P4-P6 的架构迁移，不再以迁移成本作为 go/no-go。P1 surface map、P2 `Agent Executor` 隔离实验与 P3 只读 composition inspect 已落地；P4 现在进入实现，P5/P6 负责十模块 caller 切换和默认路径切换。当前 OPL 默认生产链仍按既有手写 runtime 运行，直到 P6 的真实 readback 闭合。首个实验选择 `Agent Executor` seam，因为 Codex、Claude Code、Hermes 和 Antigravity 已经有多个显式 adapter，且该 seam 已在不改变 Temporal durable truth 的情况下证明真实 Cordis 组合、依赖注入、事件、scope isolation 和 teardown。

Cordis 的职责只限于同一进程内的：

- Context、service 注册与依赖注入；
- typed event 分发；
- reversible effect、disposer、mount/unmount、开发期 reload；
- 由一组明确的 plugin 组成当前 process/session/attempt composition。

Cordis 不取代 OPL 已经冻结的权威边界：Package 安装与 currentness、Temporal durable orchestration、Workspace 文件与绑定、Ledger evidence/receipt、Foundry version/promotion/activation、domain truth/quality verdict、App product truth 和 executor 的真实进程能力仍由各自 owner 持有。

## 2. 上游基线与来源策略

以下是 2026-08-14 的公开观察，只用于 provenance，不把外部网页或 `latest` 当作 OPL runtime truth：

| 对象 | 当前观察 | 采用规则 |
| --- | --- | --- |
| DSH | [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)，默认分支 `master`，根版本 `0.1.0-rc.5` | DSH 是首要参考架构和首要兼容目标；升级按 DSH source commit 审核。 |
| DSH source | `master` 观察提交 `47f943859bef60e4160492346772ded9b24f765a` | 任何实验或发布记录 source commit；分支漂移不能证明相同源码。 |
| DSH Cordis | `vendor/cordis`，包名 `@deepseek-ai/cordis`，观察版本 `4.0.1` | OPL 优先跟随 DSH scoped distribution；依赖使用 exact version 和 lockfile integrity。 |
| 独立 Cordis | [`cordiverse/cordis`](https://github.com/cordiverse/cordis)，npm `cordis@4.0.0-rc.8` | 只作 API/概念参考；不得与 DSH scoped 包同时进入同一 production composition。 |

Source/version policy:

1. P2 及以后只允许实际安装 `@deepseek-ai/cordis`，禁止用 OPL 自写替代内核或以未锁定的 upstream `cordis` 代替。
2. 每次候选升级同时记录 `dsh_source_commit`、`cordis_package_version`、lockfile integrity、Node/pnpm 运行时和验证结果；四者缺一不得称为可重放 composition。
3. 不使用 `^`、`~`、`latest` 或运行时网络解析；升级是显式 source/lock 变更，失败时回到上一份 immutable build/artifact 并重启进程。
4. 若 DSH scoped 包与 upstream 包 API 分叉，DSH scoped 包优先；只有 DSH 明确迁移回 upstream 且 OPL 通过同一套兼容矩阵后，才可重新评估来源。禁止“双包兼容层”成为长期路径。
5. DSH 的文档、示例和插件命名可作为学习材料，但 OPL 的 owner、权限、domain authority 和产品语义仍由本仓合同与对应 owner 决定。

## 3. 目标架构

### 3.1 五种身份必须分开

| 身份 | 代表什么 | owner | 不代表什么 |
| --- | --- | --- | --- |
| Brand module | 源码 owner / bounded context（十个 OPL 品牌模块） | OPL Framework 模块 owner | 不是进程实例、安装单元或版本 resolver。 |
| Package | 安装、发布、分发和 carrier 生命周期单元 | Package owner / native carrier | 不是 Cordis service registry，也不是 executor route。 |
| Cordis plugin | 进程内 service、event、effect 和 lifecycle 贡献 | 所属模块或 Package owner | 不是独立安装单元，不签 domain truth，不提供安全沙箱。 |
| Composition snapshot | 某个 process/session/attempt 选中的不可变 plugin 组合 | Pack/Runway 组合输入 owner | 不是 installed lock、全局 currentness 或第二 registry。 |
| Executor route | 实际可调用的 Codex/Claude/Hermes/Antigravity 进程适配 | Runway/executor adapter owner | 不是 Package identity，也不改变 Temporal durability。 |

因此，模块可以发布多个 plugin，多个 Package 可以贡献同一受控 plugin surface，某个纯合同或纯领域 owner 也可以不强行变成 plugin。是否拆成 plugin 必须由真实的进程内替换、依赖或 teardown 需求支付成本。

### 3.2 目标组合链路

```text
OPL entrypoint
  -> trusted Cordis root context
     -> module plugins (Charter/Atlas/Pack/Stagecraft/Connect/...)
        -> session/attempt child context
           -> executor plugin (Codex CLI or explicit adapter)
              -> existing OPL request/receipt boundary
                 -> Temporal / Workspace / Ledger / domain owner
```

Cordis 只负责箭头中 `context -> plugin -> in-process service/event` 的部分。`Temporal / Workspace / Ledger / domain owner` 的 durable 或语义权威不能被 Context 内存对象替代。

### 3.3 十个品牌模块的候选贡献

| 模块 | 候选 Cordis 贡献 | 必须继续留在模块/外部 owner 的权威 |
| --- | --- | --- |
| `OPL Charter` | policy/config service、命名与 forbidden-claim 事件 | ADR、术语、owner split 和产品决策。 |
| `OPL Atlas` | capability/agent/catalog read service、typed discovery events | catalog source、identity 和 owner metadata。 |
| `OPL Workspace` | locator、binding 和 lifecycle adapter | workspace registry、文件 bytes、恢复/删除语义。 |
| `OPL Pack` | descriptor/ABI/compiler service、capability contribution | Package descriptor source、ABI、安装/分发 owner。 |
| `OPL Stagecraft` | stage context、prompt/skill/tool-affordance policy service | stage 语义、Codex route judgment、domain quality policy。 |
| `OPL Runway` | executor/attempt transport service、request/result events | Temporal workflow history、retry、signal、worker durability。 |
| `OPL Ledger` | refs-only evidence observer、receipt emission adapter | evidence/receipt persistence、lineage 和不可变审计事实。 |
| `OPL Console` | read-only inspect/projection service | App GUI/product truth、用户 action authority。 |
| `OPL Foundry Kernel` | design/eval/activation adapter、candidate events | AgentVersion、qualification、canary、activation CAS、rollback authority。 |
| `OPL Connect` | carrier/provider/plugin loader adapter、source discovery events | native carrier installed truth、Package currentness、credential boundary。 |

这张表已由 P1 surface map 与真实 caller 证据支付第一轮收益门。P5 将按依赖图逐模块实现 successor 并切换 caller；只有真实安全、权限、数据完整性或 owner authority 边界可以阻止具体写入，迁移成本本身不再阻止已确认的模块。

### 3.4 Authority mapping

| 关注点 | Cordis 处理 | OPL/外部 owner 处理 |
| --- | --- | --- |
| 启动顺序 | `inject` 声明依赖并等待 service ready | Pack/contract 决定 required/optional 语义；缺 required provider 的 composition fail closed。 |
| 进程通信 | typed `emit` / `waterfall` / `parallel` / `serial` | 事件 schema 和事件 owner；durable history 由 Temporal/Ledger 保存。 |
| 注册/注销 | `effect()`、`on()` 返回 disposer，按 scope teardown | 文件、数据库、外部服务的实际生命周期仍由 native owner 负责。 |
| 配置 | 只读加载 composition/config，支持显式 overlay | 用户设置、Package 选择、domain config 的 canonical bytes 由原 owner 写入。 |
| 版本组合 | 启动时校验 plugin API/required service compatibility | Package 发布/currentness、Foundry version/promotion 和 source commit 由各 owner 决定。 |
| 失败隔离 | required plugin 失败停止该 composition；optional plugin 形成 diagnostic/degraded state | 不得把 optional 缺失升级成 domain verdict；不可逆动作仍由 owner gate 控制。 |
| reload/HMR | 仅 dev/实验 scope，可撤销重挂载 | production attempt composition 冻结，不能热换 prompt、executor、receipt 或 durable workflow。 |

## 4. 不变量与运行规则

### 4.1 Scope

- `process` scope 只装 trusted core/first-party plugin，持有无用户语义的共享 service。
- `session` scope 只承载该 session 的可替换 projection/adapter；结束时完整 teardown。
- `attempt` scope 在启动前冻结 composition snapshot、executor binding、prompt/policy refs 和 input identity；运行中禁止 hot swap。
- `dev` scope 可以启用 HMR/reload，但只能作用于实验/开发进程，不能写入 managed runtime 或 durable truth。
- 不可信第三方代码不得因“是 plugin”而进入 privileged root；需要隔离时使用现有 sandbox/provider 或独立进程，Cordis 本身不是安全边界。

### 4.2 Config、event 与 effect

- composition 文件由 OPL contract/Pack 生成或显式选择；App starter/profile 不能反向成为 Framework plugin registry。
- plugin 通过 `inject` 声明依赖，禁止手写全局启动序列和隐式 singleton import。
- 每个公开事件必须声明 namespace、payload schema、分发 mode 和 owner；`waterfall` 只用于明确的环绕决策，观察者不得偷改结果。
- 每个注册、监听器、timer、child process、临时目录和外部连接都必须有 disposer；teardown 失败必须进入 diagnostic，不能伪造成功。
- Cordis event 是进程内 transport；需要重放、跨进程恢复或审计的事实必须先写入既有 Temporal/Ledger/owner receipt surface。

### 4.3 Version、branch 与组合

- 模块源仓、Package 和 plugin 可独立发布、分支和升级；组合时只消费显式的 plugin descriptor 与 compatibility contract。
- 不建立中央 SemVer resolver。缺依赖、API 不兼容、trust 不匹配和 scope 不允许时返回 typed composition diagnostic，由 owner 决定是否调整组合。
- `composition snapshot` 是一次执行的输入证明，允许记录 exact plugin/package/source refs；它不可用于推导 installed/current、自动更新或回滚状态。
- 同一 snapshot 必须能在相同 carrier/runtime 条件下重放；snapshot 与实际 hydrated bytes 不一致时 fail closed，不猜测或静默换代。

### 4.4 No second truth / no second lifecycle

禁止新增或恢复以下平行面：OPL 自有 plugin marketplace、全局 plugin registry、Cordis 专用 installed lock、Cordis payload cache、Cordis rollback state machine、第二个 durable event log、Package currentness cache、App 私有 plugin truth、或由 Cordis 直接签发 domain/quality/ready verdict。原有同类手写代码只有在 successor 真实可用、caller 已切换、affected outcome 通过且结构 caller=0 后才批量退役。

## 5. 分阶段落地计划

每个阶段都有独立 owner、精确写集和可回退点。阶段之间可以准备并行，但共享 `main`、安装、生效和默认切换只由一个 Integrator 在短临界区执行。

### P0：冻结 SSOT 与决策边界（本轮）

| 项目 | 内容 |
| --- | --- |
| Owner | `OPL Charter` + Framework 架构 owner |
| 写集 | `docs/decisions.md`、`docs/architecture.md`、`docs/status.md`、`docs/active/README.md`、本计划、`docs/active/current-state-vs-ideal-gap.md` |
| 输入 | 用户决定、DSH/Cordis source observation、十模块与既有 Package/Temporal/Foundry/Ledger contracts。 |
| 产物 | 正式决策、目标架构、分阶段计划、当前状态和唯一 active gap baton。 |
| 验证 | Markdown link/merge-marker/diff 检查；逐句核对“planned ≠ installed/running”。 |
| 完成门 | 所有文档指向同一计划；未新增运行时依赖；没有把外部观察写成 OPL 现状。 |
| 回退 | 只回退本轮文档提交，不触碰运行时、Package 或外部系统。 |

### P1：Surface Map 与最小 seam 盘点

| 项目 | 内容 |
| --- | --- |
| Owner | `OPL Charter` 统筹；`Atlas`、`Pack`、`Runway`、`Connect` 和各模块 owner 提供事实。 |
| 状态 | `landed`：十模块 machine-readable surface map、schema 与 focused test 已落地；所有模块面仍是 candidate，未批准 production cutover。 |
| 写集 | 候选 `contracts/opl-framework/cordis-surface-map.json`、模块 public index、相关 source/tests 的最小补充；不得先改生产调用者。 |
| 输入 | `source-module-map.json`、实际 caller/consumer、现有 service/handler/event、Package descriptor、Temporal/Foundry/Ledger contracts。 |
| 产物 | 每个候选 plugin 的 `owner/module`、provides、injects、events、scope、trust lane、required/optional、真实 caller、替代面和禁止接管的 authority 清单。 |
| 验证 | `npm run source:modules -- --strict-imports --strict-cycles`、`./scripts/verify.sh`、结构 caller 追踪和 focused typecheck。 |
| 完成门 | 每个 seam 有真实 caller 和收益；无 seam 通过手工启动顺序、隐式 registry 或第二 lifecycle 解释；无法支付成本的模块明确保留现状。 |
| 回退 | 删除 map/候选描述，不改变既有 runtime 行为。 |

### P2：真实 Cordis Agent Executor 实验

| 项目 | 内容 |
| --- | --- |
| Owner | `OPL Runway`（executor/attempt transport）+ `OPL Connect`（dependency/source）；独立实验 branch/worktree。 |
| 状态 | `landed_experiment_only`：真实 Cordis root context、required adapter/service、optional observer、request `emit`、completion `parallel`、scope isolation 与 teardown 已通过 focused fixture；默认 caller 未切换。 |
| 写集 | root dependency manifest/lock、`src/modules/runway/` 的实验 adapter、必要的 `src/modules/connect/` loader bridge、fixture 与 focused tests；不得切换默认启动入口。 |
| 输入 | P1 的 executor seam、现有 Codex/Claude/Hermes/Antigravity adapter、`example-domain` fixture、`@deepseek-ai/cordis` exact package/source lock。 |
| 产物 | 一个真实 Cordis root context；`executor` service plugin；至少一个 explicit executor adapter plugin；typed request/result events；完整 disposer/teardown；对现有 executor contract 的薄包装。 |
| 验证 | missing injected service 保持 pending；required/optional plugin 行为；本 seam 实际使用的 request `emit` 与 completion `parallel` 语义；register/unregister；context scope 隔离；Codex fixture call；相同 request/output/receipt readback；`npm run typecheck`、`npm run build`、`./scripts/verify.sh` 和 focused tests。 |
| 完成门 | 真实 `@deepseek-ai/cordis` 纵向链路可运行且可销毁；生产 executor、Temporal history、Package installed truth 和 Ledger authority 不变；实验可通过移除 composition 完整回退。 |
| 回退 | 恢复上一份 immutable build/lock，删除实验 adapter；不保留自动 legacy fallback 或永久双写。 |

### P3：Composition Inspect 与可观测边界

| 项目 | 内容 |
| --- | --- |
| Owner | `OPL Atlas` + `OPL Console`；`Ledger` 只提供 refs-only observation。 |
| 状态 | `landed_read_only_experiment`；P2 最小 composition snapshot/readback 与 P3 deterministic inspect 已通过 focused、schema、CLI、无写入、unknown-plugin 降级和 teardown 验证；结果仍只属于隔离实验探针，不是默认生产 readback。 |
| 依赖 | P2 focused readback、P1 surface map、现有 Console/Atlas read-only projection owner。 |
| 写集 | 只读 `opl cordis inspect --json`（或等价现有 inspect surface）、composition projection、schema/test；不新增 registry writer。 |
| 输入 | P2 实际 context、plugin descriptor、composition snapshot、scope/trust/event metadata。 |
| 产物 | 可回读 plugin id/version/source、provides/injects、state、scope、trust lane、event names/modes、disposer status 和 diagnostic refs。 |
| 验证 | deterministic JSON、无外部写入、无 domain/ready 字段升级、未知 plugin 安全降级、重启后不把 projection 当成 currentness。 |
| 完成门 | operator 能解释“当前进程加载了什么”，但 inspect 不成为第二 truth、安装入口或 semantic route controller。 |
| 回退 | 移除 inspect projection，保留 P2 运行链路或回退实验。 |

### P4：Package/Plugin 版本与组合合同

| 项目 | 内容 |
| --- | --- |
| Owner | `OPL Pack`（descriptor/ABI）+ `OPL Connect`（carrier）+ `OPL Foundry Kernel`（candidate/version evidence）。 |
| 状态 | `landed`；Pack-owned plugin descriptor、composition snapshot、typed diagnostics 与 P2/P3 consumers 已进入 canonical main。 |
| 依赖 | P3 inspect 的实际字段、P2 snapshot identity、Package descriptor 与 Foundry AgentVersion owner contract。 |
| 写集 | `contracts/opl-framework/cordis-plugin-descriptor.schema.json`、`cordis-composition-snapshot.schema.json`、compatibility validator、fixture matrix；不创建中央 resolver/installed lock。 |
| 输入 | P2/P3 真实 plugin、Package descriptor、Foundry AgentVersion、executor binding、现有 release/receipt contracts。 |
| 产物 | 独立 plugin API version、provides/injects contract、required/optional/trust/scope policy、Package-to-plugin projection、exact composition snapshot 和 incompatible diagnostic shape。 |
| 验证 | 两个独立模块分支/版本可按显式 snapshot 组合；缺 provider、不兼容 API、trust/scope 冲突均可预测失败；同 snapshot 重放得到同一 plugin/source identity；不会触发 Package 安装或 Foundry promotion。 |
| 完成门 | 版本自由组合成立，但没有中央版本求解、隐式网络下载或永久兼容层；snapshot 只作为 execution input/evidence。 |
| 回退 | 回到上一份 descriptor/compatibility contract，删除未被真实 caller 使用的新字段。 |

### P5：按依赖图分批迁移十模块

状态：`p5a_active`。P4 contract 已通过；第一条 successor 是 Pack stage-binding + Stagecraft context，并切换 Runway 的 5 个真实 callback caller。Connect、Workspace/Ledger、Atlas/Console 和 Foundry/Charter 的 adapter 可并行准备，但 canonical caller switch 仍逐批串行。

迁移采用 successor-first：先在 Cordis composition 中证明一个模块的真实 vertical path，再切 production caller，最后以 structural caller=0、affected outcome 和 build/readback 为门批量退役旧手写路径。建议顺序如下，实际顺序以 P1 graph 为准：

1. `Atlas` / `Console` 的只读 discovery/inspect service；不触碰 App/domain truth。
2. `Pack` / `Stagecraft` 的 descriptor、stage context、capability policy contribution；不触碰 semantic route judgment。
3. `Connect` 的 carrier/plugin loader adapter；不接管 native installed truth、credential 或 Package lifecycle。
4. `Runway` 的 executor/attempt transport；Temporal 继续是唯一 durable substrate，旧 workflow caller 先切后删。
5. `Workspace` / `Ledger` 的 locator、refs-only observer 和 projection adapter；文件 bytes、receipt persistence 和 restore authority不迁入 Cordis。
6. `Foundry Kernel` / `Charter` 的 policy/eval/activation adapter；AgentVersion、canary、activation CAS 和决策权仍由 Foundry owner 持有。

每批必须提交：caller inventory、successor path、fixture/real readback、no-forbidden-write proof、切换点、结构 caller=0 证据和 canonical revert/immutable artifact 回退点。禁止长期 dual-write、自动旧路径 fallback 或把“plugin 已加载”写成 module L5/production ready。

### P6：默认路径切换与持续运营

| 项目 | 内容 |
| --- | --- |
| Owner | Framework Integrator；App、Package owner、Foundry、Temporal、Ledger 和 domain owner 共同验收各自边界。 |
| 状态 | `not_started`；P1-P5 全部通过前不得进入默认路径切换。 |
| 前置 | P1-P5 gates 全部通过；默认入口已有 Cordis composition snapshot；生产/开发 profile 明确；没有 active caller 仍指向被替代的通用内核。 |
| 切换 | 先切 `OPL Base`/headless 的受控 profile，再切 App/托管入口；每个 attempt 启动时冻结 snapshot；不在运行中热换。 |
| 验证 | clean install/managed readback、Codex-default session、Temporal restart/replay、Workspace/receipt refs、App projection、executor failure/teardown、source-module strict gates 和跨模块 focused/aggregate tests。 |
| 完成门 | 默认进程确实由 Cordis 组合；inspect/readback 与实际 bytes 一致；Package/Temporal/Foundry/Ledger/domain/App owner 仍能独立回读；没有第二 registry/lifecycle；回退可由上一 immutable build/restart 完成。 |
| 回退 | canonical Git revert 或上一 immutable artifact；停止新 composition profile，不在运行时保留永久兼容分支。 |

### 持续项：DSH 上游跟踪

每次 DSH/Cordis 发布或 DSH `master` 结构变更触发一次轻量审计：读取 DSH source commit、scoped package manifest、API/export diff、peer dependency、license、Node/pnpm 约束和 P2/P3 compatibility suite。只有 suite 与 owner review 通过才更新 lock；上游未验证的 breaking change 保持在实验分支，不阻断当前 production path。

### 执行依赖图与并发边界

| 路径 | 依赖 | 可并行范围 | 集成规则 |
| --- | --- | --- | --- |
| `P0 -> P1 -> P2 -> P3 -> P4` | 严格串行；后阶段只能消费前阶段已回读的 source/contract/snapshot。 | 每阶段内部的 caller inventory、fixture、只读审计和测试准备可以并行。 | 共享 `main`、SSOT、依赖安装和 canonical push 由一个 Integrator 串行吸收。 |
| `P5` 模块批次 | 先通过 P4；每一批还要满足自身 dependency edge、真实 caller、successor 和 owner acceptance。 | 依赖边不相交的模块批次可以并行开发；`Atlas/Console`、`Pack/Stagecraft`、`Connect`、`Workspace/Ledger`、`Foundry/Charter` 不得因“十模块”名义强行同时迁移。 | 各 owner 在独立 worktree checkpoint；caller switch、旧路径退役和 canonical readback 逐批串行。 |
| `P6` 默认切换 | 依赖全部 P5 批次、跨 owner readback 和回退演练。 | 只能并行准备 Base/App/owner acceptance，不能并行写默认入口。 | 先 Base/headless，再 App/托管入口；每次只切一个受控 profile。 |
| DSH 上游跟踪 | 与 P1-P6 正常开发平行，但不改变当前 production path。 | source/API/license/compatibility audit 可独立执行。 | 未通过 suite 的上游版本只留实验分支，不更新 production lock。 |

## 6. 预期收益、代价与 go/no-go

Cordis 的收益不是“代码看起来像插件”，而是把已经存在的替换点、依赖关系和生命周期变成可验证的进程内组合边界。每项收益都必须由真实 caller、readback 或 affected outcome 支付；无法支付的模块不迁移。

| 阶段 | 预期收益 | 可验证证据 | 主要代价/风险 |
| --- | --- | --- | --- |
| P1 | 找到真正值得插件化的 seam，避免十模块整齐但无收益的拆分。 | 每个候选都有真实 export/caller、provides/injects、scope/trust 和 forbidden authority；无 caller 的候选留在现状。 | 盘点成本；surface map 可能被误用成 registry。 |
| P2 | 用正式 DSH Cordis 验证“替换 executor 不改 durable/receipt owner”，并获得可复用的依赖注入、事件和 teardown 基线。 | fixture request/receipt、required pending、optional observer、`emit`/`parallel`、composition isolation、disposer readback 全部通过。 | 引入上游版本漂移和 Cordis 学习成本；因此只进 dev/experimental graph。 |
| P3 | operator 能回答“当前进程实际加载了什么”，缩短组合错误和资源泄漏诊断时间。 | deterministic inspect JSON 与实际 snapshot/bytes 一致；无 writer、无 ready/domain 字段。 | 形成第二 truth 的风险；只读 projection 且不落 installed/current。 |
| P4 | 让 plugin API、版本、trust、scope 和组合输入可独立演进，为分支/版本自由组合提供边界。 | 显式 snapshot 可重放；缺 provider、API mismatch、trust/scope conflict 均 typed fail。 | 组合矩阵膨胀；不建中央 resolver，只测试被声明的组合。 |
| P5 | 模块可独立优化、替换和补齐，旧手写启动顺序按批次退役，降低跨模块改动半径。 | 每批 successor vertical path、caller switch、affected outcome、structural caller=0 和回退点闭合。 | 迁移期 caller/生命周期风险；禁止永久 dual-write/fallback。 |
| P6 | 默认运行获得稳定的组合边界、可观测性和可回退 profile，为 Harness 自进化提供可评估的 composition substrate。 | clean install、默认入口、Temporal restart/replay、owner readback、App projection 和上一 immutable build 回退全部通过。 | 最大 blast radius；任何一个 owner boundary 未闭合都不切默认。 |

### 收益优先级

1. **强收益（当前已证明）**：P1 的 seam 可见性；P2 的 executor 替换、依赖注入、typed event、scope teardown 与 composition isolation。
2. **值得推进**：P3 的 inspect 可观测性；P4 的显式 plugin contract 与可重放 snapshot。
3. **目标收益（已授权，待实现）**：P5/P6 的独立模块版本/分支组合、自由组合、较小改动半径和 Harness 自进化 substrate。它们必须以生产 caller 切换与 owner readback 闭合为终态证据，不能从 P2 demo 提前宣称。

### Go/no-go 规则

- **Go P3**：P2 的 snapshot、实际 bytes、teardown 和 owner boundary 均可回读；P3 只读写集已冻结。
- **Go P4**：P3 inspect 不产生第二 truth，且至少有两个真实 plugin contract 字段消费者；否则继续收敛 P3。
- **Go P5 单模块批次**：该模块有真实 caller、successor 纵向链路、affected outcome、canonical revert 和必要 owner acceptance；这些是正确性/权限门，不以实现成本否决迁移。
- **Go P6**：全部 production caller 已切换、旧路径 structural caller=0、Temporal/Package/Ledger/Foundry/domain/App owner 独立回读 green；否则保持旧默认路径。
- **No-go 任一阶段**：需要新增第二 registry、installed lock、durable event log、Cordis sandbox、永久 fallback，或把 optional plugin/inspect 结果升级为 domain/ready authority。

## 7. 统一验收矩阵

以下是从实验到默认切换必须逐项有证据的门槛：

| 门 | 必须证明 | 不足以证明 |
| --- | --- | --- |
| Source identity | scoped package exact version、DSH source commit、integrity、runtime version | npm `latest`、网页版本、单一 semver。 |
| Composition | provides/injects、scope、trust、required/optional 和 event mode 可解析 | plugin 文件存在、目录命名、静态 registry 行。 |
| Lifecycle | mount、effect/disposer、teardown、reload（仅 dev）可重复 | 进程退出时资源自然消失、单次 demo 输出。 |
| Executor | 真实 Codex fixture 通过既有 request/receipt boundary，失败不污染 durable truth | mock provider、provider completion、CLI help。 |
| Durability | Temporal history/retry/replay 仍由 Temporal，attempt snapshot 可重放 | Cordis event log、内存对象、Console projection。 |
| Package | native carrier fresh installed/callable readback 未被改变 | plugin loaded、descriptor、cache、App metadata。 |
| Authority | domain/Foundry/Ledger/App owner readback unchanged and independently authoritative | `cordis inspect`、contract pass、focused test、generated surface。 |
| Retirement | production caller 切换、structural caller=0、affected outcome/build/readback pass | 零引用扫描、候选分支、docs 或测试通过。 |

## 8. 变更控制与回退

- P2 之前不得把 Cordis 依赖写入默认 production dependency graph；P2 之后也只能留在 dev/experimental graph，直到 P6 完成。
- 每个 phase 使用独立 branch/worktree 和 lifecycle receipt；共享文档、`main`、安装和默认切换由单一 Integrator 串行吸收。
- 任何 composition 变更都先生成新的 immutable snapshot；不原地修改运行中的 attempt，也不重写历史 snapshot。
- 回退只使用 canonical Git revert、上一份 immutable artifact 或重启到上一 composition；不新建 Cordis 私有 rollback state machine。
- 实验失败只关闭当前 composition/profile；不得删除仍有 caller 的手写路径，不得以“未来会迁移”授权物理删除。

## 9. 下一棒

P0-P6 路线图已完整冻结，P1 surface map、P2 隔离 executor experiment、P3 composition inspect 与 P4 plugin/package version contract 已串行吸收；P5-A 已登记并进入实现，P5 其余批次继续按依赖图准备，canonical 吸收仍固定 `P4 -> P5 -> P6`。当前下一棒是完成 P5-A 的 Pack/Stagecraft successor，并在 fresh main 上切换 Runway 五个真实 caller。实际 active 优先级、owner、write set 和状态继续以 [`current-state-vs-ideal-gap.md`](./current-state-vs-ideal-gap.md) 为准，本计划只作为支撑细节被引用。

## 10. 禁止声明

在 P6 完成并有 owner-authoritative readback 前，不得声明 OPL 已采用 Cordis、已 Cordis-native、已插件化、已支持自由组合、已拥有独立模块版本/分支组合、已兼容 DSH 生态或已达到 Harness 自进化能力。P1-P3 只证明候选 surface、隔离 executor composition 与只读组合可观测性；它们不表示 Cordis 默认运行、Package 发布、Temporal/Foundry/Ledger/domain/App readiness 或生产发布完成。

## 11. 本仓验证入口

Docs-only：

```bash
rtk git diff --check
rtk rg -n '^(<<<<<<<|=======|>>>>>>>)' docs
```

触及 source/contract/runtime 后按阶段执行：

```bash
rtk ./scripts/verify.sh
rtk npm run typecheck
rtk npm run build
rtk npm run source:modules -- --strict-imports --strict-cycles
```

P2 已提供 fixture execution、teardown/disposer、composition snapshot 和实验 readback；P3 还必须提供 Cordis inspect JSON 与 owner readback。没有相应阶段证据，只能保持 `planned` 或 `experimental`。
