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

1. **Verify-first 交接——无需重新讲背景，也不盲信上一任。** `/clear` 后、开启新会话或换到另一个工具时，运行 `memory.continue`（或 `ihow-memory continue`）。接收方会拿到上一会话的交接叙事，同时用**现场 git 锚点重新核验（GREEN / RED），再决定是否信任叙事**。因此新 agent 可以从原处继续，又不会把过期的“已完成 / 已发布”当成事实。其他记忆工具主要检索事实；iHow 的核心差异是带信任检查的跨工具 resume。Git 仓库能提供最强的 branch / HEAD / dirty 锚点；非 git 项目则用文件指纹，由接收方重新哈希已修改文件来发现漂移。
2. **天生跨厂商。** 同一份记忆，可供 Claude Code、Codex、Cursor、腾讯 WorkBuddy、Claude Desktop、OpenCode、Hermes 与 OpenClaw 共享——跨厂商，在你自己的机器上，每个一条命令接入。大平台都有理由把记忆锁在各自生态里；iHow 是它们之间那层中立的本地记忆。当前 alpha 阶段只有 Claude Code 在每日 dogfood，其余都是单机真机 smoke，而 Cursor 与 Claude Desktop 只能接收（能调用工具，但无法 resume）——详见 [Runtime 支持](#runtime-支持)。
3. **安全写入 + 治理。** 多个 agent 共享同一份记忆，写入由 workspace 锁串行化，彼此不会互相覆盖。写入前有一道检查会拒绝看起来含密钥（token、key、凭据）的候选，每次 promote 都是一个审计事件。
4. **人可读，且归你所有。** 记忆是纯 Markdown，你可以用 git 阅读、diff、回滚——不锁厂商、无向量黑盒、无账号、默认无遥测。治理流程（候选 → 审阅 → promote）在团队需要时随时可用，而不是被强制的步骤。

**Alpha.27.1 本地候选（`0.1.0-alpha.27.1`；local release-ready only）：** Alpha.27 的有界不可变 Checkpoint Core、Claude Code/Codex 原生 `PreCompact`、crash-floor、checkpoint-first continue、protection state 与 same-HEAD `statusHash` / verify-first Git 加固保持不变。本补丁让显式 managed `root` 优先于环境中的 memory-root 变量；测试子进程会清理 ambient routing 变量，并有真实 subprocess 证据；成功路径的测试 envelope 也与生产 8 秒 watchdog / 10 秒宿主预算分离。包仍包含用于 Hermes 原生生命周期的 Hermes Plugin 与 `ihow-memory-hermes-bridge`；此前 adapter lane 证据只支持 `HOST VERIFIED/READY`，不能独立认证为 `ACTIVE`。Alpha.27 已发布到 npm；当前 Alpha.27.1 checkout 尚未发布，也尚未 push、tag、release 或 deploy，不代表 production certification。

## 快速开始——约 3 分钟看到第一次成功

### 1. 本地接入

```bash
npx ihow-memory@next setup
```

`setup` 会检测已安装的 runtime、接入本地 MCP server，只在 runtime 有稳定入口时安装主动记忆行为，并运行 `doctor`。它可重复执行、改配置前会备份，最后只给一张结果卡：接上了什么、哪些已验证或待确认、是否需要重启、数据在本机哪里，以及唯一下一步。

激活状态来自真实证据，而不是安装成功文案。只有当前 Claude/Codex Hook 接线经现场核验，且该配置代际之后出现有效的真实 Hook 完成事件，`doctor` 才会显示 **ACTIVE**；**READY — WAITING FOR FIRST ACTIVITY** 表示原生 Hook 已配置但尚未观察到合格的真实活动；**TOOLS ONLY** 表示只有 MCP/协作式工具，没有可核验的生命周期 Hook；**NEEDS REPAIR** 表示此前配置过的托管 Hook 已缺失、重复、损坏、目标失效或绑定到了错误 workspace。synthetic probe 和 started-only 事件绝不会升级成 ACTIVE。Activation Ledger 只保存哈希化 binding 与有界元数据，不保存 prompt、transcript、环境变量或错误正文。

想先零写入预览：

```bash
npx ihow-memory@next setup --dry-run
```

### 2. 立即看懂 verify-first 的差异

```bash
npx ihow-memory@next proof
```

`proof` 只在一次性 git 仓库和临时记忆 workspace 中运行，会直接展示：

```text
上一任 agent 的叙事：UNVERIFIED
记录锚点 == 现场锚点  -> GREEN
记录之后 checkout 漂移 -> RED
```

它同时证明治理闭环——candidate → promote → 带引用的 search/read + audit——不会修改你的项目或真实 runtime 配置。默认检索是诚实的零依赖词法 FTS；可选语义召回是另一条 opt-in 通道，不会被包装成行业最强语义能力。

### 3. 接回真实工作

在 `/clear`、新会话或切换到另一个受支持 runtime 后：

```bash
npx ihow-memory@next continue            # 可选仓库关键词：continue <name>
```

`continue` 会把上一会话叙事标成 **UNVERIFIED**，并交给接收方现场重验机器锚点。GREEN 的条件刻意很窄；一旦有漂移或冲突就强制 RED。首次使用还没有历史会话时，CLI 会直接说明，并引导运行 `proof`，不会再输出一个巨大的空交接包。在 Claude Code 里可直接说“继续”。

### 4. 纠正错误记忆

```bash
npx ihow-memory@next forget "文字或 memory/path.md"
# 可逆：
npx ihow-memory@next remember "文字或 memory/path.md"
```

`forget` 只对一个无歧义匹配做 tombstone，让它停止出现在 search 和 recall；原文件不删除，操作可逆且有审计。

### `setup` 当前接入成熟度

Claude Code 是每日 dogfood 主路径；Codex、OpenClaw、Hermes、OpenCode、WorkBuddy 完成了单机真机 smoke；Cursor、Claude Desktop、VS Code 因没有可读取的本地会话存储而属于 receiver-only。进入生产假设前请看 [Runtime 支持](#runtime-支持)。

只接一个 runtime，或先查看配置而不直接写入：

```bash
npx ihow-memory@next connect --runtime claude-code --dry-run
npx ihow-memory@next connect --runtime claude-code
npx ihow-memory@next init --runtime claude-code       # 只打印 MCP 片段
npx ihow-memory@next doctor --runtime claude-code
```

### 显式治理闭环

Agent 在 MCP 上使用的是同一路径。下面这段 shell 会把审阅门完整展示出来：

```bash
npx ihow-memory@next init --space demo
CAND=$(npx ihow-memory@next write-candidate "Decision: ship weekly release notes." --no-auto-promote --space demo | sed -n 's/.*"path": "\([^"]*\)".*/\1/p')
PROMOTED=$(npx ihow-memory@next promote "$CAND" --scope team --title "Release notes cadence" --space demo | sed -n 's/.*"path": "\([^"]*\)".*/\1/p')
npx ihow-memory@next search "release notes" --space demo
npx ihow-memory@next read "$PROMOTED" --space demo
npx ihow-memory@next reset --space demo
```

不加 `--no-auto-promote` 时，干净写入可自动晋升到持久 yellow 子档；密钥和伪造锚点仍会被拦截。search/read 会引用确切 Markdown 来源，promote 会生成审计事件。

### 更新

`connect` 会把一份 server 运行时副本冻结进 workspace，所以 `npm update` **本身不会**刷新正在运行的 MCP server。更新包之后，请跑 `npx ihow-memory@next upgrade`（然后重启 runtime）来刷新已接入的 server。当已接入的 server 比已安装的包旧时，`doctor` 会发出警告（一项「runtime-bundle」检查）。

## Runtime 支持

`connect` 为十个 runtime 生成 MCP 注册配置；`setup` 一条命令接好每个检测到的 runtime，并在 runtime 有指令文件时注入一句「resume 时调用 `memory.continue`」的提示。两个维度要分清：**connect**（runtime 能调用记忆工具）和 **resume reader**（该 runtime 自己过去的会话能被 `memory.continue` 接上）。下表除特别说明外均为单机真机 smoke——这是 alpha。

| Runtime | connect | resume reader | 备注 |
| --- | --- | --- | --- |
| Claude Code | ✓（`claude mcp add-json`） | ✓ | 真机 app smoke + 持续 dogfood；含 skill + Stop / SessionStart / PreCompact / UserPromptSubmit hooks |
| Codex | ✓（`codex mcp add`） | ✓ | 原生 SessionStart / PreCompact / UserPromptSubmit hooks + `~/.codex/AGENTS.md` 主动记忆循环；单机真机 smoke |
| OpenClaw | ✓（`~/.openclaw/openclaw.json`） | ✓ | 单机真机 smoke（memory.continue + git 预检） |
| Hermes | ✓（`hermes mcp add`） | ✓（JSON + `state.db`） | 单机真机 smoke |
| OpenCode | ✓（`~/.config/opencode`） | ✓（`opencode.db`） | 单机真机 smoke |
| WorkBuddy | ✓（`~/.workbuddy/mcp.json`） | ✓ | 单机真机 smoke |
| Cursor | ✓（合并 `~/.cursor/mcp.json`） | ✗ | 只能接收——Cursor 把会话存在二进制 IndexedDB 里，无法读取用于 resume |
| Claude Desktop | ✓ | ✗ | 只能接收（聊天 app；没有可 resume 的本地会话） |
| VS Code (Copilot) | ✓（用户级 `mcp.json`，`servers` key） | ✗ | 只能接收——可调用 `memory.search`/`read`/`continue`，但没有可读取的本地会话存储 |
| Gemini CLI | ✓（`~/.gemini/settings.json`） | ✓（`~/.gemini/tmp/*/logs.json`） | 被动读取 Gemini 的磁盘**用户 prompt 日志**（Gemini 不在磁盘记录助手轮）→ 会话主题 + git 锚点；需手动在 `GEMINI.md` 加提示。已对真实本地数据验证 |
| Cline (VS Code) | —（经 Cline 自己的 MCP 设置接入） | ✓（`globalStorage` / `~/.cline/data`） | 被动读取 `tasks/<id>/api_conversation_history.json`；cwd 取自 `environment_details`。已 fixture 测试，尚未真机 smoke |

MCP 工具与治理闭环与 runtime 无关。Claude Code 使用 skill + Stop / SessionStart / PreCompact / UserPromptSubmit hooks；Codex 使用原生 SessionStart / PreCompact / UserPromptSubmit hooks，并由 `~/.codex/AGENTS.md` 提供主动记忆循环。Alpha.27 的 PreCompact checkpoint 路径有界、无 transcript 原文、对宿主 fail-open；其 crash-floor 与 checkpoint-first continue 会在 artifact 或 anchor 不确定时 fail closed。Resume 提示会自动注入到配置暴露了指令文件的 runtime（Claude Code、WorkBuddy、OpenClaw、Hermes、OpenCode）。

## 检索引擎

默认检索引擎是零依赖的本地全文检索——只使用 Node 内置能力加 `node:sqlite` FTS5：没有第三方运行时依赖，不下载 embedding，不需要模型或 API key，检索结果自带引用。可选的本地向量 provider（独立进程）可叠加语义检索；若未配置或不健康，检索会以可见的方式回退到 FTS。治理、写入护栏与审计行为不随检索后端而改变。记忆本体始终是人类可读、可编辑、可回滚的 Markdown。

### 检索质量证据

召回质量**不是** iHow 的差异点——verify-first 治理才是。但我们照样公布出厂真数:对一个主打「别信绿」的工具,「声称」和「实测」绝不能背离。

头条数字就是你开箱即用真正跑的那套——**默认的零依赖 FTS5 词法引擎**（BM25）。在仓内可复现 fixture 上（`node scripts/retrieval-bench.mjs`）：

| 指标 | 默认 FTS5（已发布，零依赖） |
| --- | --- |
| R@5 | **0.85** |
| R@10 | **0.85** |
| MRR | **0.85** |
| tokens/query | **~5.7** |

这是一个**确定性、可被陌生人复跑**的 harness：`node scripts/retrieval-bench.mjs` 通过与产品相同的 `write → promote → search` 路径灌入带标注的 fixture，计算 R@5/R@10/MRR + tokens-per-query，无云、无 LLM、无第三方依赖。

**诚实的地板：同义换词召回是弱项。** 关键词与部分关键词 query 召回良好（fixture 中 15/15），但**与答案不共享任何表层 token 的同义/换词 query 只有 2/5 = 0.40**——一次换词的 query 就暴露了词法引擎的零语义。可选语义 provider 旨在补这道 gap，但质量必须由实测的正向 delta 证明，不能从 provider 可用、模型名称或架构接线推断。

上面的 fixture 是**自建的 20 文档 / 20 query** 集合。为了不让数字只依赖我们自己的数据，还有一个在**公开、MIT 许可的标准数据集**上、可被陌生人复跑的运行——LongMemEval（oracle 变体，[arXiv:2410.10813](https://arxiv.org/abs/2410.10813)），跑在**同一个默认 FTS5 二进制**上：

| 指标（默认 FTS5 · 全局语料 · recall_any@k） | LongMemEval-oracle |
| --- | --- |
| Recall@5 | **0.788** |
| Recall@10 | **0.857** |
| MRR | **0.651** |

`node scripts/standard-bench.mjs --download` 会下载并 **sha256 校验**数据集，在默认引擎上跑全部 419 条可用实例（831 个 session 文档）；自带的 N=8 切片可离线跑（`node scripts/standard-bench.mjs`）。这是**全局语料**检索——在*所有*实例的 session 里找到那条 gold 证据 session，比论文的 per-instance oracle 设定**更难**。Recall@k 即 recall_any@k（官方口径）；MRR 是我们自己的指标（LongMemEval 报告 NDCG），**不**与论文表格直接可比。弱项保持可见：assistant 回答类与 preference 类问题——证据在助手那一轮、或是隐式的，被索引的用户轮与 query 几乎不共享表层 token——召回最差，正是可选语义 provider 要补的那道词法 gap。

#### 可选语义 sidecar（不在默认二进制里）

更高的召回数字确实存在，但它们来自另一条通道，绝不能被当作发布默认值来读：

| 数字 | 出处 |
| --- | --- |
| recall_all@10 = 1.0、ndcg_any@10 ≈ 0.946 | **需 opt-in 的语义 sidecar**（不在默认二进制里）、**实验性混合通道**、来自一份**外部 evidence manifest**（仓库 `iHow1/ihow-memory-standard`，日期 2026-05-11）、**仅检索阶段召回率**（**非**端到端、由 LLM 评判）。 |

不能与厂商端到端、由 LLM 评判的数字直接比较。

语义召回需要一个**用户自备的 embedding sidecar**（如 Ollama `nomic-embed-text`）作为独立本地进程运行。默认安装是**词法-only、零依赖**——这是设计上的护城河，不是缺漏。若 sidecar 未配置或不健康，检索会以可见的方式回退到 FTS。

`enable-semantic` 在 Ollama 不可达或模型未拉取时会非零退出并给出指引；它不会启用一条只能回退的通道。`doctor` 把语义健康问题报告为 warning，而不是整个产品失败，因为该通道是 additive。成功探测 `nomic-embed-text` 只证明 sidecar 能运行，**不证明质量提升**。20 文档 / 20 query fixture 上的真实模型快照目前并不一致：较早的 direct-sidecar harness 是同义换词 **2/5 → 2/5**（Δ0），而一次通过产品正常 `core.rebuild()` 路径的新鲜运行是 **2/5 → 5/5**（Δ+3）。后者是正 delta，但两者都对路径、fixture、模型和版本敏感，尚未建立稳定、可推广的真实模型质量 floor；应以你在当前环境的复跑结果为准。独立标注的确定性 synonym oracle 也能做到 **2/5 → 5/5**，但它只证明 RRF 架构接线，不是学习模型的质量证据。没有单独校准的模型 floor 时，prompt semantic-bypass 继续 fail closed。

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
ihow-memory setup            零配置:检测 runtime → 接 MCP + skill + 自动捕获/recall hooks → 自检（推荐;幂等、本地）[--dry-run] [--json]
ihow-memory init             创建受管 workspace，打印 MCP 配置片段
ihow-memory connect          自动配置 runtime（claude-code | codex | cursor | workbuddy | claude-desktop | opencode | hermes | openclaw | vscode | gemini）[--dry-run]
ihow-memory continue         上下文边界后接班——verify-first 交接 + live git 锚点（GREEN/YELLOW/RED）[关键词] [--list] [--json]
ihow-memory install-skill    安装 Claude Code 记忆 skill 到 ~/.claude/skills
ihow-memory install-hook     安装 hooks——Stop（协作提示）+ SessionStart（确定式 floor）+ UserPromptSubmit recall（reviewed 优先 + 受门控 auto soft facts，默认开；--no-recall 跳过）（默认 project-local；--global-hook 用户级）
ihow-memory doctor           环境与配置检查 [--share-diagnostics 输出脱敏报告]
ihow-memory verify           可复现自证回执:本地存储 + 各 runtime 可达性 + 本 checkout 的接班裁决,每行可自己重跑 [--runtime name] [--json]
ihow-memory status           workspace、引擎、索引与 sync 状态 [--json]
ihow-memory search <query>   带引用的本地检索 [--limit n]
ihow-memory read <path>      读取单个记忆文件（带引用）
ihow-memory write-candidate  提出记忆 candidate（进入沙箱 inbox）
ihow-memory promote          升级 candidate（显式、留审计）
ihow-memory durable-promote  持久写入——必须传 --dry-run 或 --real-write
ihow-memory journal          追加一条低权重 journal 条目（自动捕获通道）
ihow-memory organize         Safe Memory Gardener：生成 review-first JSON 草稿，包含来源证据、安全状态、重复/陈旧 review 标记与 organize 审计事件 [--scope project] [--since 7d] [--draft] [--json]
ihow-memory export-vault     将 gardener 草稿导出为 Obsidian 兼容 Markdown 视图，保留证据链接并记录 export 审计事件；导出不是信源 [--from-draft <draft_id>] [--format markdown]
ihow-memory import           导入你在别处写的记忆（Claude Code MEMORY.md、ai-memory markdown、任意 .md 目录）进可搜索 journal 通道 [--from path] [--apply] [--update]
ihow-memory audit            列出只追加的审计事件日志 [--since]
ihow-memory rollback         撤销一条自动捕获的 journal 条目（--event <id>）
ihow-memory reindex          从 Markdown 重建 SQLite 索引
ihow-memory migrate-local-day 一次性:把 UTC 命名的 journal/event 文件重新归到本地日（不传 --apply 为干跑）
ihow-memory upgrade          更新包后刷新 workspace 里冻结的 server 副本（然后重启 runtime）
ihow-memory proof            在一次性 space 中跑完整治理闭环证明
ihow-memory benchmark        verify-first 保证的确定性本地证明（三色裁决会判别;地板挡垃圾）——可重跑得同结果
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
- **旧 hook 指向已清理的 `npx` 缓存。** 重新运行 `npx ihow-memory@next setup`（或对该 workspace 运行 `install-hook`）。它只认领结构严格匹配的 iHow entry，把它们迁到 canonical hook group、删除重复 iHow entry，并改指向 workspace 冻结的 `.runtime/cli.js`；第三方 hooks 不会被替换。Hook 参数使用真正的 shell escaping，路径里有空格、引号、`$` 或反引号也能安全执行。
- **已经装过 prompt recall，现在想关闭。** 重新运行 `install-hook --no-recall`（或 `setup --no-recall`）；它会删除 iHow 自己管理的 `UserPromptSubmit` recall entry，同时保留第三方 prompt hooks。
- **setup 刷新了冻结 runtime bundle。** 新 bundle 会写入完整性摘要，先在旁路目录复制和校验，再原子换入；每个 space 的 `semantic.json` opt-in 会被保留。setup 会诚实要求受影响且已注册的 Runtime reload/restart。如果 Claude/Codex 官方 CLI 的替换 add 失败，会尽量恢复原注册；若回滚也失败，则明确报告真实变更。
- **Windows。** 请用 WSL；原生 Windows 为实验性。原生安装遇到不安全的 shell 元字符时会 fail closed，而不是生成可能被注入的 hook command。

## 主动记忆（Claude Code，实验性）

自动捕获分两层：

- **会话结束协作式捕获——实验性。** `connect --runtime claude-code --install-hook` 装一个 Stop hook：会话结束时请求在场 agent 通过 `memory.journal` 把一次交接记入低权重 `journal` 通道。它是**尽力而为**（随会话增长重提示、写入一条后即停）、**默认 project-local**（`--global-hook` 用户级）、**可回滚**（`ihow-memory audit` / `rollback`）。
- **下一会话 floor 兜底（确定式）——实验性，仅 `next`。** 同一个 `install-hook` 还会装一个 SessionStart hook：新会话启动时，**若上一会话没有协作式 journal**，就确定式地把上一会话兜底——解析其 transcript，在**锁死的范围**内（assistant 文本 + 文件路径 + 命令二进制名 + 首个 prompt；绝不含工具输出、绝不含原始 shell）取"最后实质段"摘要，脱敏后写为一条低权重、可审计、可回滚的 journal 条目。它是协作式提示之下的安全网：**单 cwd**、静默（floor 只捕获、自身不注入任何内容）、永不抛错。已在 22 个真实历史 transcript 上离线评分通过 backstop 质量门；真实的自然 floor 命中仍在 dogfood 中（因为目前协作式捕获覆盖了所有观察到的会话）。

> **实验性、且 Claude Code 优先。** 自动捕获 = 协作式 Stop-hook 提示（是否写入取决于 agent 是否照做）+ 确定式 SessionStart floor 兜底（仅 `next`，在提示没被照做时捕获上一会话）。两者都写**低权重、未经审阅**的笔记——可信长期记忆请用 `promote` / `durable-promote`。floor 仅作离线验证过的 backstop，尚未升为 primary/默认权重路径；`recall`（把记忆读回新会话）默认**开启**并以 reviewed 为优先，也会默认召回部分通过 machine gates 的相关 auto soft facts（偏好、配置等）。环境式 status/completion 与危险 behavior-bypass prior 被阻止；显式询问 status 时才会显示对应未验证 status note。输出是无逐条标签的 seamless `<recalled-memory>` reference fence。安装时用 `--no-recall` 跳过；运行时用 `IHOW_RECALL_OFF=1` 关闭；`IHOW_RECALL_AUTO_DEFAULT=0` 恢复 reviewed-only；`IHOW_RECALL_INCLUDE_AUTO=1` 只额外开放 engine-anchored auto，仍不能绕过 behavior gate 或 status-intent gate。完整说明以英文 README 为准。

## Safe Memory Gardener（alpha.24）

Safe Memory Gardener 是一个 review-first 的本地整理/导出路径：

```bash
npx ihow-memory@next organize --scope project --draft --json
npx ihow-memory@next export-vault --from-draft <draft_id> --format markdown
```

`organize` 会扫描 scope 内的 Markdown memory，在 `gardener/drafts/` 下写入确定性的 JSON 草稿，为每条有证据的项目保留源文件与行号，给疑似重复/陈旧内容打“仅供 review”的非破坏性标记，记录 `memory.organized` 审计事件，并且不会改写 curated memory。`export-vault` 会把草稿渲染成 Obsidian 兼容 Markdown digest，放在 `gardener/exports/` 下，对渲染后的 Markdown 跑脱敏/密钥检测，保留证据链接，并记录 `memory.exported` 审计事件。

导出的 Markdown **只是视图/编辑器工件**：它不是 source of truth，编辑它不会更新受治理的 memory。信源仍然是受治理的 Markdown memory store 与 append-only 审计轨迹。alpha.24 的范围刻意收窄；它不声称已经实现完整企业记忆策略自动化（没有 RBAC/ABAC、namespace leak matrix、adapter framework、admin UI 或持久 retention automation）。详见 [`docs/safe-memory-gardener.md`](./docs/safe-memory-gardener.md)。

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

Alpha 预发布候选 `0.1.0-alpha.27`（local release-ready only——上方 npm 徽章即最新发布版本；详见 [CHANGELOG.md](./CHANGELOG.md)）。成熟度为 **alpha + 单机真机 smoke**：只有 Claude Code 在每日 dogfood，其余 runtime 都是单机真机 smoke，而 Cursor 与 Claude Desktop 只能接收（能调用工具，但无法 resume）。Node >= 22.12 是硬性要求（`node:sqlite`）。已在 macOS 与 Linux 上每日验证；原生 Windows 为**实验性**——`packageDir` 路径 bug 已修，并有 `windows-latest` CI lane 覆盖构建 + connect/doctor 可达性 smoke + 全量测试，受支持路径为 WSL。npm 包内含编译后的 CLI、stdio MCP server 与只读本地 console；TypeScript 源码就在本仓库。alpha 版本间可能有破坏性变更。

**哪个版本有什么（dist-tag）。** 预发布版发布在 `next` dist-tag 下；`npm install ihow-memory` 解析到 `latest`。

| dist-tag | 自动捕获 |
| --- | --- |
| `latest` | 仅协作式 Stop-hook 提示（取决于 agent 是否照做） |
| `next` | 增加**确定式 SessionStart floor** 兜底（单 cwd、低权重、离线验证过）+ **recall 开启**（reviewed 优先 + 受门控的相关 auto soft facts；ambient status / behavior-bypass 受阻；seamless fenced reference） |

想试 floor 兜底：`npm install ihow-memory@next`。普通 `npm install ihow-memory` 留在保守的 `latest`。

## 局限（Limitations）

- **Floor 捕获是单 cwd 的。** SessionStart floor 只兜底其指定的 workspace/cwd。若 `connect --auto` 跨多个共享同一 workspace 的项目，floor 只覆盖一个 cwd；多 cwd 广推待进一步 dogfood。
- **默认检索是词法、非语义。** 出厂默认是零依赖 FTS5 词法检索。「向量 + 词法」混合（公开召回数字背后的那套）是**可选**的本地 provider，不在开箱二进制里。
- **Auto-tier memory 是机器判断，不是人审。** 相关 auto soft facts 默认可召回，但有确定式护栏：ambient status/completion claim 与所有 actionability-bypass prior 被阻止，journal/floor 通道仍永不自动注入，`IHOW_RECALL_AUTO_DEFAULT=0` 可恢复 reviewed-only。status prompt 只有在用户明确询问 status 时才放行对应 note；`IHOW_RECALL_INCLUDE_AUTO=1` 只增加 engine-anchored auto eligibility，仍不能越过 behavior gate 或 status-intent gate。关键词护栏刻意偏宽，并非完美分类器；可信长期记忆请用 `promote` / `durable-promote`。
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
