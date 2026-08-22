# OPL 关键决策

本文只保留当前仍有效、且不能仅从代码结构直接读出的决策。实施状态属于 [状态](./status.md)，未完成事项属于 [当前差距](./active/current-state-vs-ideal-gap.md)。

## 产品分为 Base、App、Packages 和 Cloud

OPL 采用四层产品模型：

- Base 提供通用 Framework 和 headless 能力；
- App 提供桌面产品与用户体验；
- Packages 提供可安装的专业 Agent 和 capability；
- Cloud 提供远端 workspace、managed resource 和协作。

专业判断和 artifact authority 留在 Package/domain owner，App 和 Cloud 各自持有产品事实。这样可以让通用底座稳定演进，同时避免 Framework 成为所有产品和领域的中央 owner。

## Package 拓扑按真实生命周期晋升

能力默认留在真实调用者所在源码 owner。出现同仓多调用者和稳定 ABI 后可成为 workspace Package；出现跨仓 consumer、独立 owner 或独立 release/security boundary 后可拆独立 repo；只有真实外部 consumer、不同发布节奏或独立回滚需求存在时才建立独立 publication。

拆仓与发布分开判断。该规则避免把单用途模块过早平台化，也避免通用能力被单一 repo 的发布节奏锁住。

## Package 生命周期服从 native carrier

Package identity 由 owner descriptor 持有，物理 installed/enabled/currentness 由 native carrier 持有。Framework 只做配置 carrier 的薄 adapter、presence/callability 和统一 projection。

Framework 不维护普通 Package 的中央版本求解、installed lock、payload lock、LKG、materializer 或 transaction。required dependency 只要求指定 identity 存在且入口可调用。

## Family capability 使用动态 portfolio

Charter、Workspace、Atlas、Pack、Stagecraft、Runway、Ledger、Connect、Console、Foundry 和 Fabric 是跨 OPL Family 的 capability domain 名称，不是固定源码根、Package 数量或 plugin registry。

真实责任由 authority surface、source unit、Package 和 Cordis contribution 分别承担；portfolio 从 contract 读取，不为每个品牌复制一份状态文档。

## Cordis 是共同的进程内 composition runtime，Host 唯一性按 scope 判断

Framework 使用正式 `@deepseek-ai/cordis` 处理 service 注入、typed event、effect 和 teardown。当前受控 profile 是 `base-headless`、`app-full` 和 `foundry-dev`。

Framework Host 在 `framework_runtime_package_graph_and_app_projection` 范围内唯一。
`opl-studio` 可以运行独立的 DSH/Cordis Application Host，范围仅为
`dsh_profile_plugin_lifecycle_codex_and_delivery_transport_composition`。两者通过
App state/action、authentication 和 channel callback 公开合同连接，不共享 registry、
currentness、session 或内部 service graph。

不建立自研平行 composition 内核，也不让 Studio Host 成为第二套 OPL runtime、Package
registry/currentness、App state/action、domain、product 或 release authority。Cordis 不接管
Temporal history、Workspace 数据、evidence authority、domain verdict 或 App product truth。

## Temporal 承担 durable execution，不承担专业判断

Temporal service 和 worker 承担 workflow history、retry、task queue 和 durable execution。Framework 将其投影为 Stage/Attempt、repair route 和 operator state。

workflow 完成只能证明 transport/runtime 结果可读取。是否接受产物、是否进入下一 Stage、是否可发布，仍由 domain owner 和 human gate 决定。

## Codex carrier 随安装载体归属

Base/headless 安装必须自包含可用的 Codex executable carrier；App 使用其 shell 或 product owner 选择的 exact carrier。两者是互斥部署角色，不是同时生效的双 authority。

稳定边界是 `OPL_CODEX_BIN + codex app-server --stdio`。Framework 不解析 App 私有 carrier manifest，App 也不通过 Framework fallback 猜测 executable。

## 文档直接收敛，不保留当前树内的历史兼容面

核心文档按产品、状态、架构、约束、决策分工；`docs/active` 只有一个 gap owner。完成记录、迁移计划、兼容说明、日期型审计和旧方案从当前树删除，追溯依赖 Git。

当模块、接口、测试或命令已经没有 caller，文档与相应保护测试一起退役。不得为了说明历史而保留可被误读为当前支持面的 alias、redirect 或 tombstone。
