# OpenClaw 多智能体开发编排系统

本方案让本机的多个编码 agent 在同一个飞书群里按角色协作。

> **⚠️ 首次阅读先看这里（2026-10-10 起）**
>
> 这份 README 的**前半部分**记录的是最初的设计与调研结论，其中角色分工的形态
> **已被实测推翻并改写**。当前真实运行的架构如下，以
> `config/topology.json5`（**由线上配置自动生成**）为准。

## 当前真实架构

```
飞书群
  ↓ bindings 路由
dispatcher  ← 编排者。embedded 运行时 + deepseek/deepseek-v4-pro
  ├─ sessions_spawn(runtime:"acp", agentId:"dsh")    → DSH   编码
  ├─ sessions_spawn(runtime:"acp", agentId:"codex")  → Codex 审查
  └─ sessions_spawn(runtime:"acp", agentId:"claude") → Claude Code 规划
```

| agent | 运行时 | 模型 | 职责 |
|---|---|---|---|
| `dispatcher` | embedded | `deepseek/deepseek-v4-pro` | **编排**：拆解请求、派活、汇总 |
| `dsh` | ACP（acpx 自定义别名） | 由 DSH 自报 `dsh-acp` | 写代码 |
| `codex` | ACP（acpx 内置别名） | 由 Codex 自报 `codex-acp` | 代码审查 |
| `claude` | ACP（acpx 内置别名） | Claude Code 自身配置（→ DeepSeek） | 方案规划 |
| `main` | embedded | `deepseek/deepseek-v4-pro` | 环境/系统通道 |

### 为什么编排者是 embedded agent，而不是 Claude Code

这是硬约束，不是选择：

- 在 OpenClaw 里，**只有 embedded 运行时的 agent 才持有 `sessions_spawn` 等内建工具**。
- CLI 后端（`claude-cli`）与 ACP harness 都是**外部进程**，OpenClaw 的工具注入不进去：
  - CLI 后端需要 `bundleMcp: true` 才有一座 loopback MCP 桥；
  - ACP harness 的 `openClawToolsMcpBridge` **目前只暴露 `cron`**，没有 `sessions_spawn`。
- `models.providers.anthropic` 等 provider 层**不解决**这个问题 —— 它决定"用哪个模型"，不决定"谁持有工具循环"。

所以原名"Planner = Claude Code"的设计无法成立。**编排能力转移给了 dispatcher（deepseek-v4-pro）**，
Claude Code 降为可被调用的规划 worker。

### 几个关键配置事实（均为实测）

| 事实 | 说明 |
|---|---|
| `bindings[].type:"acp"` 与会话扇出**互斥** | `isGroupThreadRouteExclusive()` 直接短路，ACP 绑定后群里所有消息归该 agent，`@DSH` 也会被它接走 |
| `agents.entries.*.runtime.type:"acp"` **不会**让频道消息走 ACP | 它只是 ACP **会话**的默认值；要让 agent 在频道里走 ACP 必须用 `bindings[].type:"acp"` |
| agent 级 `runtime` 块与模型级 `agentRuntime` **冲突** | 同时存在会让模型解析回落到目录默认值（曾导致 `gpt-6-astra` 报错） |
| `channels.feishu` 是**闭集**，没有 `mentionPatterns` | `@Claude` / `@DSH` 的选择由核心的 `broadcast.mentionGating` 扫**正文**完成，来源是 `agents.entries.*.groupChat.mentionPatterns` |
| 飞书 @ 检测用**原生 mention 元数据** | 插件只用 `event.is_mentioned` + `botOpenId`；三个 agent 共用同一个机器人身份，飞书层面区分不出 `@Claude` 和 `@DSH` |
| `channels.feishu.replyInThread: "enabled"` 会**每个话题占一条会话记录** | 已改为 `disabled`，回复落回群消息流 |
| 模型可用性走 `models.providers.deepseek` | `apiKey` 用 SecretRef（`{source:"env",provider:"default",id:"DEEPSEEK_API_KEY"}`），密钥不进仓库 |

