# taskctl —— 多 Agent 协作的任务编排器

把"靠提示词驱动 LLM 逐轮编排"的试验，换成**编排即数据、执行可隔离、状态可恢复、结果可验证**的形态。

## 为什么需要它

之前让模型自己编排，出现的问题全部同源 —— **编排状态住在 LLM 的头脑与会话历史里**：

| 症状 | 根因 |
|---|---|
| 重复请求时复述上一轮结果，0 次实际执行 | 靠会话历史判断"这事做过没有" |
| 无法回答"任务在跑吗、跑到哪、能否续" | 编排状态没有落盘 |
| 汇总时有时无 | 回合没干净收尾 |
| 提示词写"最多 2 轮"，实测跑了 4 棒 | 循环计数交给模型自律 |
| 不知花了多少、会不会失控 | 没有成本/上限视图 |

taskctl 把控制流搬进代码，LLM 只出现在**边界清晰的单步**里。

## 架构

```
飞书群
  ↓
dispatcher（OpenClaw agent）—— 只做接入适配，不做编排
  ↓ taskctl submit / run / report
taskctl —— 确定性状态机
  ├─ plan   → claude  agent-cli
  ├─ code   → dsh     acp-poll
  ├─ gate   → 外部命令，退出码即证据
  └─ review → codex   agent-cli
  ↓
任务库 ~/.local/state/openclaw-multiagent/tasks/<id>/
```

## 三条传输（为什么必须有三条）

这是**实测得出的硬约束**，不是设计偏好：

> `openclaw agent --agent <id>` **永远不走 ACP**。
> `agentRuntime.id` 的合法取值只有 `"openclaw"` / `"auto"` / 已注册插件 harness id（如 `codex`）
> / CLI 后端别名（如 `claude-cli`）——**没有 ACP 选项**。
> 实测把 `agentRuntime.id` 设为 `"acpx"` 会直接报 `Agent harness runtime "acpx" is unavailable`。
>
> ACP 会话只能由 `sessions_spawn({runtime:"acp"})`、`bindings[].type:"acp"`、`/acp spawn` 产生。

于是三个角色走了三条不同的路：

| 角色 | 传输 | 为什么 |
|---|---|---|
| `plan` | `agent-cli` | claude 配了 `claude-cli/claude-sonnet-5`，复用本机 Claude Code 登录。最稳、少一跳 |
| `review` | `agent-cli` | codex 配了模型级 `agentRuntime.id="codex"`，走原生 Codex app-server harness |
| `code` | `acp-poll` | **DSH 不是可注册 harness**，只能经 ACP 到达。spawn 是异步的，必须轮询 |

### acp-poll 怎么取回结果

`sessions_spawn` 本质异步（`expectsCompletionMessage: true`）：它立即返回 `{status:"accepted", childSessionKey:…}`，
产出要等完成后由 announce 送回 —— 一次性 CLI 调用等不到，实测 `output` 为空。

但结果**不需要**经 LLM 转述。会话库里有确定性事实：

```
session_windows.spawned_by = 发起会话的精确 session_key   ← 据此精确定位子会话
session_windows.status     = done | failed | killed        ← 终态判定
session_transcript_fts     = 逐条转录，role=assistant 的最后一条即产出
```

流程：唯一 key 发起 spawn → 按 `spawned_by` 定位子会话 → 轮询 `status` → 读转录。
**全程不解析 LLM 的自由文本，也不用时间戳猜。**

> ⚠️ 踩过的坑：OpenClaw 会把 session key **规范化为小写**。定位必须用
> `lower(spawned_by) = lower(...)`，且 spawner key 生成时就转小写，
> 否则精确匹配永远失败、管线死等（E2E 测试抓到的真实 bug）。

## 命令

```bash
taskctl submit --message "<请求>" [--repo <路径>] [--max-steps N] [--max-fix N]
taskctl run    <id> [--gate-cmd "<命令>"] [--skip-plan] [--require-evidence]
taskctl step   <id> <plan|code|review> [--force]
taskctl gate   <id> --gate-cmd "<命令>"
taskctl status <id> [--json]
taskctl report <id>
taskctl list   [--active] [--json]
taskctl resume <id>
taskctl cancel <id> [--reason "<文本>"]
```

退出码：`0` 成功 / `1` 失败 / `2` 用法错误 / `3` 任务处于终态或门控跳过

## 数据契约

```
$MA_STATE_ROOT/tasks/<task-id>/          # 默认 ~/.local/state/openclaw-multiagent
  request.json     原始请求、提交人、渠道、仓库
  status.json      phase / stepIndex / attempts / limits / costUsd / error
  steps/<role>/
    prompt.md      送入该角色的完整提示词（自包含）
    output.md      该角色原始输出
    meta.json      agentId / sessionKey / transport / exitCode / durationMs / usage
  verdict.json     gate（退出码即证据）+ review（结构化结论）
  log.jsonl        append-only 结构化日志
```

## 不变量

1. **每次 submit 都新建任务** —— 不复用、不合并，杜绝"凭记忆判断做过"
2. **步骤幂等** —— 已完成即跳过，断点恢复的基础
3. **上限在每步之前检查** —— 步数/墙钟/成本，超限即终止（不由 LLM 决定）
4. **fix 轮次由运行时计数** —— `status.attempts.fix`
5. **审查结论解析失败不进入修复循环** —— fail-safe，不拿垃圾意见反复折腾
6. **"完成"必须有硬证据** —— `--require-evidence` 时无证据即判失败

