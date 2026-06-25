# iHow Memory

> 给异构 AI coding agents 用的本地共享记忆运行时——一份 git 可审的 Markdown 记忆，供它们共享并安全交接。

[![npm version](https://img.shields.io/npm/v/ihow-memory.svg)](https://www.npmjs.com/package/ihow-memory)
[![CI](https://github.com/iHow1/ihow-memory-core/actions/workflows/ci.yml/badge.svg)](https://github.com/iHow1/ihow-memory-core/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](./LICENSE)

[English](./README.md)

> 本文是英文版 README 的翻译。单一信源为英文版；若中英文有出入，以 [英文版](./README.md) 为准。

**要求：Node.js >= 22.12 · macOS / Linux（alpha）。** 无账号、无 API key、无第三方运行时依赖。（Node >= 22.12 是硬性要求——引擎使用 `node:sqlite`。）

**适合谁用：** 最适合用 git 的编码工作流——此时 verify-first 交接能拿到最强的锚点；不用 git 也能用，改用文件指纹锚点（见下文）。

iHow Memory 是给异构 AI coding agents 用的本地共享记忆运行时——让 Claude Code、Codex、Cursor 以及其他 MCP 客户端共享同一份人可读、git 可审的长期记忆，并能安全交接。记忆本体是磁盘上的纯 Markdown，你可以用 git 阅读、diff、回滚；写入前有一道检查会拒绝看起来含密钥的候选，每次 promote 都是一个审计事件；交接（handoff）是下一个 agent 会读到的一份候选——当前状态、证据、阻塞、下一步。在 git 仓库里，你能拿到最强的 verify-first 锚点（branch / HEAD / dirty）；在非 git 项目里，交接照样能用——你会得到上一会话的叙述加上文件指纹锚点（接收方会对动过的文件重新哈希以发现漂移）——只是没有 git 那种 commit 级的 GREEN/RED。Agent 通过 stdio MCP server 接入；你在 CLI 里用的是同一套流程。

## 为什么不同

1. **天生跨厂商。** 同一份记忆，可供 Claude Code、Codex、Cursor、腾讯 WorkBuddy、Claude Desktop、OpenCode、Hermes 与 OpenClaw 共享——跨厂商，在你自己的机器上，每个一条命令接入。大平台都有理由把记忆锁在各自生态里；iHow 是它们之间那层中立的本地记忆。当前 alpha 阶段只有 Claude Code 在每日 dogfood，其余都是单机真机 smoke，而 Cursor 与 Claude Desktop 只能接收（能调用工具，但无法 resume）——详见 [Runtime 支持](#runtime-支持)。
2. **安全写入 + 交接。** 多个 agent 共享同一份记忆，写入由 workspace 锁串行化，彼此不会互相覆盖。写入前有一道检查会拒绝看起来含密钥（token、key、凭据）的候选，每次 promote 都是一个审计事件。交接（handoff）是下一个 agent 会读到的一份候选——当前状态、证据、阻塞、下一步——而不只是一条检索命中。
3. **人可读，且归你所有。** 记忆是纯 Markdown，你可以用 git 阅读、diff、回滚——不锁厂商、无向量黑盒、无账号、默认无遥测。治理流程（候选 → 审阅 → promote）在团队需要时随时可用，而不是被强制的步骤。

## 快速开始

### 1. 接入 runtime

```bash
npx ihow-memory@next connect --runtime claude-code   # 或：codex | cursor | workbuddy | claude-desktop | opencode | hermes | openclaw
```

`connect` 会在 `~/.ihow-memory` 下创建受管 workspace（space 名默认由当前目录推导，也可用 `--space` 指定），并把 `ihow-memory` MCP server 注册到所选 runtime：

- Claude Code 与 Codex 通过各自官方 CLI 配置（`claude mcp add-json`、`codex mcp add`）。
- Cursor 通过合并 `~/.cursor/mcp.json` 配置，写入前先做带时间戳的备份；无法解析的配置文件绝不覆盖。
- 想先预览、不做任何改动，加 `--dry-run`：

```bash
npx ihow-memory@next connect --runtime claude-code --dry-run
```

如果你更想手工编辑 runtime 配置，可用 `npx ihow-memory@next init --runtime <runtime>` 打印（而不是直接写入）对应的 MCP 配置片段。

### 2. 验证

```bash
npx ihow-memory@next doctor --runtime claude-code
```

`doctor` 检查 Node 版本、`node:sqlite` 可用性、memory root 可写性、runtime 配置、检索引擎就绪状态与索引 manifest，并确认 cloud/sync 处于禁用状态。

### 3. 60 秒治理闭环

下面就是 agent 在 MCP 上用的同一套流程，在 shell 里跑一遍。整段可直接复制：

```bash
npx ihow-memory@next init --space demo
CAND=$(npx ihow-memory@next write-candidate "Decision: ship weekly release notes." --space demo | sed -n 's/.*"path": "\([^"]*\)".*/\1/p')
PROMOTED=$(npx ihow-memory@next promote "$CAND" --scope team --title "Release notes cadence" --space demo | sed -n 's/.*"path": "\([^"]*\)".*/\1/p')
npx ihow-memory@next search "release notes" --space demo
npx ihow-memory@next read "$PROMOTED" --space demo
```

你应该看到：

- `write-candidate` 返回 `memory/candidate/inbox/` 下的 candidate 路径——只是提案，尚未持久；
- `promote` 返回 `memory/scopes/team/` 下的已升级路径，外加一个 `eventId`——审计事件；
- `search` 与 `read` 返回的 JSON 带 `citation` 字段，指向答案背后那个确切的 Markdown 文件。

用完清理 demo space：

```bash
npx ihow-memory@next reset --space demo
```

同一闭环的单命令版本（在一次性 space 中运行）：

```bash
npx ihow-memory@next proof
```

### 更新

`connect` 会把一份 server 运行时副本冻结进 workspace，所以 `npm update` **本身不会**刷新正在运行的 MCP server。更新包之后，请跑 `npx ihow-memory@next upgrade`（然后重启 runtime）来刷新已接入的 server。当已接入的 server 比已安装的包旧时，`doctor` 会发出警告（一项「runtime-bundle」检查）。

## Runtime 支持

`connect` 为八个 runtime 生成 MCP 注册配置；`setup` 一条命令接好每个检测到的 runtime，并在 runtime 有指令文件时注入一句「resume 时调用 `memory.continue`」的提示。两个维度要分清：**connect**（runtime 能调用记忆工具）和 **resume reader**（该 runtime 自己过去的会话能被 `memory.continue` 接上）。下表除特别说明外均为单机真机 smoke——这是 alpha。

| Runtime | connect | resume reader | 备注 |
| --- | --- | --- | --- |
| Claude Code | ✓（`claude mcp add-json`） | ✓ | 真机 app smoke + 持续 dogfood；含 skill + 自动捕获 hooks |
| Codex | ✓（`codex mcp add`） | ✓ | 单机真机 smoke |
| OpenClaw | ✓（`~/.openclaw/openclaw.json`） | ✓ | 单机真机 smoke（memory.continue + git 预检） |
| Hermes | ✓（`hermes mcp add`） | ✓（JSON + `state.db`） | 单机真机 smoke |
| OpenCode | ✓（`~/.config/opencode`） | ✓（`opencode.db`） | 单机真机 smoke |
| WorkBuddy | ✓（`~/.workbuddy/mcp.json`） | ✓ | 单机真机 smoke |
| Cursor | ✓（合并 `~/.cursor/mcp.json`） | ✗ | 只能接收——Cursor 把会话存在二进制 IndexedDB 里，无法读取用于 resume |
| Claude Desktop | ✓ | ✗ | 只能接收（聊天 app；没有可 resume 的本地会话） |

MCP 工具与治理闭环与 runtime 无关。主动记忆 skill + 自动捕获 hooks 是 Claude Code 专属；resume 提示会自动注入到那些配置暴露了指令文件的 runtime（Claude Code、WorkBuddy、OpenClaw、Hermes、OpenCode）。

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
| `memory.write_candidate` | 记一条记忆。引擎会把带 provenance（证据/锚点）的低风险内容自动晋升为持久记忆；高风险或无证据的内容保留为 candidate。 |
| `memory.promote` | 显式手动把 candidate 升级到受治理的 staging，并记审计事件。 |
| `memory.durable_promote` | 受治理的持久写入，必须显式传 `dryRun: true` 或 `realWrite: true`。 |
| `memory.journal` | 向每日 journal 追加一条低权重、只追加（append-only）的条目（自动捕获通道）；可检索，但排序始终低于受治理记忆。 |
| `memory.status` | 报告 workspace、检索 provider、索引与 sync 状态。 |

## CLI 速查

```text
ihow-memory init             创建受管 workspace，打印 MCP 配置片段
ihow-memory connect          自动配置 runtime（claude-code | codex | cursor | workbuddy | claude-desktop | opencode | hermes）[--dry-run]
ihow-memory install-skill    安装 Claude Code 记忆 skill 到 ~/.claude/skills
ihow-memory install-hook     安装自动捕获 hooks——Stop（协作式提示）+ SessionStart（确定式 floor）（默认 project-local；--global-hook 用户级）
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
ihow-memory upgrade          更新包后刷新 workspace 里冻结的 server 副本（然后重启 runtime）
ihow-memory proof            在一次性 space 中跑完整治理闭环证明
ihow-memory feedback         打印预填的 GitHub issue 与脱敏诊断
ihow-memory reset            删除受管 demo space（必须传 --space）
ihow-memory console          只读本地 Web UI [--port 8788]
ihow-memory telemetry        on | off | status——匿名计数，默认关闭
```

默认值：root 为 `~/.ihow-memory`；space 由当前目录推导，除非显式传 `--space`。完整参数见 `npx ihow-memory@next --help`。

`console` 在设计上是**只读、仅 loopback、单用户 / 可信机器**的——目前还没有 auth token，所以不要在共享或多用户主机上运行它。

## 排障（Troubleshooting）

- **写入被判为"含密钥"但其实不是。** 写入前检查刻意保守（按 token/key/凭据模式匹配）。改写以去掉像密钥的子串，或干脆别把该值放进记忆。自动捕获是脱敏而非拒绝，所以这只影响手动 `write-candidate` / `promote`。
- **刚写的东西 `search` 搜不到。** FTS 索引在写入时重建；若看起来过期，跑 `npx ihow-memory@next reindex` 从 Markdown 重建，用 `npx ihow-memory@next status` 确认索引状态。
- **`doctor` 报 `node:sqlite`。** 需要 Node.js ≥ 22.12（含 `node:sqlite` 的版本），用 `node -v` 检查。
- **装了 hook 但没捕获（Claude Code）。** `install-hook` 后重启 Claude Code 以加载设置。协作式 Stop hook 取决于 agent 是否照提示做；确定式 SessionStart floor 只对「上一会话没有协作式 journal」时才出手（已 journal 的会话会被正确跳过）。用 `npx ihow-memory@next audit` 看结果。
- **`connect --auto` 跨项目只兜底了一个。** Floor 捕获是单 cwd 的（见局限）。
- **npx 缓存被清 / hook 命令失效。** 从 `npx` 缓存路径安装可能被清掉；要稳定的 hook，先全局安装（`npm i -g ihow-memory`）再跑 `install-hook`。
- **Windows。** 请用 WSL；原生 Windows 为实验性。

## 主动记忆（Claude Code，实验性）

自动捕获分两层：

- **会话结束协作式捕获——实验性。** `connect --runtime claude-code --install-hook` 装一个 Stop hook：会话结束时请求在场 agent 通过 `memory.journal` 把一次交接记入低权重 `journal` 通道。它是**尽力而为**（随会话增长重提示、写入一条后即停）、**默认 project-local**（`--global-hook` 用户级）、**可回滚**（`ihow-memory audit` / `rollback`）。
- **下一会话 floor 兜底（确定式）——实验性，仅 `next`。** 同一个 `install-hook` 还会装一个 SessionStart hook：新会话启动时，**若上一会话没有协作式 journal**，就确定式地把上一会话兜底——解析其 transcript，在**锁死的范围**内（assistant 文本 + 文件路径 + 命令二进制名 + 首个 prompt；绝不含工具输出、绝不含原始 shell）取"最后实质段"摘要，脱敏后写为一条低权重、可审计、可回滚的 journal 条目。它是协作式提示之下的安全网：**单 cwd**、静默（绝不注入上下文——recall 保持关闭）、永不抛错。已在 22 个真实历史 transcript 上离线评分通过 backstop 质量门；真实的自然 floor 命中仍在 dogfood 中（因为目前协作式捕获覆盖了所有观察到的会话）。

> **实验性、且 Claude Code 优先。** 自动捕获 = 协作式 Stop-hook 提示（是否写入取决于 agent 是否照做）+ 确定式 SessionStart floor 兜底（仅 `next`，在提示没被照做时捕获上一会话）。两者都写**低权重、未经审阅**的笔记——可信长期记忆请用 `promote` / `durable-promote`。floor 仅作离线验证过的 backstop，尚未升为 primary/默认权重路径；`recall`（把记忆读回新会话）默认**关闭**。完整说明以英文 README 为准。

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
npx ihow-memory@next doctor --memory-root <memory-root> --state-root <state-root>
```

这种模式下写入边界是严格的：既有持久 Markdown 默认只读；candidate 写入 `memory/_mcp/candidates/`，staging promote 写入 `memory/_mcp/promoted/`，审计事件写入 `memory/_mcp/_events/`；SQLite 状态放在 `<state-root>` 下、memory root 之外。要向既有目录做持久写入，只能走 `durable-promote`，且必须显式传 `--dry-run`（打印完整执行计划）或 `--real-write`，否则拒绝执行。

## 诊断、反馈、重置、卸载

**可分享的 doctor 报告。** `npx ihow-memory@next doctor --runtime <runtime> --share-diagnostics` 输出脱敏报告：本地路径替换为占位符、类密钥值被删除、不包含记忆内容。只在本地打印，绝不上传。

**反馈。** `npx ihow-memory@next feedback --runtime <runtime>` 打印预填的 GitHub issue URL、Markdown 模板和脱敏 doctor 摘要。不会自动提交任何内容。

**重置。** `npx ihow-memory@next reset --space <name>` 删除受管 space。它要求显式 `--space`，只删除受管 space，并拒绝 `--memory-root`——不可能删掉既有的共享 memory root。

**卸载。**

1. 从 runtime 移除 `ihow-memory` 条目：`claude mcp remove ihow-memory --scope user`、`codex mcp remove ihow-memory`，或编辑 `~/.cursor/mcp.json`（若是 `connect` 写入的，旁边有 `*.ihow-bak-*` 备份）。
2. 用 `npx ihow-memory@next reset --space <name>` 删除 demo space。
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

Alpha 预发布（`0.1.0-alpha` 系列——上方 npm 徽章即最新发布版本；详见 [CHANGELOG.md](./CHANGELOG.md)）。成熟度为 **alpha + 单机真机 smoke**：只有 Claude Code 在每日 dogfood，其余 runtime 都是单机真机 smoke，而 Cursor 与 Claude Desktop 只能接收（能调用工具，但无法 resume）。Node >= 22.12 是硬性要求（`node:sqlite`）。已在 macOS 与 Linux 上每日验证；原生 Windows 为**实验性**——`packageDir` 路径 bug 已修，并有 `windows-latest` CI lane 覆盖构建 + connect/doctor 可达性 smoke + 全量测试，受支持路径为 WSL。npm 包内含编译后的 CLI、stdio MCP server 与只读本地 console；TypeScript 源码就在本仓库。alpha 版本间可能有破坏性变更。

**哪个版本有什么（dist-tag）。** 预发布版发布在 `next` dist-tag 下；`npm install ihow-memory` 解析到 `latest`。

| dist-tag | 自动捕获 |
| --- | --- |
| `latest` | 仅协作式 Stop-hook 提示（取决于 agent 是否照做） |
| `next` | 增加**确定式 SessionStart floor** 兜底（单 cwd、低权重、离线验证过）；`recall` 仍关闭 |

想试 floor 兜底：`npm install ihow-memory@next`。普通 `npm install ihow-memory` 留在保守的 `latest`。

## 局限（Limitations）

- **Floor 捕获是单 cwd 的。** SessionStart floor 只兜底其指定的 workspace/cwd。若 `connect --auto` 跨多个共享同一 workspace 的项目，floor 只覆盖一个 cwd；多 cwd 广推待进一步 dogfood。
- **默认检索是词法、非语义。** 出厂默认是零依赖 FTS5 词法检索。「向量 + 词法」混合（公开召回数字背后的那套）是**可选**的本地 provider，不在开箱二进制里。
- **自动捕获笔记是低权重、未经审阅**的，确定式 floor 是兜底、尚非 primary/默认权重路径。`recall`（把记忆读回会话）默认关闭。可信长期记忆请用 `promote` / `durable-promote`。
- **存储会无上限增长（暂无轮转 / 压实 / GC）。** journal、审计 ndjson 日志、以及 `*.ihow-bak-*` 备份目前都会持续累积，而且每次写入都会重建整个 FTS 索引——轮转 / 压实 / GC 已在规划中，但尚未发布。日常使用无碍；长时间高强度使用会越积越多。手动缓解：偶尔跑 `ihow-memory reindex`、并手动清理旧备份。
- **Windows 原生为实验性**（请用 WSL）；仅 macOS 与 Linux 是验证过的支持线。

## 链接

- 官网：[ihowmemory.com](https://ihowmemory.com)
- 格式与一致性（内部机制）：[iHow1/ihow-memory-standard](https://github.com/iHow1/ihow-memory-standard)
- Benchmark evidence manifest：[conformance/evidence/longmemeval-s-2026-05-11.md](https://github.com/iHow1/ihow-memory-standard/blob/main/conformance/evidence/longmemeval-s-2026-05-11.md)
- npm 包：[npmjs.com/package/ihow-memory](https://www.npmjs.com/package/ihow-memory)

## 参与贡献

见 [CONTRIBUTING.md](./CONTRIBUTING.md)（要求 DCO 签署——[DCO.md](./DCO.md)）。安全报告见 [SECURITY.md](./SECURITY.md)——请勿为漏洞开公开 issue。

## 许可证

Apache License 2.0——见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)。iHow / iHow Memory 名称与 logo 为商标，见 [TRADEMARK.md](./TRADEMARK.md)。
