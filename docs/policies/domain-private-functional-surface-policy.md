# Domain 私有功能面准入政策

本文决定通用能力留在 Framework 还是留在 domain Package。目标是保留专业 authority，同时避免每个 Agent 重复实现 runtime、Workspace、Package 和 operator shell。

## 默认形态

Standard Agent repo 由以下部分组成：

- declarative descriptor、capability map和Stage contracts；
- domain-owned prompt、knowledge、rubric和artifact conventions；
- 最小 authority functions；
- callable entrypoints；
- owner receipt、typed blocker和human gate；
- Framework adapter消费的refs-onlyprojection。

## 必须留在 domain

- 专业事实和语义解释；
- source/data acceptance；
- artifact body的生成与修改；
- quality/export/publication/submission verdict；
- domain memory body；
- owner receipt、typed blocker和human decision；
- 只有该领域理解的算法或validator。

## 应上收到 Framework

多个真实domain共享、且不需要专业判断的：

- Workspace locator和binding；
- StageRun/Attempt transport；
- provider、queue、retry和supervision adapter；
- Package discovery和native carrier adapter；
- refs-only evidence、artifact locator和operator projection；
- session continuity、generic recovery和App bridge。

## 允许的私有 adapter

domain adapter必须薄，只负责把domain entrypoint映射到通用contract，不能继续拥有：

- 第二scheduler/queue；
- 第二session store或attempt ledger；
- 第二Package registry/currentness；
- 第二workspace/artifact lifecycle；
- 通用status/workbench；
- default caller wrapper。

## 判断

1. 是否需要domain知识才能正确实现？
2. 是否写domain truth、artifact body或verdict？
3. 是否已有Framework/platform owner？
4. 是否有两个以上真实consumer？
5. 上收后能否删除重复caller和state？

前两项为是则留在domain；后三项支持通用化时上收最小稳定接口。

## Cutover

先证明Framework successor的真实纵向路径，再切换domain caller；随后同批删除旧writer、reader、state、CLI、fixture、测试和文档。不得保留alias、facade或自动fallback。

## 验证

验证真实caller、owner contract、standalone domain path、hosted path、authority false flags和受影响用户结果。结构通过不等于domain ready或artifact accepted。