配套一个编排器，负责 **Git 工作树隔离 → 多语言依赖隔离 → 测试门控 → 双模式合并 → 清理**。

---

## 关于 `topology.json5`：它已改为「快照」而非「期望状态」

**这是本仓库最重要的一个变化，动手前必须理解。**

原先 `topology.json5` 是手工维护的期望状态，`apply-topology.sh` 把它合并进 `openclaw.json`。
排障期间配置被大量调整，手工文件很快就不代表现实 —— 此时重跑 `apply-topology.sh`
会**把线上的真实成果覆盖掉**（dispatcher、deepseek provider、群路由、渠道修复全部丢失）。

现在改为：

```bash
cd config
./refresh-topology.sh          # 从 ~/.openclaw/openclaw.json 生成快照（网关须停）
./refresh-topology.sh --force  # 网关在跑也照办
```

- `topology.json5` = **线上配置的只读快照**，自动生成，**请勿手工编辑**。
- 密钥类字段（`appSecret`、`appId`、真实 chat_id / open_id）生成时替换为占位符，可安全提交。
- **`apiKey` 的 SecretRef 对象会被原样保留** —— 它本身不含密钥，替换掉反而会产生非法值。
- `apply-topology.sh` 仍可用，但它的输入始终等于线上现状，重跑变成幂等的，不再有破坏性。
- 改配置请用 `openclaw config set`，改完再跑一次 `refresh-topology.sh`。

---

## 这套东西建立在哪些已核实的事实上

全部键名与行为取自**本机 OpenClaw 2026.9.9 (bcfc888)** 的官方文档与
`openclaw config schema`（2.4MB JSON Schema，`additionalProperties: false` 的子树即闭集）。
没有臆造字段。几个决定设计走向的关键事实：

| 事实 | 出处 |
|---|---|
| OpenClaw 有**原生托管工作树**，macOS 走 APFS 目录克隆 | `docs/concepts/managed-worktrees.md:11,50` |
| 工作树路径是 `<worktreeRoot>/<repo-fingerprint>/<name>`，分支 `openclaw/<name>` | 同上 `:135-143` |
| 托管工作树里 **Git hooks 被禁用**，所以合并门不能靠 husky/pre-commit | 同上 `:223,483` |
| 唯一的仓库级钩子是 `.openclaw/worktree-setup.sh`，**120s 超时，非零退出会删掉工作树** | 同上 `:182-191` |
| DSH 自带 ACP stdio 服务端（`dsh acp`），但**不在 acpx 内置别名表里** | `dsh acp --help`；OpenClaw 别名表 `docs/tools/acp-agents-setup.md:28-57` |
| acpx 支持自定义别名：`plugins.entries.acpx.config.agents.<id>.{command,args}` | 同上 `:270-294` |
| ACP 非交互会话默认 `approve-reads` + `nonInteractivePermissions=fail`，**写操作直接失败** | 同上 `:407-442` |
| 飞书**只**认 `channels.defaults.botLoopProtection`，无更窄覆盖 | `docs/channels/bot-loop-protection.md:31,114` |
| 飞书**没有** `mentionPatterns` 频道键（闭集）；多 agent 同群靠顶层 `broadcast` | schema + `docs/channels/broadcast-groups.md:18` |
| `agents.entries.*.default` 已退役；多智能体必须靠 `bindings` 路由 | `docs/gateway/config-agents/entries-and-multi-agent.md:76` |
| 被退休的是 `agentRuntime`；ACP 用的 `runtime.type:"acp"` 是**现行键** | 实测：`openclaw config validate` 通过且 `config get` 保留 |
| 无任何内置的「测试通过才许合并」门 | schema 全量遍历无相关键 |

---

## 目录结构

