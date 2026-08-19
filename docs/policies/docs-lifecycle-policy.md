# 文档生命周期政策

本文是 OPL 文档生命周期的唯一政策 owner。

## 一份文档，一个职责

每份文档必须能用一句话说明唯一职责。若标题需要同时包含“状态、计划、历史、审计、决策”中的多个角色，说明内容必须拆回各自 owner。

- 产品定位 -> `docs/project.md`
- 当前实现与证据边界 -> `docs/status.md`
- 静态结构与 owner -> `docs/architecture.md`
- 不可破坏规则 -> `docs/invariants.md`
- 当前有效选择 -> `docs/decisions.md`
- 尚未完成的 gap -> `docs/active/current-state-vs-ideal-gap.md`
- 稳定治理规则 -> `docs/policies/`
- 人读接口合同 -> `docs/specs/`
- 运行时边界 -> `docs/runtime/`
- 非权威维护说明 -> `docs/references/`

## 生命周期

1. **创建**：只有现有 owner 无法清楚承载一个长期独立职责时才新建文档。
2. **维护**：修改语义时更新唯一 owner；其他文档只链接，不复制正文。
3. **收敛**：发现重复时，把仍有效内容合入 owner，随后删除重复文档。
4. **完成**：active gap 完成后直接删除条目；active 文档没有完成区。
5. **退役**：模块、接口、命令、测试或方案退役后，对应文档和链接一起删除。
6. **追溯**：历史使用 Git commit、blame、tag、release artifact；当前树不保留兼容页、redirect、tombstone 或日期型快照。

## 禁止的内容形态

- 按日期持续追加的决策、完成记录或审计流水；
- 固定运行计数、version、receipt、workflow run、branch 或 worktree；
- 同时描述 current、target、migration 和 history 的大而全文件；
- 已完成 plan 继续放在 `active/`；
- 用旧接口名称解释“它已经退役”；
- 为每个品牌、Package 或 Agent 复制同一套状态和成熟度模板；
- 用 Markdown 关键词、标题、段落或行数作为语义测试。

## 机器检查边界

允许机器检查：

- Markdown 相对链接和资源存在；
- front matter、schema、JSON 和 generated artifact 完整性；
- 可执行命令示例；
- secrets、权限和不可逆动作边界；
- source/generated provenance。

机器不得通过固定措辞、关键词、章节、文件数量或文本快照决定产品语义、架构、状态、优先级或完成度。语义由当前 owner 基于 contracts、源码、caller 和真实 readback 判断。

## 修改文档时

1. 先确认主题 owner 和当前代码事实。
2. 对相关段落分类为 current truth、active gap、support detail 或 stale。
3. 把 current truth 留在唯一 owner；active gap 只进入唯一 gap 文档；独特 support detail 放入明确专题。
4. 删除 stale、重复、历史和兼容叙事。
5. 更新所有链接和 machine ref。
6. 运行链接、结构和受影响 contract/test 验证。

文档变更不能单独证明 runtime、installed、release、domain 或 product readiness。
