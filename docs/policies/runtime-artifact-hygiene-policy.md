# Workspace 与 Artifact Hygiene 政策

源码 checkout 只承载可审查、可版本化、可重放的 source。运行状态、cache、真实workspace和交付artifact必须进入各自外部owner路径。

## 路径职责

| 位置 | 内容 |
| --- | --- |
| repo checkout | source、contracts、tests、docs和小型deterministic fixtures |
| system temp | build、cache、pycache和测试中间态 |
| user state | 本机配置、session、log和operator state |
| workspace root | 真实输入、work in progress和任务上下文 |
| runtime artifact root | Attempt输出、receipt实例、交付物和restore proof |

repo只能保存locator、schema、index、policy和fixture，不能保存用户/项目runtime body。

## 验证环境

- Python bytecode、pytest cache、venv和egg-info写到repo外；
- Node/npm cache、compile cache和build temp写到repo外；
- 测试子进程继承同一temp/state配置；
- provider和helper未显式指定state时使用用户级OPL state，不使用cwd隐藏目录；
- 验证结束后 `git status` 不出现生成物。

`scripts/run-with-repo-temp-env.sh` 是本仓默认隔离入口；其他repo提供等价clean runner。

## Workspace

workspace path是locator，不是Work Item或StageRun identity。删除、归档、恢复和迁移必须由workspace owner policy、scope和receipt证明。

## Artifact

真实artifact body、owner receipt实例和交付物位于runtime artifact root。repo中只保留contract、locator和deterministic fixture。

不可逆删除、external publication和owner acceptance必须显式授权。Framework只维护其own index/refs，不能清理domain artifact body。

## Hygiene repair

发现污染时先修producer的输出路径，再清理生成物。`.gitignore` 只做兜底，不能把错误runtime root合法化。

需要长期保留的输出应提升为受管workspace/artifact，并登记locator、lineage和retention，而不是commit到source repo。