```
openclaw-multiagent/
├── config/
│   ├── topology.json5        # 线上配置快照（自动生成，勿手工编辑）
│   ├── refresh-topology.sh   # 从 ~/.openclaw/openclaw.json 重新生成上面的快照
│   ├── apply-topology.sh     # 幂等合并进 ~/.openclaw/openclaw.json（备份+校验+回滚）
├── orchestrator/
│   └── orchestrator.sh       # 编排器：工作树 / 环境 / 门控 / 合并 / 清理
├── repo-template/            # 拷进你的业务仓库
│   ├── .openclaw/worktree-setup.sh   # 每个工作树的语言级依赖隔离
│   └── .worktreeinclude              # 需要带进工作树的 ignored 文件
└── docs/
    └── feishu-setup.md       # 飞书开发者控制台分步指南
```

---

## 快速开始

### 1. 装两个官方插件

```zsh
export PATH="$HOME/bin:$PATH"                       # 钉住 node26 的 openclaw shim
openclaw plugins install @openclaw/acpx
openclaw plugins install @openclaw/feishu
```

> 走 npmmirror 时如果慢到无法接受，加 `--registry`：
> 本机实测 `registry.npmmirror.com` 96 B/s、`registry.npmjs.org` 1.11 MB/s
> （因为全隧道 WireGuard 出口在洛杉矶，国内源反而绕远）。

### 2. 落配置

```zsh
cd config
export FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx FEISHU_CHAT_ID=oc_xxx
./apply-topology.sh --dry-run    # 先看
./apply-topology.sh              # 再写（自动备份 + 校验 + 失败回滚）
```

### 3. 把仓库模板装进你的业务仓库

```zsh
cp -r repo-template/.openclaw  /path/to/your-repo/
cp    repo-template/.worktreeinclude /path/to/your-repo/
chmod +x /path/to/your-repo/.openclaw/worktree-setup.sh
# 记得把 .openclaw/ 和 .worktreeinclude 提交进仓库
```

### 4. 跑一个任务

```zsh
cd /path/to/your-repo
ORCH=~/dsh-playgroud/openclaw-multiagent/orchestrator/orchestrator.sh

$ORCH new t1 --agent coder     # 分配隔离工作树 + 装依赖
$ORCH test t1                  # 测试门控
$ORCH merge t1 --as ai         # 门控通过才合并
$ORCH clean t1                 # 清理（托管模式保留可恢复快照）
```

---

## 编排器命令

| 命令 | 作用 |
|---|---|
| `new <task> [--repo R] [--base REF] [--layout managed\|inrepo] [--agent NAME]` | 分配隔离工作树并初始化环境 |
| `env <task>` | 重新初始化/补跑环境（无软截止） |
| `test <task>` | 跑测试门控，写出通行证 |
| `gate <task>` | 查看门控状态并校验是否仍有效 |
| `merge <task> [--as ai\|human] [--push] [--force-gate]` | 双模式合并 |
| `clean <task> [--force]` | 清理工作树 |
| `gc` | `openclaw worktrees gc` + `git worktree prune` + 清理陈旧 index.lock |
| `list` / `status <task>` | 查看 |

**分层退出码**（便于上层脚本区分「拒绝」与「故障」）：

```
0 成功   2 用法错   3 前置缺失   4 门控未过   5 Git 冲突   6 锁竞争超时
```

### 两种工作树布局

- **`--layout managed`（默认，推荐）**：用 `openclaw worktrees create`。
  位置 `<worktreeRoot>/<repo-fingerprint>/<name>`，分支 `openclaw/<name>`，
  macOS 上走 APFS 写时复制克隆（省磁盘），删除前自动打快照、30 天内可 restore，
  每小时 GC + 7 天空闲回收 + 100 个上限。
- **`--layout inrepo`**：回退到 `git worktree add`，位置
  `<repo>/.agents/worktree_<task_id>`（你原始规格里的可预测子目录），分支 `agent/<task>`。

