# GUI Shell Adapter 边界

本文解释 Framework、App 和 shell implementation 的责任分工。当前 active shell、候选、页面和 release 由 `one-person-lab-app` contract决定，不在 Framework 文档中冻结。

## Framework

- 提供 `opl app state --profile fast|full --json`；
- 提供 `opl app action`；
- 提供 `app-full` Host profile和Client contribution contract；
- 维护 runtime、Package、Workspace、evidence和Settings的machine surface。

## App

- 持有产品信息架构、交互、active shell policy和renderer contract；
- 选择并集成具体 shell；
- 持有打包、签名、updater、release和用户教程；
- 验证 installed build和真实 user path。

## Shell implementation

- 渲染 App-owned contract；
- 通过薄 adapter调用 Framework/App bridge；
- 维护 upstream intake和shell-local build；
- 不定义第二 Package catalog、runtime currentness、domain truth或release verdict。

## 切换 shell

切换只应影响 App adapter、shell源码、packaging和UI测试。Framework runtime和domain Package不随shell重写。

完成切换必须验证 contract parity、packaged runtime、accessibility、启动/恢复、Settings和至少一条真实Package user path。候选源码或截图不能替代 App owner adoption decision。
