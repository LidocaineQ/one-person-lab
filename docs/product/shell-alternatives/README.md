# OPL App Shell Alternatives

Owner: `one-person-lab-app`
Purpose: `shell_alternative_product_docs_index`
State: `active_support`
Machine boundary: Human-readable foreground-alternative product planning and
startup-flow specs. Machine-readable candidate state, adapter contracts,
first-run gates, package manifests, smoke evidence, and release gates stay in
`contracts/`, source, validation scripts, shell artifacts, and release evidence.

This directory points to current foreground-alternative GUI planning owned by
the clean `one-person-lab-app` product repo. AionUI remains the active release
shell unless App-owned active-shell contracts and release gates explicitly
change.

Hermes Desktop / `hermes-codex` 已退休；其仓库与历史文档仅保留为 read-only
provenance，不再是候选、replay、验证或维护入口。重新打开 Hermes 必须先有新的
One Person Lab App 产品决策。

## Current Foreground Alternative

- `opl-studio`: DSH-derived foreground alternative GUI candidate. Its current
  product and compatibility truth lives in `one-person-lab-app` contracts.

历史 Hermes 文档路径不再作为当前索引链接；仍可从 Git 历史和归档仓库读取。

Shell-independent GUI product definitions live in
[`../gui/`](../gui/). Archived AGUI replay material lives in
`one-person-lab-app/docs/history/shell-candidates/`.
