# OPL Framework 源码模块边界

本文是维护 `contracts/opl-framework/source-module-map.json` 的操作参考。contract 是 source unit、root 和 dependency policy 的唯一 machine owner。

## 当前 roots

| Root | 职责 |
| --- | --- |
| `src/authority` | canonical contracts、Workspace、Package 等规则 |
| `src/adapters` | native carrier、provider、execution 和 external integration |
| `src/read-models` | App/operator 的只读 projection |
| `src/host` | Cordis composition 与 Host service lifecycle |
| `src/entrypoints` | CLI/API 装配和 dispatch |
| `src/kernel` | 少量跨层稳定类型与 brand-neutral primitives |

每个文件归属于一个主要 source unit。capability domain、品牌、Package 和 Cordis contribution 不决定物理目录。

## Import 规则

1. unit 外调用优先使用目标 unit 的 public entrypoint。
2. 允许直接依赖明确登记的 Host plugin leaf，不允许无合同 deep import。
3. entrypoint 只装配，不持有业务状态。
4. adapter 实现外部协议，不拥有对应事实。
5. read model 只能投影，不写 authority。
6. kernel 只接收真正跨多个 unit 的稳定 primitive，不接收为了消除一条 import 而下沉的业务逻辑。

## 何时拆 unit

只有同时出现独立职责、多个真实 caller 和稳定依赖边界时才拆 source unit。文件过长、品牌名称、未来复用或目录对称本身不构成拆分理由。

若能力需要独立安装、跨仓 ownership 或独立发布，按 [Package 拓扑](../project.md#package-拓扑) 决定 workspace Package、独立 repo 与 publication；不要通过新增 source root 模拟 Package。

## 变更步骤

1. 用 CodeGraph 或 TypeScript import graph确认 definitions 和 caller。
2. 确定唯一新 owner 与公开 entrypoint。
3. 切换真实 caller。
4. 同批删除旧 barrel、facade、schema、fixture 和仅保护旧接口的测试。
5. 更新 `source-module-map.json`。
6. 运行：

```bash
./bin/opl source modules --strict-imports --strict-cycles --json
npm run typecheck
npm run test:structure
```

通过只证明源码边界，不证明 runtime、installed、release 或 domain readiness。
