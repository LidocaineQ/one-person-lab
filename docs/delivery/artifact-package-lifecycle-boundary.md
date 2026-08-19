# Artifact 与 Package Delivery 边界

本文解释 artifact body、Package publication和Framework refs transport的owner分工。

## Artifact

domain owner创建和修改artifact body，并决定quality、canonical、export和delivery状态。Framework可以保存locator、hash、lineage、receipt ref、retention和restore proof。

```text
domain output
  -> owner manifest / receipt
  -> runtime artifact root
  -> Framework refs/index
  -> App/operator projection
```

文件存在、hash匹配或projection可见都不等于owner accepted。

## Stage artifact

一个Stage Attempt的artifact unit至少绑定：

- StageRun/Attempt identity；
- inputs/outputs；
- artifact manifest；
- evidence和receipt refs；
- content integrity；
- current/canonical/export owner decision。

Framework可以验证结构、投影和恢复；只有domain owner能promotion或accept。

## Package

Package owner持有descriptor、runtime bytes、version和publication。native carrier持有安装/启停/currentness。Framework只下载/验证/hand off owner bytes或调用carrier，并聚合installed/callable。

shared release set或offline bundle可以组合多个Package，但不是普通Package currentness owner。

## Publication

独立publication只在真实外部consumer、不同release cadence或独立rollback需求存在时建立。source repo、workspace Package和published artifact是不同层。

publication完成至少需要owner workflow、immutable ref/digest、可见性和consumer readback。本地build、task branch或Framework catalog不能替代。

## App

App展示artifact和Package state，发起受控action，并持有App release truth。App不读取domain artifact body来推断quality，也不建立第二Package carrier。

## Safety

- path、symlink、scope、hash和authorization不满足时fail closed；
- destructive cleanup需要owner receipt和restore/retention policy；
- repair只修改当前owner的index或transport；
- publication、submission和external mutation单独授权。

## 验证

分别验证artifact integrity、owner receipt、Package publication、native carrier installed、effective entrypoint和App user path。任一层通过都不能外推其他层。
