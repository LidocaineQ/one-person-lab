# OPL App GUI Boundary

GUI product truth 位于 `one-person-lab-app`。Framework 只维护：

- `contracts/opl-framework/app-runtime-state-contract.json` 及相关 App contract；
- `app-full` Host composition；
- Client contribution projection；
- `opl app state|action` consumer surface。

Framework 文档不维护 shell 候选、页面清单、截图、release 状态或 UI 计划。验证 GUI 时必须读取 App canonical source、installed build 和真实 user path。
