# iHow Memory

> **你的AI可以换，工作不能断。**

iHow Memory 为 coding agent 提供一份本地、人可读的共享记忆，跨会话、跨工具交接。在支持捕获的路径上，上下文被压缩、runtime 崩溃，或你从 Claude Code 换到 Codex 时，下一位 agent 能接到此前的状态、证据、阻塞与下一步。

它不会直接相信上一位 agent 的叙事。接收方先重新检查现场 git 锚点：仓库状态吻合才能得到 **GREEN**，发生漂移就强制 **RED**。记忆以 Markdown 留在你的机器上，带引用与审计轨迹。

[![npm version](https://img.shields.io/npm/v/ihow-memory.svg)](https://www.npmjs.com/package/ihow-memory)
[![CI](https://github.com/iHow1/ihow-memory-core/actions/workflows/ci.yml/badge.svg)](https://github.com/iHow1/ihow-memory-core/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](./LICENSE)

[English](./README.md)

> 本文是英文版 README 的翻译。单一信源为英文版；若中英文有出入，以 [英文版](./README.md) 为准。

## 3 分钟看见证据

要求 Node.js >= 22.12，运行于 macOS 或 Linux；支持 WSL，原生 Windows 仍为实验性。无需账号或 API key。

### 接入

```bash
npx ihow-memory setup
```

`setup` 会检测支持的 runtime，改配置前先备份，接入本地 MCP server，并报告哪些已验证、待确认或需要重启。

### 运行证明

```bash
npx ihow-memory proof
```

`proof` 只用合成数据，在一次性 git 仓库与临时记忆 workspace 中运行。它会证明：上一位 agent 的叙事保持 **UNVERIFIED**；现场锚点吻合后得到 **GREEN**；仓库发生漂移后强制 **RED**；agent A 的受治理记忆带着引用与审计事件到达 agent B。它不会修改你的项目或 runtime 配置。

想先看清过程，可阅读 [30–45 秒证据分镜](./docs/demo-storyboard.md)，或运行[仓库内合成演示脚本](./examples/verify-first-handoff-demo.sh)。

## 中断之后，什么能接回来

| 中断 | 恢复路径 | 信任边界 |
| --- | --- | --- |
| 上下文压缩 | 支持的 Hook 会在压缩前写入有界 checkpoint。 | 叙事仍未验证；checkpoint 工件与锚点都必须通过校验。 |
| 崩溃或会话意外结束 | 在支持捕获的 runtime 上，后续会话可恢复最近的有效 checkpoint 或 capture floor。 | 证据缺失、不完整或漂移时 fail closed，不会变成“已完成”结论。 |
| 切换工具 | 接收方 MCP 客户端读取共享 handoff 与本地 Markdown 记忆。 | 继续之前，接收方重新检查现场仓库或文件指纹锚点。 |

Git 仓库能提供最强的 branch / HEAD / dirty 锚点。非 git workspace 仍可用文件指纹检查漂移，但没有 commit 级 GREEN/RED。

**证据边界：** Claude Code 是每日 dogfood 主路径；其他 runtime 只有下表所列的较窄单机 smoke 证据，部分只能接收。默认检索是词法 FTS5，不是语义召回。实验性表面仍可能变化；生产使用前请看 [Runtime 支持](#runtime-支持)与[局限](#局限limitations)。

如果 agent 重置曾让你返工，欢迎 [Star iHow Memory](https://github.com/iHow1/ihow-memory-core)，让更多开发者找到它，也告诉我们你最需要哪一种交接。

## 接回真实工作

在 `/clear`、新会话或切换到另一个受支持 runtime 后：

```bash
npx ihow-memory continue            # 可选仓库关键词：continue <name>
```

`continue` 会把上一会话叙事标成 **UNVERIFIED**，并交给接收方现场重验机器锚点。GREEN 的条件刻意很窄；一旦有漂移或冲突就强制 RED。首次使用还没有历史会话时，CLI 会直接说明，并引导运行 `proof`，不会再输出一个巨大的空交接包。在 Claude Code 里可直接说“继续”。

### 纠正错误记忆

```bash
npx ihow-memory forget "文字或 memory/path.md"
# 可逆：
npx ihow-memory remember "文字或 memory/path.md"
```

`forget` 只对一个无歧义匹配做 tombstone，让它停止出现在 search 和 recall；原文件不删除，操作可逆且有审计。

## 为什么这种交接不同

1. **先核验，再继续。** 上一位 agent 的状态只是叙事，不是权威事实；现场 git 或文件锚点决定接收方看到 GREEN 还是 RED。
2. **为跨 agent 而生。** Claude Code、Codex、Cursor、WorkBuddy、Claude Desktop、OpenCode、Hermes、OpenClaw、VS Code、Gemini CLI 与 Cline 按下表能力参与。
3. **写入受治理、可检查。** 候选可审阅后 promote；疑似密钥内容会被拒绝；持久记忆带引用与审计事件。
4. **本地且人可读。** 默认核心使用 Markdown + SQLite FTS5；无账号、无必需云服务，遥测默认关闭。

### `setup` 当前接入成熟度

Claude Code 是每日 dogfood 主路径；Codex、OMP、OpenClaw、Hermes、OpenCode、WorkBuddy 完成了单机真机 smoke；Cursor、Claude Desktop、VS Code 因没有可读取的本地会话存储而属于 receiver-only。进入生产假设前请看 [Runtime 支持](#runtime-支持)。

只接一个 runtime，或先查看配置而不直接写入：

```bash
npx ihow-memory connect --runtime claude-code --dry-run
npx ihow-memory connect --runtime claude-code
npx ihow-memory init --runtime claude-code       # 只打印 MCP 片段
npx ihow-memory doctor --runtime claude-code
```

激活状态来自证据，而不是安装成功文案。当前候选中的冻结 CLI 与精确 Claude/Codex Hook 或 OMP 扩展托管接线可以形成有界的本地完成证据，但同一 OS 用户可重放该命令，因此它不是宿主认证。`doctor` 会把这类 runtime 封顶为 **READY — WAITING FOR FIRST ACTIVITY**，reason code 为 `ACTIVATION_COMPLETION_UNATTESTED`。**TOOLS ONLY** 表示只有协作式 MCP 工具，没有可核验的生命周期 Hook；**NEEDS REPAIR** 表示托管接线已经损坏或过期。synthetic probe 和 started-only 事件绝不会升级成 ACTIVE。Ledger 只保存哈希化 binding 与有界元数据，不保存 prompt、transcript、环境变量或错误正文。

### 显式治理闭环

Agent 在 MCP 上使用的是同一路径。下面这段 shell 会把审阅门完整展示出来：

```bash
npx ihow-memory init --space demo
CAND=$(npx ihow-memory write-candidate "Decision: ship weekly release notes." --no-auto-promote --space demo | sed -n 's/.*"path": "\([^"]*\)".*/\1/p')
PROMOTED=$(npx ihow-memory promote "$CAND" --scope team --title "Release notes cadence" --space demo | sed -n 's/.*"path": "\([^"]*\)".*/\1/p')
npx ihow-memory search "release notes" --space demo
npx ihow-memory read "$PROMOTED" --space demo
npx ihow-memory reset --space demo
```

不加 `--no-auto-promote` 时，干净写入可自动晋升到持久 yellow 子档；密钥和伪造锚点仍会被拦截。search/read 会引用确切 Markdown 来源，promote 会生成审计事件。

### 更新与恢复

`connect` 会把运行时副本冻结进 workspace。各 Agent 的 MCP 注册持续使用固定的 `.runtime/mcp/server.js` 路径；Claude Code/Codex Hook 使用字节稳定的 `.runtime/cli.js` 启动器，真正随版本变化的 CLI 实现在 `.runtime/cli-runtime.js`。因此 `npm update` **本身不会**刷新正在运行的 MCP server，更新包后仍需执行 `npx ihow-memory upgrade`，然后重启 runtime。新版会先在旁路构建并校验完整性，再原子交换 `.runtime` 与 `.runtime.previous` 两代目录，随后做 MCP 探活；探活失败会恢复精确的上一代。旧安装第一次迁移到稳定启动器时只刷新一次激活证据，不会改写本来正确的 Hook 文件；此后的普通实现更新不会再改变 Hook 配置或代际。如果某一个 runtime 的注册仍指向已删除/移动的 workspace，可执行例如 `npx ihow-memory upgrade --runtime opencode`，只备份并修复该 runtime。若本地冻结运行时已经损坏，可从目标 workspace 执行独立救援入口 `npx ihow-memory rescue`，必要时再加 `--runtime <name>`。版本偏移或激活接线损坏时，`doctor` 会失败而不是静默放行。

## Runtime 支持

`connect` 为十一个 runtime 生成 MCP 注册配置；`setup` 一条命令接好每个检测到的 runtime，并在 runtime 有指令文件时注入一句「resume 时调用 `memory.continue`」的提示。两个维度要分清：**connect**（runtime 能调用记忆工具）和 **resume reader**（该 runtime 自己过去的会话能被 `memory.continue` 接上）。下表除特别说明外均为单机真机 smoke；这是文档承诺的证据边界。

| Runtime | connect | resume reader | 备注 |
| --- | --- | --- | --- |
| Claude Code | ✓（`claude mcp add-json`） | ✓ | 真机 app smoke + 持续 dogfood；含 skill + Stop / SessionStart / PreCompact / UserPromptSubmit hooks |
| Codex | ✓（`codex mcp add`） | ✓ | 原生 SessionStart / PreCompact / UserPromptSubmit hooks + `~/.codex/AGENTS.md` 主动记忆循环；单机真机 smoke |
| OMP (Oh My Pi) | ✓（`~/.omp/agent/mcp.json`） | ✓（`~/.omp/agent/sessions`） | 托管扩展：启动/提示召回、原生 PreCompact、切换/退出捕获；真机 smoke |
| OpenClaw | ✓（`~/.openclaw/openclaw.json`） | ✓ | 单机真机 smoke（memory.continue + git 预检） |
| Hermes | ✓（`hermes mcp add` + 包内适配器） | ✓（JSON + `state.db`） | 自动安装并启用 lifecycle plugin，选择包内 compaction `MemoryProvider`；单机真机 smoke |
| OpenCode | ✓（`~/.config/opencode`） | ✓（`opencode.db`） | 单机真机 smoke |
| WorkBuddy | ✓（`~/.workbuddy/.mcp.json`） | ✓ | 单机真机 smoke |
| Cursor | ✓（合并 `~/.cursor/mcp.json`） | ✗ | 只能接收——Cursor 把会话存在二进制 IndexedDB 里，无法读取用于 resume |
| Claude Desktop | ✓ | ✗ | 只能接收（聊天 app；没有可 resume 的本地会话） |
| VS Code (Copilot) | ✓（用户级 `mcp.json`，`servers` key） | ✗ | 只能接收——可调用 `memory.search`/`read`/`continue`，但没有可读取的本地会话存储 |
| Gemini CLI | ✓（`~/.gemini/settings.json`） | ✓（`~/.gemini/tmp/*/logs.json`） | 被动读取 Gemini 的磁盘**用户 prompt 日志**（Gemini 不在磁盘记录助手轮）→ 会话主题 + git 锚点；需手动在 `GEMINI.md` 加提示。已对真实本地数据验证 |
| Cline (VS Code) | —（经 Cline 自己的 MCP 设置接入） | ✓（`globalStorage` / `~/.cline/data`） | 被动读取 `tasks/<id>/api_conversation_history.json`；cwd 取自 `environment_details`。已 fixture 测试，尚未真机 smoke |
| DeepSeek Harness（DSH） | 独立 [`dsh-ihow-memory`](https://github.com/iHow1/dsh-ihow-memory) 包 | checkpoint/MCP | 已对官方 `0.1.1-rc.2` Host 做单机 smoke：启动交接、首步召回、轮后观测、原生压缩与不完整 session-end checkpoint；适配器精确锁定 Core |

MCP 工具与治理闭环与 runtime 无关。Claude Code 使用 skill + Stop / SessionStart / PreCompact / UserPromptSubmit hooks；Codex 使用原生 SessionStart / PreCompact / UserPromptSubmit hooks，并由 `~/.codex/AGENTS.md` 提供主动记忆循环。OMP 使用托管扩展接入 `session_start`、`before_agent_start`、原生 PreCompact 与会话切换/退出捕获；其可读 JSONL 会话同时供 `memory.continue` 和 crash-floor sweep 使用。Hermes 的 `connect` / `setup` 会把两类包内适配器安装到 `$HERMES_HOME/plugins`，启用 `ihow-memory`，选择 `memory.provider=ihow-memory-compaction`，并把两者绑定到该 workspace 中经过完整性校验的冻结 bridge；若已配置其他外部 MemoryProvider，会在写入前拒绝覆盖，配置/插件/MCP 任一步失败则回滚本轮变更。预压缩交接保持有界且不含 transcript 原文，但在现场锚点核验前始终明确标为 `UNVERIFIED`，不等于 `ACTIVE` 或宿主认证。Resume 提示会自动注入到配置暴露了指令文件的 runtime（Claude Code、WorkBuddy、OpenClaw、Hermes、OpenCode）。

DeepSeek Harness 支持刻意不进入 `connect` 与 `setup`：独立发布的 `dsh-ihow-memory` Bundle 负责 DSH Profile 安装、MCP 工具挂载和原生 Host 事件监听；Core `0.1.0` 只提供有界 Core 契约与能力证据。发布 Core 不会安装或激活适配器，目标 DSH Profile 必须单独安装并重启。DSH 会话启动复用 verify-first checkpoint/MCP 交接路径；当前 Core 不把 DSH 持久化格式作为原生 transcript source 解析。

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

stdio MCP server（由 `connect` 注册，或通过 `init` 片段手工配置）提供以下工具：

| 工具 | 作用 |
| --- | --- |
| `memory.search` | 用 FTS 检索本地记忆，返回引用路径与片段。 |
| `memory.read` | 按路径读取记忆 Markdown；默认返回有界预览（8,000 字符），同时返回 `truncated`、`originalChars` 和 `next` 提示。只有确实需要完整原文时才传 `mode: "full"`。 |
| `memory.write_candidate` | 记一条记忆。引擎会把带 provenance（证据/锚点）的低风险内容自动晋升为持久记忆；高风险或无证据的内容保留为 candidate。 |
| `memory.promote` | 显式手动把 candidate 升级到受治理的 staging，并记审计事件。 |
| `memory.durable_promote` | 受治理的持久写入，必须显式传 `dryRun: true` 或 `realWrite: true`。 |
| `memory.journal` | 向每日 journal 追加一条低权重、只追加（append-only）的条目（自动捕获通道）；可检索，但排序始终低于受治理记忆。 |
| `memory.forget` | 可逆地隐藏匹配记忆，使其不再参与检索和召回；歧义时不猜测。 |
| `memory.remember` | 撤销 `memory.forget`，恢复记忆的检索与召回资格。 |
| `memory.status` | 报告 workspace、检索 provider、索引与 sync 状态。 |
| `memory.continue` | 返回带实时锚点和 `UNVERIFIED` 既有叙述的 verify-first 接班包。 |
| `memory.organize` | 创建 review-first Safe Memory Gardener 草稿，不改写受治理记忆。 |
| `memory.export_vault` | 将 gardener 草稿导出为带证据链接的 Obsidian 兼容 Markdown 视图。 |
| `memory.context_probe` | 为无原生 hooks 的 Runtime 返回自动化触发探针与协作指引。 |

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
ihow-memory read <path>      默认返回 8,000 字符有界预览；`--max-chars n` 调整预览；`--full` 忽略预览上限并返回逐字完整内容
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
ihow-memory rescue           通过新下载的 npm 包重装并探活冻结 runtime；可选修复一个 runtime 注册
ihow-memory proof            在一次性 space 中跑完整治理闭环证明
ihow-memory benchmark        verify-first 保证的确定性本地证明（三色裁决会判别;地板挡垃圾）——可重跑得同结果
ihow-memory feedback         打印预填的 GitHub issue 与脱敏诊断
ihow-memory reset            删除受管 demo space（必须传 --space）
ihow-memory console          只读本地 Web UI [--port 8788]
ihow-memory telemetry        on | off | status——匿名计数，默认关闭
```

默认值：root 为 `~/.ihow-memory`；space 由当前目录推导，除非显式传 `--space`。完整参数见 `npx ihow-memory --help`。

`console` 在设计上是**只读、仅 loopback、单用户 / 可信机器**的——目前还没有 auth token，所以不要在共享或多用户主机上运行它。

## 排障（Troubleshooting）

- **写入被判为"含密钥"但其实不是。** 写入前检查刻意保守（按 token/key/凭据模式匹配）。改写以去掉像密钥的子串，或干脆别把该值放进记忆。自动捕获是脱敏而非拒绝，所以这只影响手动 `write-candidate` / `promote`。
- **刚写的东西 `search` 搜不到。** FTS 索引在写入时重建；若看起来过期，跑 `npx ihow-memory reindex` 从 Markdown 重建，用 `npx ihow-memory status` 确认索引状态。
- **`doctor` 报 `node:sqlite`。** 需要 Node.js ≥ 22.12（含 `node:sqlite` 的版本），用 `node -v` 检查。
- **装了 hook 但没捕获（Claude Code）。** `install-hook` 后重启 Claude Code 以加载设置。协作式 Stop hook 取决于 agent 是否照提示做；确定式 SessionStart floor 只对「上一会话没有协作式 journal」时才出手（已 journal 的会话会被正确跳过）。用 `npx ihow-memory audit` 看结果。
- **`connect --auto` 跨项目只兜底了一个。** Floor 捕获是单 cwd 的（见局限）。
- **旧 hook 指向已清理的 `npx` 缓存。** 重新运行 `npx ihow-memory setup`（或对该 workspace 运行 `install-hook`）。它只认领结构严格匹配的 iHow entry，把它们迁到 canonical hook group、删除重复 iHow entry，并改指向 workspace 冻结的 `.runtime/cli.js`；第三方 hooks 不会被替换。Hook 参数使用真正的 shell escaping，路径里有空格、引号、`$` 或反引号也能安全执行。
- **已经装过 prompt recall，现在想关闭。** 重新运行 `install-hook --no-recall`（或 `setup --no-recall`）；它会删除 iHow 自己管理的 `UserPromptSubmit` recall entry，同时保留第三方 prompt hooks。
- **setup 刷新了冻结 runtime bundle。** 新 bundle 会写入完整性摘要，先在旁路目录复制和校验，再原子交换 `.runtime` / `.runtime.previous` 两代目录；稳定的 `.runtime/cli.js` 启动器与每个 space 的 `semantic.json` opt-in 会被保留。setup 会诚实要求受影响且已注册的 Runtime reload/restart。如果 Claude/Codex 官方 CLI 的替换 add 失败，会尽量恢复原注册；若回滚也失败，则明确报告真实变更。
- **本地冻结 runtime 已损坏，或者旧升级器本身无法启动。** 在目标 workspace 执行 `npx ihow-memory rescue`；只有某个宿主保存的 MCP 注册也需要修复时，才额外传 `--runtime opencode` 等参数。新版 server 探活失败时，救援流程会继续保留上一代自校验 runtime。
- **Windows。** 请用 WSL；原生 Windows 为实验性。原生安装遇到不安全的 shell 元字符时会 fail closed，而不是生成可能被注入的 hook command。

## 主动记忆（Claude Code，实验性）

自动捕获分两层：

- **会话结束协作式捕获——实验性。** `connect --runtime claude-code --install-hook` 装一个 Stop hook：会话结束时请求在场 agent 通过 `memory.journal` 把一次交接记入低权重 `journal` 通道。它是**尽力而为**（随会话增长重提示、写入一条后即停）、**默认 project-local**（`--global-hook` 用户级）、**可回滚**（`ihow-memory audit` / `rollback`）。
- **下一会话 floor 兜底（确定式）——实验性。** 同一个 `install-hook` 还会装一个 SessionStart hook：新会话启动时，**若上一会话没有协作式 journal**，就确定式地把上一会话兜底——解析其 transcript，在**锁死的范围**内（assistant 文本 + 文件路径 + 命令二进制名 + 首个 prompt；绝不含工具输出、绝不含原始 shell）取“最后实质段”摘要，脱敏后写为一条低权重、可审计、可回滚的 journal 条目。它是协作式提示之下的安全网：**单 cwd**、静默（floor 只捕获、自身不注入任何内容）、永不抛错。已在 22 个真实历史 transcript 上离线评分通过 backstop 质量门；真实的自然 floor 命中仍在 dogfood 中（因为目前协作式捕获覆盖了所有观察到的会话）。

> **实验性、且 Claude Code 优先。** 自动捕获 = 协作式 Stop-hook 提示（是否写入取决于 agent 是否照做）+ 确定式 SessionStart floor 兜底（在提示没被照做时捕获上一会话）。两者都写**低权重、未经审阅**的笔记——可信长期记忆请用 `promote` / `durable-promote`。floor 仅作离线验证过的 backstop，尚未升为 primary/默认权重路径；`recall`（把记忆读回新会话）默认**开启**并以 reviewed 为优先，也会默认召回部分通过 machine gates 的相关 auto soft facts（偏好、配置等）。环境式 status/completion 与危险 behavior-bypass prior 被阻止；显式询问 status 时才会显示对应未验证 status note。输出是无逐条标签的 seamless `<recalled-memory>` reference fence。安装时用 `--no-recall` 跳过；运行时用 `IHOW_RECALL_OFF=1` 关闭；`IHOW_RECALL_AUTO_DEFAULT=0` 恢复 reviewed-only；`IHOW_RECALL_INCLUDE_AUTO=1` 只额外开放 engine-anchored auto，仍不能绕过 behavior gate 或 status-intent gate。完整说明以英文 README 为准。

## Safe Memory Gardener（alpha.24）

Safe Memory Gardener 是一个 review-first 的本地整理/导出路径：

```bash
npx ihow-memory organize --scope project --draft --json
npx ihow-memory export-vault --from-draft <draft_id> --format markdown
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

可直接运行、自包含的演练在 [`examples/`](./examples/)，包括短版 [verify-first handoff 演示](./examples/verify-first-handoff-demo.sh)。所有示例只用合成数据。

## 隐私

- 开源核心在本地运行：无账号、无必需网络调用，cloud 与 sync 处于禁用状态，并在 `status` 和 `doctor` 中如实报告。
- 指标收集**默认关闭**，仅在明确的三选一同意流程或执行 `ihow-memory telemetry on` 后开启。非交互式和 `--json` setup 不会提示，也不会保存同意状态。开启后，只有版本化白名单事件名、随机安装 ID、时间戳以及白名单中的 runtime/error 分类值能进入有界本地队列；记忆、prompt、查询、路径、git 数据、用户名/主机名和硬件标识都不会进入。产品不内置上传端点；只有显式配置无凭据的 HTTP(S) 端点且用户手动执行 `ihow-memory telemetry flush` 时才会发送网络请求。执行 `telemetry off` 会删除队列和安装 ID。详见[指标与隐私契约](docs/telemetry-privacy.md)。
- 诊断输出按设计脱敏，绝不包含记忆内容。`feedback` 只打印模板——是否提交由你决定。

## Hosted runtime

Hosted runtime 不包含在本 npm 包与本仓库中。

## 状态

稳定版候选 `0.1.0`（仅本地达到 release-ready；上方 npm 徽章显示当前已发布版本，详见 [CHANGELOG.md](./CHANGELOG.md)）。包版本身份已稳定，但 runtime 证据边界仍刻意收窄：Claude Code 每日 dogfood，拥有最完整的原生 Hook 路径；Codex 有原生 SessionStart / PreCompact / UserPromptSubmit Hook 与主动 AGENTS 记忆循环；OMP 现有托管生命周期扩展与可读本地会话；Hermes 包含包内 lifecycle 与 compaction 适配器；独立发布的 DSH 适配器已对官方 `0.1.1-rc.2` Host 做单机 smoke；其他 runtime 的较窄证据以 [Runtime 支持](#runtime-支持)为准。Node >= 22.12 是硬性要求（`node:sqlite`）。已在 macOS 与 Linux 验证；原生 Windows 为**实验性**，受支持路径为 WSL。npm 包内含编译后的 CLI、stdio MCP server、只读本地 console、OMP 生命周期扩展、Hermes 包内适配器、DSH Core 契约、隐私契约与 evidence-first 发布资产。实验性表面仍可能变化。

**稳定版 0.1.0 工程细节：** 将已验证的 Alpha.34 表面晋升为稳定包，包括限定到当前项目的 DSH 自动 session-start 与 no-hook 启动交接；显式 `memory.continue` 仍保留跨项目发现。有界 DSH Host API、哈希化激活证据与 `ACTIVATION_COMPLETION_UNATTESTED` 边界保持不变；仅发布 Core 不会安装、更新或激活 `dsh-ihow-memory`。npm `latest` 是稳定包可用性的真相源；`next` 留给未来预发布。

**Alpha.31.2 工程细节：** 让软件包更新具备可恢复性，同时不把用户配置当成版本状态。Claude Code/Codex Hook 固定使用字节稳定的 `.runtime/cli.js` 启动器，随版本变化的实现在 `cli-runtime.js`；一次成功升级只为旧安装刷新一次激活证据，不改写正确的 Hook 文件，此后的普通实现更新不会再改变 Hook 配置或代际。runtime 替换保留两代自校验目录，新 MCP server 探活失败时恢复精确的上一代。`upgrade --runtime <name>` 可对单个过期宿主注册做有边界的修复；若冻结升级器本身已损坏，还可从新下载的软件包运行 `rescue`。Alpha.31.1 的 WorkBuddy 生效路径、Codex 最小权限/事务回滚与零运行时依赖修复继续保留。这里证明的是文档所述更新与救援合同，并不声称所有宿主生命周期都已 `ACTIVE`；在缺少生命周期证据时，`doctor` 仍可能报告 `TOOLS ONLY`、`READY — WAITING FOR FIRST ACTIVITY` 或 `NEEDS REPAIR`。npm `latest` 是稳定包可用性的真相源；发布本身不会更新已经冻结的 runtime，也不代表生产认证。Alpha.31 的 review-first 边界保持不变：持续整理仅 report-only，绝不会自动改写权威记忆；Grounded Media 只输出 `EQUAL_UNTRUSTED`；Activity Ledger 的 `COMMITTED` 不代表任务成功。

**安装与更新。** 新安装使用 `npx ihow-memory setup`。已连接的 workspace 保留冻结 runtime bundle，因此现有安装需运行 `npx ihow-memory upgrade`，然后重启受影响 runtime；冻结升级器损坏时使用 `npx ihow-memory rescue`。发布本身不会替换正在运行的冻结 runtime。

**dist-tag。** `npm install ihow-memory` 解析到稳定 `latest`；未来预发布使用 `next`。稳定 `0.1.0` 已包含确定式 SessionStart floor（单 cwd、低权重、离线验证过）与默认相关召回（reviewed 优先 + 受门控的 auto soft facts；ambient status / behavior-bypass 受阻；seamless fenced reference）。

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

iHow Memory Core 采用 Apache License 2.0——见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)。任何人均可依照该许可证使用、修改、Fork 和商业分发 Core，但必须遵守其条件，包括保留适用的许可证、版权和归属声明，并对修改文件作出显著说明。Apache 许可证不授予 iHow / iHow Memory 名称与 Logo 的使用权，相关边界见 [TRADEMARK.md](./TRADEMARK.md)。

独立分发的 iHow Memory 桌面应用及相关商业服务属于 iHow 的专有产品，不适用 Core 的 Apache-2.0 许可；其中包含的开源组件继续适用各自许可证。