## 测试

```bash
cd taskctl && npm test        # node --test，17 项
```

覆盖：S1（重复提交不复述）、S2（步骤幂等）、S5（三种上限熔断）、
审查 JSON 解析的 5 种 fail-safe 情形、目录穿越防护、状态迁移与日志。

## 实测记录（2026-10-11）

```
✅ 任务 20261011T041328Z-9999a12c
状态：已完成　步数：3
测试门控：通过（exitCode=0，6ms）
审查结论：无严重问题
步骤：plan(claude/agent-cli, 11s) → code(dsh/acp-poll, 24s) → review(codex/agent-cli, 15s)
```

DSH 真的建了文件、真的 git 提交、真的跑验证；Codex 真的做了审查；门控是真退出码。全程约 50 秒。

## 生产化补充（P2/P3/P4）

### 工作区隔离：每个任务一个 git worktree

接入 `../orchestrator/orchestrator.sh`。实测踩到的三个坑都写进了代码注释：

```zsh
orchestrator.sh new <task> --repo R   # 最后一行 stdout 即 worktree 路径
orchestrator.sh env <task>            # 建 .venv 等隔离环境（**缺了门控就认不出测试套件**）
orchestrator.sh test <task>           # 测试门控，退出码 0 通过 / 4 未过 / 3 前置缺失
```

| 坑 | 现象 | 处置 |
|---|---|---|
| `--repo` 不生效 | 报"当前目录不在 git 仓库内，且未指定 ORCH_REPO" | orchestrator 在**解析命令之前**就有顶层 `ORCH_REPO` 检查 → 必须走环境变量 |
| taskId 被拒 | 只接受 `[a-z0-9-]` | **task 全小写**（与 OpenClaw session key 的小写规范化同类，一并根除） |
| **DSH 在原仓库干活** | 门控在 worktree 跑、代码改在原仓库，两边不是同一处 | `workdir` 优先级修正为 `status.workdir`（供应的 worktree）最优先，且 `--repo` 时不预设默认值 |

环境初始化要**多轮**：`worktree-setup.sh` 有 110s 软件截止，重活写进
`.openclaw/env-setup.pending` 就 exit 0；`orchestrator.sh env` 才会补跑延后项。
循环到 `.venv/bin/python` 出现且 pending 清空为止。

**目标仓库需要自带两个文件**才会启用环境隔离（从 `repo-template/` 复制）：
`.openclaw/worktree-setup.sh`（钩子）与声明 Python/Node/Java 项目的标记文件
（如 `pyproject.toml` / `requirements.txt`；钩子只在有标记时才建 venv）。

### 熔断：用 token 而不是美元

DeepSeek 的 usage 里 `cost.total` 返回 **0**，按价格自算又要求"价格必须来自官方文档"。
所以熔断改用 **token 计数** —— 供应商无关、无需维护价格表：

| 上限 | 默认 | 说明 |
|---|---|---|
| `maxSteps` | 12 | 步数 |
| `maxWallClockSec` | 1800 | 墙钟 |
| `maxTokens` | 2,000,000 | **主熔断** |
| `maxCostUsd` | 5 | 可选：只有配了 `pricing.json` 才生效 |

可选价格表 `${STATE_ROOT}/pricing.json`：
```json
{ "deepseek-v4-pro": { "in": 0.28, "out": 1.10 } }
```
（每百万 token，USD；**请以官方文档为准**，代码不会替你猜。）

### 僵尸会话：不被动等 + 主动清理

中断（runner 重启 / kill / 崩溃）会留下永远 `status='running'` 的 ACP 会话。

| 层 | 手段 | 位置 |
|---|---|---|
| 防守 | 三重退出：终态 / `MA_CHILD_WAIT_SEC=45` 未出现 / `MA_ZOMBIE_STALE_SEC=150` 无推进 | `lib/transport.mjs` |
| 治理 | 主动回收久未更新的 running 会话（**默认 dry-run**） | `bin/reap.mjs` |

### 检查入口

```bash
make check   # 提交前必过：单测 21 + 编排 eval 8，不依赖外部服务
make audit   # 链路配置自检 27 项（需 OpenClaw 在跑）
make reap    # 列出僵尸会话（dry-run）
```

**eval 验的是编排逻辑，不是模型质量** —— 用桩传输注入（`opts.__dispatch` / `opts.__gate`），
毫秒级、零成本、完全确定。它已经抓到一个真实 bug：**第二轮 `review` 被幂等跳过**，
导致一直读到旧的失败结论、陷入"修 → 跳过审查 → 又判失败"的死循环。同类问题在 `code`
上修过一次，`review` 上同样存在 —— 这类 bug 靠人工读代码很难发现。

## 待办

- **P4 文档**：主 `README.md` 仍是最初的设计描述，需重写（含实测修正）
- **未解决**：`deepseek-flash` 缺 model metadata —— 在 OpenClaw 内置 catalog 里找不到权威条目，
  按"不凭记忆填"的原则留空。`deepseek-v4-pro` 已补（`contextWindow=262144`，来自内置 catalog）
- **未解决**：`Subagent terminal signal owner changed` 偶发，属上游状态记录竞态
- **可选**：Lobster 需 OpenClaw ≥2026.10.1（当前 2026.9.9），审批门待自研补足