> 为什么默认不是仓库内布局：OpenClaw 的设计是"不把临时目录放进源仓库"
> （`managed-worktrees.md:11`）。仓库内布局会污染 `git status`、被误提交、
> 也让 IDE 索引变慢。需要时用 `--layout inrepo` 切回去。

---

## 隔离层怎么做

### Git 隔离

每个活跃编码智能体一个独立工作树，物理隔离，互不干扰。

### 语言级依赖隔离（`.openclaw/worktree-setup.sh`）

| 语言 | 做法 | 磁盘效率手段 |
|---|---|---|
| Python | 工作树内 `.venv`（`python3 -m venv`） | `PIP_CACHE_DIR` 指向全局 wheel 缓存 |
| Node | `pnpm install`，依赖落在工作树自己的 `node_modules` | `--store-dir` 指全局 store，硬链接共享包体 |
| Java | `-Dmaven.repo.local=<工作树>/.m2_local` | `-Dmaven.repo.local.tail` 链到共享 `~/.m2/repository`，既避开并发写锁又不重复下载 |
| Rust / Go | 直接用 `CARGO_HOME` / `GOMODCACHE` | 天然跨工作树共享 |

**两个关键设计约束**：

1. **120s 硬超时**：OpenClaw 只给 setup 钩子 120 秒，超时算失败，
   而**非零退出会连工作树带分支一起删掉**。所以脚本设了 110s 软截止：
   重活开始前检查耗时，超预算就把待办写进 `.openclaw/env-setup.pending` 并**返回 0**。
   **绝不因为网慢就让工作树创建失败。** 编排器的 `env` 命令随后无截止补跑。

2. **测试运行器补齐**：门控要跑 pytest，但很多项目不把它列为运行依赖。
   脚本会幂等补装（`ENV_SETUP_SKIP_TEST_TOOLS=1` 可关）。

---

## 测试门控：为什么绑「内容指纹」而不是 HEAD

这是实现过程中发现并修掉的一个**真实绕过漏洞**：

> 只比对 HEAD 时，agent 可以在测试通过之后继续改文件但**不提交**。
> 此时 HEAD 没变，门控记录看起来依然有效，改动的代码却被放行合并 —— **测试等于没跑**。

所以门控绑的是**工作区内容指纹** `<HEAD>:<工作区 tree sha>`。
指纹用临时索引跑 `git add -A` + `git write-tree` 得到（不动用户真正的索引），
因此覆盖了已跟踪文件的修改**和**未跟踪文件的内容。

通行证长这样：

```json
{
  "task_id": "t1",
  "head_sha": "09ca0e2452...",
  "fingerprint": "09ca0e2452...:3fdd26caa4...",
  "test_cmd": ".venv/bin/python -m pytest -q",
  "exit_code": 0,
  "passed": true,
  "summary": "1 passed in 0.00s",
  "policy": "exit_code==0 means 100% pass; fingerprint 必须与合并时一致"
}
```

**100% 通过**的判定 = 测试套件退出码为 0。合并前会重新计算指纹，
与通行证不一致就拒绝，并提示重跑 `test`。

---

## 双模式合并

| 模式 | 入口 | 门控 |
|---|---|---|
| **AI 自动合并** | `merge <task> --as ai` | 必须门控通过 + 指纹一致 |
| **人工干预合并** | `merge <task> --as human`（对应群里的 `/merge <task>`） | 同上 |

人工模式额外提供逃生阀 `--force-gate`，但：

- **只允许** `--as human` 搭配使用（`--as ai --force-gate` 直接判用法错，退出码 2）；
- 会打印醒目的 `⚠ --force-gate：...` 告警并写进任务记录，事后可审计。

合并前的前置检查：

1. 门控记录存在、`passed=true`、指纹一致；
2. 目标仓库**必须干净**（有未提交改动就拒绝，避免污染）；
3. 目标分支 ≠ 工作树分支；
4. 工作树里未提交的产出自动提交为一个 commit，
   **并显式排除** `.venv` / `node_modules` / `.m2_local` / `.agents`
   —— 不依赖项目自己的 `.gitignore`，否则整个虚拟环境会被提交进历史。

