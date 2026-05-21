<div align="center">

# iHow Memory Core

### 检验多 Agent 记忆在交接之后是否真的没断的参考实现脚手架

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Spec: iHow Memory Standard](https://img.shields.io/badge/spec-ihow--memory--standard-brightgreen.svg)](https://github.com/iHow1/ihow-memory-standard)

[English](./README.md) · [规范仓库](https://github.com/iHow1/ihow-memory-standard) · [协议草案](https://github.com/iHow1/ihow-memory-standard/blob/main/spec/protocol-draft-v0.1.md) · [可靠性场景](https://github.com/iHow1/ihow-memory-standard/blob/main/scenarios/reliability-scenarios-v0.1.md)

</div>

iHow Memory Core 是公开 iHow Memory Standard 的实现仓库，提供本地优先工具，用于生成 protocol-shaped events、交接样例和自家 conformance 检查。

规范真相源是 [`iHow1/ihow-memory-standard`](https://github.com/iHow1/ihow-memory-standard)。本仓库负责代码：CLI、本地 adapter 审计日志、安全部署壳和 conformance runner。

## 本仓包含

- `bin/ihow-memory`：本地 CLI 脚手架。
- `tools/ihow-memory/event-log.sh`：append-only 本地审计日志，并映射到 protocol v0.1 Event Object。
- `deploy/yuntian-pilot/`：静态 pilot Console 的安全本地部署壳。
- `conformance/runners/ihow-memory/`：自家五个可靠性场景 runner。

## 快速开始

```bash
npm exec --package . -- ihow-memory init /tmp/ihow-memory-demo --force
```

生成内容：

- `memory/recent/latest.md`
- `memory/_events/<today>.ndjson`
- `memory/scopes/project/sample.md`
- `memory/inbox/`
- `console/index.html`
- `conformance-samples/`

运行自家 conformance：

```bash
npm run test:conformance
```

期望结果：`5/5 PASS`。

## 与规范仓库的关系

`ihow-memory-standard` 定义协议草案和可靠性场景。本仓提供可被这些场景验收的本地实现脚手架。

协议草案定义四个核心接口语义：

- `events`：工作流事件写入
- `context`：最小上下文包读取
- `writeback`：候选长期记忆写回与审核
- `audit`：记忆来源、使用和生命周期追溯

可靠性场景定义五个验收题：

1. Cross-Tool Handoff / 跨工具接力
2. Feedback Pattern Capture / 反馈规律沉淀
3. Constraint Preservation / 禁忌约束执行
4. Human Team Handoff / 新人接手
5. Model Migration / 跨模型迁移

## 本地部署壳

耘田 pilot compose 是部署壳，不是 protocol sidecar API：

```bash
cd deploy/yuntian-pilot
docker compose up -d
open http://127.0.0.1:8787
```

它只提供 localhost-only 静态 Console 和本地文件挂载，不暴露 `/memory/events`、`/memory/context`、`/memory/writeback`、`/memory/pending` 或 `/memory/audit`。

## 安全边界

- 公开 fixture 和 conformance sample 只使用合成数据。
- 不提交非公开项目记忆、客户材料、token、key、credential 或账号数据。
- 客户部署材料默认不进本仓，除非 Commander 明确分类为 public-safe。

## License

Apache-2.0。见 [LICENSE](./LICENSE)。
