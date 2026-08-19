# Standard Domain Agent 实现规范

本文说明 Standard Agent repo 的最小实现形态，目录细节见 [repo 结构政策](../policies/standard-agent-repo-structure.md)。

## 必需组成

- owner Package/Agent descriptor；
- capability map；
- callable domain entrypoint；
- Workspace locator；
- Stage contracts 与 artifact conventions；
- domain-owned progress、receipt、typed blocker 和 human gate；
- repo-native verify entry；
- 可 standalone 运行的 owner路径。

## 托管适配

Framework adapter 只负责把通用 Workspace/Stage/Attempt envelope送入 owner entrypoint，并把 refs-only结果投影回来。业务逻辑不复制到 Framework。

## 新 Agent

OMA/Foundry 可以生成 blueprint、scaffold 和 eval spec，但 target repo owner决定采用、实现、版本和发布。新 Agent 通过 native carrier installed descriptor 自动进入发现面，不修改 Framework 固定清单。

## 完成边界

schema、scaffold 和测试通过只证明结构可消费。installed/enabled、真实 StageRun、专业产物、owner acceptance 和 publication 必须分别验证。