冲突处理：真冲突（`CONFLICT` / `Merge conflict`）**立即停下**、`merge --abort`、返回退出码 5；
而 `index.lock` / `another git process` 这类**瞬时锁竞争**走指数退避重试（默认 5 次）。

---

## 机器人循环保护（防 token 失控）

三道独立的闸，别混：

1. **飞书 bot 对闸**（`channels.defaults.botLoopProtection`）
   滑动窗口按参与者对计数，A→B 与 B→A 算同一对；超预算进入冷却期抑制。
   本拓扑收紧到 10 次 / 60s，冷却 120s。**只影响 bot 之间，不影响人类消息。**

2. **群聊协调器预算**（`broadcast`）
   `maxRounds: 2`（含首轮，上限 4）、`maxTurns: 6`（上限 32）。
   槽位在并行派发**之前**就预留，防止"agent 互相追问"形成回环。

3. **单 agent 内部工具循环**（`tools.loopDetection.enabled`）

另外 `tools.agentToAgent.allow` 收窄到本拓扑三个 id
（默认是全体互通，多智能体同机上等于任何 agent 都能读别人的会话）。

---

## 已验证 / 未验证

### 实测通过的

```
插件安装       @openclaw/acpx（ClawHub）+ @openclaw/feishu（npm）均 installed/enabled
DSH ACP 服务端 直接起 `dsh acp` 发 initialize：protocolVersion=1、
               agentInfo.name=deepseek-harness-acp、sessionCapabilities=[close,list,resume]
OpenClaw 拉起 DSH（★端到端）
               sessions_spawn({runtime:"acp", agentId:"dsh"}) →
               子会话 agent:dsh:acp:f360e57f-… 返回原文：
               「我是 DeepSeek Harness（DSH）驱动的编码 agent，当前由 deepseek-v4-flash 模型运行。」
               `openclaw sessions --agent dsh` 显示 Model=dsh-acp / Runtime=acpx / classification=acp
acpx 配置 schema 从已安装插件 manifest 读出：agents.<id> = {command(必填), args}，
               additionalProperties:false（**没有** per-agent env/cwd）
工作树分配     managed 布局 → /Users/ray/.openclaw/worktrees/<fingerprint>/t5，分支 openclaw/t5
               inrepo 布局 → <repo>/.agents/worktree_t1，分支 agent/t1
环境隔离       python3 -m venv 在工作树内创建，.venv 隔离，复用全局 pip 缓存
幂等性         OpenClaw 创建时自己跑了 setup 钩子，编排器复跑命中"复用已有 .venv"
测试门控       1 passed → PASS；故意加失败用例 → 退出码 4，合并被拒
门控防绕过     test 通过后改文件不提交 → 指纹变化，合并被拒（HEAD 未变也能抓到）
AI 合并        agent/t1 → main 成功，产物进入 main，.venv 未被提交
人工合并       --as human 成功；--as ai --force-gate 被判用法错（退出码 2）
合并前置       目标仓库脏 → 拒绝
Git 锁重试     指数退避重试已实现（真冲突不重试，直接返回 5）
清理           managed 走 OpenClaw 快照路径（需 UUID）；inrepo 走 git worktree remove + prune
gc             openclaw worktrees gc + git worktree prune
配置校验       topology.json5 合并后 openclaw config validate = Config valid
```

### 打通 DSH ACP 路上踩到的四个坑（都已实测定位）

