# iHow Memory

> 给异构 AI coding agents 用的本地共享记忆运行时——一份 git 可审的 Markdown 记忆，供它们共享并安全交接。

[![npm version](https://img.shields.io/npm/v/ihow-memory.svg)](https://www.npmjs.com/package/ihow-memory)
[![CI](https://github.com/iHow1/ihow-memory-core/actions/workflows/ci.yml/badge.svg)](https://github.com/iHow1/ihow-memory-core/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](./LICENSE)

[English](./README.md)

> 本文是英文版 README 的翻译。单一信源为英文版；若中英文有出入，以 [英文版](./README.md) 为准。

**要求：Node.js >= 22.12 · macOS / Linux（alpha）。** 无账号、无 API key、无第三方运行时依赖。

iHow Memory 是给异构 AI coding agents 用的本地共享记忆运行时——让 Claude Code、Codex、Cursor 以及其他 MCP 客户端共享同一份人可读、git 可审的长期记忆，并能安全交接。记忆本体是磁盘上的纯 Markdown，你可以用 git 阅读、diff、回滚；写入前有一道检查会拒绝看起来含密钥的候选，每次 promote 都是一个审计事件；交接（handoff）是下一个 agent 会读到的一份候选——当前状态、证据、阻塞、下一步。Agent 通过 stdio MCP server 接入；你在 CLI 里用的是同一套流程。

## 为什么不同

1. **天生跨厂商。** 同一份记忆，供 Claude Code、Codex、Cursor、腾讯 WorkBuddy、Claude Desktop、OpenCode 与 Hermes 共享——跨厂商，在你自己的机器上，每个一条命令接入。大平台都有理由把记忆锁在各自生态里；iHow 是它们之间那层中立的本地记忆。
2. **安全写入 + 交接。** 多个 agent 共享同一份记忆，写入由 workspace 锁串行化，彼此不会互相覆盖。写入前有一道检查会拒绝看起来含密钥（token、key、凭据）的候选，每次 promote 都是一个审计事件。交接（handoff）是下一个 agent 会读到的一份候选——当前状态、证据、阻塞、下一步——而不只是一条检索命中。
3. **人可读，且归你所有。** 记忆是纯 Markdown，你可以用 git 阅读、diff、回滚——不锁厂商、无向量黑盒、无账号、默认无遥测。治理流程（候选 → 审阅 → promote）在团队需要时随时可用，而不是被强制的步骤。

## 快速开始

### 1. 接入 runtime

```bash
npx ihow-memory connect --runtime claude-code   # 或：codex | cursor | workbuddy | claude-desktop | opencode | hermes
```

`connect` 会在 `~/.ihow-memory` 下创建受管 workspace（space 名默认由当前目录推导，也可用 `--space` 指定），并把 `ihow-memory` MCP server 注册到所选 runtime：

- Claude Code 与 Codex 通过各自官方 CLI 配置（`claude mcp add-json`、`codex mcp add`）。
- Cursor 通过合并 `~/.cursor/mcp.json` 配置，写入前先做带时间戳的备份；无法解析的配置文件绝不覆盖。
- 想先预览、不做任何改动，加 `--dry-run`：

```bash
npx ihow-memory connect --runtime claude-code --dry-run
```

如果你更想手工编辑 runtime 配置，可用 `npx ihow-memory init --runtime <runtime>` 打印（而不是直接写入）对应的 MCP 配置片段。

### 2. 验证

```bash
npx ihow-memory doctor --runtime claude-code
```

`doctor` 检查 Node 版本、`node:sqlite` 可用性、memory root 可写性、runtime 配置、检索引擎就绪状态与索引 manifest，并确认 cloud/sync 处于禁用状态。

### 3. 60 秒治理闭环

下面就是 agent 在 MCP 上用的同一套流程，在 shell 里跑一遍。整段可直接复制：

```bash
npx ihow-memory init --space demo
CAND=$(npx ihow-memory write-candidate "Decision: ship weekly release notes." --space demo | sed -n 's/.*"path": "\([^"]*\)".*/\1/p')
PROMOTED=$(npx ihow-memory promote "$CAND" --scope team --title "Release notes cadence" --space demo | sed -n 's/.*"path": "\([^"]*\)".*/\1/p')
npx ihow-memory search "release notes" --space demo
npx ihow-memory read "$PROMOTED" --space demo
```

你应该看到：

- `write-candidate` 返回 `memory/candidate/inbox/` 下的 candidate 路径——只是提案，尚未持久；
- `promote` 返回 `memory/scopes/team/` 下的已升级路径，外加一个 `eventId`——审计事件；
- `search` 与 `read` 返回的 JSON 带 `citation` 字段，指向答案背后那个确切的 Markdown 文件。

用完清理 demo space：

```bash
npx ihow-memory reset --space demo
```

同一闭环的单命令版本（在一次性 space 中运行）：

```bash
npx ihow-memory proof
```

## 检索引擎

默认检索引擎是零依赖的本地全文检索——只使用 Node 内置能力加 `node:sqlite` FTS5：没有第三方运行时依赖，不下载 embedding，不需要模型或 API key，检索结果自带引用。可选的本地向量 provider（独立进程）可叠加语义检索；若未配置或不健康，检索会以可见的方式回退到 FTS。治理、写入护栏与审计行为不随检索后端而改变。记忆本体始终是人类可读、可编辑、可回滚的 Markdown。

### 检索质量证据

作为检索质量的诚实证据——而非本产品的差异点——我们公开一项 LongMemEval_S 检索阶段结果：recall_all@10 = 1.0，覆盖全部 470 条有效样本（原始 500 条；ndcg_any@10 为 0.946）。三条边界：（1）这是检索层召回率，不是端到端、由 LLM 评判的答案准确率——不能与其他厂商报告的 90%+ 数字直接比较，后者度量的是另一层；（2）该成绩产生于我们实验性的「向量 + 词法」混合通道，而当前发布的包默认使用零依赖的 FTS5 词法检索（可选配本地向量 provider）；（3）一键复现工具链仍在开发中——在它落地之前，公开的 evidence manifest（指标定义、运行产物、完整的 @5 披露，含结构性上限）是可审计的依据。

Evidence manifest：[LongMemEval_S 检索阶段运行记录，2026-05-11](https://github.com/iHow1/ihow-memory-standard/blob/main/conformance/evidence/longmemeval-s-2026-05-11.md)。

## MCP 工具

stdio MCP server（由 `connect` 注册，或通过 `init` 片段手工配置）提供七个工具：

| 工具 | 作用 |
| --- | --- |
| `memory.search` | 用 FTS 检索本地记忆，返回引用路径与片段。 |
| `memory.read` | 按路径读取记忆 Markdown 文件，返回原文与引用。 |
| `memory.write_candidate` | 向沙箱 inbox 写入 candidate，不写持久记忆。 |
| `memory.promote` | 把 candidate 升级到受治理的 staging，并记审计事件。 |
| `memory.durable_promote` | 受治理的持久写入，必须显式传 `dryRun: true` 或 `realWrite: true`。 |
| `memory.journal` | 向每日 journal 追加一条低权重、只追加（append-only）的条目（自动捕获通道）；可检索，但排序始终低于受治理记忆。 |
| `memory.status` | 报告 workspace、检索 provider、索引与 sync 状态。 |

## CLI 速查

```text
ihow-memory init             创建受管 workspace，打印 MCP 配置片段
ihow-memory connect          自动配置 runtime（claude-code | codex | cursor | workbuddy | claude-desktop | opencode | hermes）[--dry-run]
ihow-memory install-skill    安装 Claude Code 记忆 skill 到 ~/.claude/skills
ihow-memory install-hook     安装会话结束自动捕获的 Stop hook（默认 project-local；--global-hook 用户级）
ihow-memory doctor           环境与配置检查 [--share-diagnostics 输出脱敏报告]
ihow-memory status           workspace、引擎、索引与 sync 状态 [--json]
ihow-memory search <query>   带引用的本地检索 [--limit n]
ihow-memory read <path>      读取单个记忆文件（带引用）
ihow-memory write-candidate  提出记忆 candidate（进入沙箱 inbox）
ihow-memory promote          升级 candidate（显式、留审计）
ihow-memory durable-promote  持久写入——必须传 --dry-run 或 --real-write
ihow-memory journal          追加一条低权重 journal 条目（自动捕获通道）
ihow-memory audit            列出只追加的审计事件日志 [--since]
ihow-memory rollback         撤销一条自动捕获的 journal 条目（--event <id>）
ihow-memory reindex          从 Markdown 重建 SQLite 索引
ihow-memory proof            在一次性 space 中跑完整治理闭环证明
ihow-memory feedback         打印预填的 GitHub issue 与脱敏诊断
ihow-memory reset            删除受管 demo space（必须传 --space）
ihow-memory console          只读本地 Web UI [--port 8788]
ihow-memory telemetry        on | off | status——匿名计数，默认关闭
```

默认值：root 为 `~/.ihow-memory`；space 由当前目录推导，除非显式传 `--space`。完整参数见 `npx ihow-memory --help`。

## 主动记忆（Claude Code，实验性）

`connect --runtime claude-code --install-hook` 会装一个 Stop hook：会话结束时请求在场 agent 通过 `memory.journal` 把一次交接记入低权重 `journal` 通道。它是**尽力而为**（随会话增长重提示、写入一条后即停）、**默认 project-local**（`--global-hook` 用户级）、**可回滚**（`ihow-memory audit` / `rollback`）。

> **实验性、且 Claude Code 优先。** 这是一次 Stop-hook 交接，**不是**有保证的自动捕获循环——是否写入取决于 agent 是否照提示执行。机制（会话结束自动触发 → agent 经 MCP 写入 → 低权重 journal）已在本地与另一 runtime 验证；真实 Claude Code app smoke 已通过，多轮 dogfood 仍待做。自动捕获的笔记是**低权重、未经审阅**的——可信长期记忆请用 `promote` / `durable-promote`。完整说明以英文 README 为准。

## 记忆布局与写入边界

受管 space 就是普通文件：

```text
~/.ihow-memory/<space>/
  memory/
    candidate/inbox/     # agent 的提案落在这里，本身永不持久
    scopes/<scope>/      # 升级后的持久 Markdown
    _events/             # 只追加的审计日志（ndjson）
  history/               # durable promote 后归档的 candidate
  index.sqlite           # FTS 索引（可用 reindex 重建）
  index-manifest.json
```

也可以把 iHow Memory 指向一个已有的 Markdown 目录，不必移动它：

```bash
npx ihow-memory doctor --memory-root <memory-root> --state-root <state-root>
```

这种模式下写入边界是严格的：既有持久 Markdown 默认只读；candidate 写入 `memory/_mcp/candidates/`，staging promote 写入 `memory/_mcp/promoted/`，审计事件写入 `memory/_mcp/_events/`；SQLite 状态放在 `<state-root>` 下、memory root 之外。要向既有目录做持久写入，只能走 `durable-promote`，且必须显式传 `--dry-run`（打印完整执行计划）或 `--real-write`，否则拒绝执行。

## 诊断、反馈、重置、卸载

**可分享的 doctor 报告。** `npx ihow-memory doctor --runtime <runtime> --share-diagnostics` 输出脱敏报告：本地路径替换为占位符、类密钥值被删除、不包含记忆内容。只在本地打印，绝不上传。

**反馈。** `npx ihow-memory feedback --runtime <runtime>` 打印预填的 GitHub issue URL、Markdown 模板和脱敏 doctor 摘要。不会自动提交任何内容。

**重置。** `npx ihow-memory reset --space <name>` 删除受管 space。它要求显式 `--space`，只删除受管 space，并拒绝 `--memory-root`——不可能删掉既有的共享 memory root。

**卸载。**

1. 从 runtime 移除 `ihow-memory` 条目：`claude mcp remove ihow-memory --scope user`、`codex mcp remove ihow-memory`，或编辑 `~/.cursor/mcp.json`（若是 `connect` 写入的，旁边有 `*.ihow-bak-*` 备份）。
2. 用 `npx ihow-memory reset --space <name>` 删除 demo space。
3. 如曾全局安装：`npm uninstall -g ihow-memory`。
4. 自定义 state root 请在确认内容后再手动删除。

## 示例

可直接运行、自包含的演练在 [`examples/`](./examples/)（编号 01–03）。所有示例只用合成数据。

## 隐私

- 开源核心在本地运行：无账号、无必需网络调用，cloud 与 sync 处于禁用状态，并在 `status` 和 `doctor` 中如实报告。
- 遥测**默认关闭**、需主动开启（`ihow-memory telemetry on`）。开启后只记录固定白名单——事件名、runtime、包版本、错误类型、时间戳——绝不记录记忆内容、文件名、查询、路径或 prompt。当前 alpha 阶段，事件只追加到本地文件（`~/.ihow-memory/telemetry-events.jsonl`），不向任何地方上传。
- 诊断输出按设计脱敏，绝不包含记忆内容。`feedback` 只打印模板——是否提交由你决定。

## Hosted runtime

Hosted runtime 不包含在本 npm 包与本仓库中。

## 状态

Alpha 预发布（`0.1.0-alpha` 系列——上方 npm 徽章即最新发布版本；详见 [CHANGELOG.md](./CHANGELOG.md)）。已在 macOS 与 Linux 上验证；Windows 暂不在支持范围。npm 包内含编译后的 CLI、stdio MCP server 与只读本地 console；TypeScript 源码就在本仓库。alpha 版本间可能有破坏性变更。

## 链接

- 官网：[ihowmemory.com](https://ihowmemory.com)
- 格式与一致性（内部机制）：[iHow1/ihow-memory-standard](https://github.com/iHow1/ihow-memory-standard)
- Benchmark evidence manifest：[conformance/evidence/longmemeval-s-2026-05-11.md](https://github.com/iHow1/ihow-memory-standard/blob/main/conformance/evidence/longmemeval-s-2026-05-11.md)
- npm 包：[npmjs.com/package/ihow-memory](https://www.npmjs.com/package/ihow-memory)

## 参与贡献

见 [CONTRIBUTING.md](./CONTRIBUTING.md)（要求 DCO 签署——[DCO.md](./DCO.md)）。安全报告见 [SECURITY.md](./SECURITY.md)——请勿为漏洞开公开 issue。

## 许可证

Apache License 2.0——见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)。iHow / iHow Memory 名称与 logo 为商标，见 [TRADEMARK.md](./TRADEMARK.md)。