| # | 现象 | 根因 | 处理 |
|---|---|---|---|
| 1 | `No route-compatible authentication source is configured for openai` | 本机**没有任何云端模型凭据**，agent 无 model 时默认解析到 `openai/gpt-6-astra` 并走 embedded 运行时，连 `/acp` 命令都进不去 | 用内置 `claude-cli` 后端复用 Claude Code 本地登录：`openclaw agent --model claude-cli/claude-sonnet-5` |
| 2 | `runtime="acp" is unavailable because the requester does not allow apply_patch` | ACP 有三个前置校验（`dist/subagent-capabilities`）：继承的 allow 列表若**非空**必须逐字含 `apply_patch, edit, exec, process, read, write`；而 `tools.profile` 派生的 allow 是**组记号**（`group:fs`），匹配器不展开组 | **移除 `tools.profile`**，改用 `tools.alsoAllow` 显式列出那六个工具名。实测：保留 profile 时补 `alsoAllow` 也无效 |
| 3 | `spawn_failed: mcp-client(openclaw-plugin-tools): initial connection or tool synchronization failed` | 我在拓扑里开了 `pluginToolsMcpBridge: true`（文档说默认关） | 改回 `false` |
| 4 | `Unknown agent id "dsh"` | **agent id 必须与 harness id 同名**——OpenClaw 用 `agent:<agentId>:acp:<uuid>` 建会话键，会把 harness id 当 agent id 校验。官方 ACP 示例里 `agents.entries.codex` + `runtime.acp.agent="codex"` 正是同名 | agent id 改用 harness 名（`claude`/`dsh`/`codex`），角色显示名放 `name`，`@coder` 这类角色提及靠 `groupChat.mentionPatterns` 正则，照样生效 |

> 另一个反直觉点：`agents.entries.*.runtime.type="acp"` **不会**改变该 agent **主会话**的运行时
> （`sessions.list` 里 `agentRuntime.id` 仍是隐式的 `codex`）。它只提供 ACP 会话的默认值，
> 真正走 ACP 必须显式 `sessions_spawn({runtime:"acp"})` 或用 `bindings[].type="acp"`。

### 未验证 / 需要你确认的

| 项 | 状态 | 怎么确认 |
|---|---|---|
| planner(`claude`) / reviewer(`codex`) 的 ACP 派发 | **未跑通** | 报 `Unknown agent id "claude"` / `"codex"` —— acpx 本机只注册了 `dsh` 别名，内置 claude/codex 适配器未落到 registry。需在 `plugins.entries.acpx.config.agents` 里显式给它们配 `command`/`args`（适配器由 npx 自动下载，具体命令未核实） |
| 飞书渠道 | **未接** | 应用尚未在飞书开放平台创建。按 `docs/feishu-setup.md` 建应用后跑 `apply-topology.sh`（去掉 `--skip-feishu`） |
| 飞书插件是否消费 `groupChat.mentionPatterns` | **文档未提及** | 接好后在群里 @coder 观察；不生效则改用 Planner 统一派活 |
| Java 路径（mvn / repo.local.tail） | **未实测** | 本机没装 `mvn`，只在代码里实现 |
| 飞书控制台的具体点击路径与完整 scope 清单 | **文档未提及** | 跑 `feishu_app_scopes` 工具诊断 |

### 已知限制

- **`remove` 只认 UUID，不认 `--name` 创建时的名字**（编排器已处理：创建时存 `managed_id`，
  清理时用它，并留了按路径反查的兜底）。
- **`/merge` 不是内置命令**，飞书也没有 `customCommands`。要变成真正的确定性命令，
  需写一个小插件用 `api.registerCommand()` 注册，再 shell 出去调编排器。
  在做好之前，人工合并走 `merge <task> --as human`。
- **托管工作树里 Git hooks 被禁用**，所以合并门只能放在外层（本编排器），
  靠 husky/pre-commit 是拦不住的。
- `permissionMode: "approve-all"` 会放开三个 CLI 的写/执行权限。
  这是「自动写代码」的固有代价；要收紧就改成 `approve-reads` +
  `nonInteractivePermissions: "deny"`，代价是写操作会被拒绝而不是崩溃。

---

## 已知坑

### 坑 1：直接改 `openclaw.json` 与「网关在跑」会分叉（本项目踩过）

**症状**：跑 `openclaw channels login --channel feishu` 到最后一步报

```
Channel login failed: Config write would drop agent roster entries without an explicit deletion: coder, planner, reviewer.
```

**机制**（读 `dist/io.write-prepare-*.mjs` 的 `assertCanonicalAgentRosterRetainsEntries` 得到）：

OpenClaw 的配置写入管线有一条 roster 守卫 —— 任何「会丢掉现有 agent」的写入都被拒绝，
除非是显式的单 agent 删除（`allowedAgentRosterRemovals: [agentId]`）。
守卫比对的是**管线里的 canonical roster**，不是磁盘文件里的 roster。

本项目的 `apply-topology.sh` 用 node **直接写文件**，绕过了这条管线和它背后的持久化视图。
于是分叉：文件里有 `planner/coder/reviewer`，管线不认得。之后任何**经管线**的写入
（`channels login` 要装 `@openclaw/feishu` 插件，会改 `plugins.entries`）就撞上守卫。

有 Gateway 在跑时，CLI 的配置写入是**经 Gateway** 的（CLI 自己的报错写得很直白：
"To write another local store intentionally, stop the running Gateway first"），
用的是 Gateway 的运行时配置，分叉更容易发生。

**正确顺序**（脚本已加前置检查强制这一点，不加 `--force-gateway` 会被拦下）：

```zsh
openclaw gateway stop
./apply-topology.sh          # 直接写文件
openclaw gateway start       # 让 Gateway 重新加载，消除分叉
```

**如果不想停网关**：`openclaw config set` 这条路**不会**触发守卫
（实测：在同一份出问题的配置上逐条写 `channels.feishu.*`，roster 完好、无报错）。
代价是每个键要自己敲，白名单群得用
`openclaw config set channels.feishu.groups.oc_xxx.enabled true` 这种嵌套路径。

### 坑 2：门控只绑 HEAD 会被绕过

见上文「测试门控」一节。已改为绑定工作区内容指纹。

### 坑 3：zsh 与 bash 的语法差异

所有脚本用 `#!/bin/zsh`。写的时候踩到四个 bash 能过、zsh 不过的写法：

| 写法 | zsh 行为 |
|---|---|
| `foo() {  # 注释` | 注释吞掉换行分隔符 → `parse error` |
| `cmd \` + 换行 + `&& cmd2` | 解析失败（bash 允许） |
| 循环内重复 `local a b` | 会**打印变量值**，污染输出 |
| `"$(cmd "$x")..$(cmd2 "$y")"` | 双引号内嵌多层 `$()` 再套单引号 → `unmatched "` |

### 坑 4：`git add` 的排除路径规格

`git add -A -- . ':(exclude).venv'` 在 `.venv` **同时被项目 `.gitignore` 忽略**时会直接报错
（"The following paths are ignored by one of your .gitignore files"）。
一旦这个 add 失败，指纹计算的 `git write-tree` 会产出错误/空树 ——
**不同内容得到相同指纹，门控再次失效**。
现改为把隔离目录写进 `.git/info/exclude`，用普通 `git add`，
并且指纹函数硬校验退出码（失败即 fail-closed）。

---

## 回滚

```zsh
# 1) 配置回滚：apply-topology.sh 每次都会打印备份路径
cp <备份文件> ~/.openclaw/openclaw.json
openclaw config validate

# 2) 卸插件
openclaw plugins uninstall @openclaw/feishu
openclaw plugins uninstall @openclaw/acpx

# 3) 业务仓库里的东西
rm -rf /path/to/your-repo/.openclaw /path/to/your-repo/.worktreeinclude
rm -rf /path/to/your-repo/.agents
git -C /path/to/your-repo worktree prune

# 4) 托管工作树
openclaw worktrees list          # 拿 id
openclaw worktrees remove <id>
```
