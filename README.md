# OpenClaw 多 Agent 协作系统

在飞书群里说一句话，系统自动把任务拆解、派给不同的编码 agent 执行、跑测试门控、审查，
最后把结果发回群里。每个任务在**独立的 git worktree** 里跑，互不干扰。

```
你：@机器人 在 calc.py 里加个 multiply 函数，补个测试
  ↓ 5 秒
机器人：已提交，任务 ID 是 20261011t054611z-b4516986，完成后会自动通知你
  ↓ 约 1 分钟
机器人：✅ 任务已完成　测试门控：通过（2 passed）　审查结论：无严重问题
```

---

## 当前状态（截至 2026-10-11）

| 项 | 状态 |
|---|---|
| 飞书端到端 | ✅ 已验证（回执 + 结果两条消息） |
| Worktree 隔离 | ✅ 已验证（`~/.openclaw-worktrees/<fp>/<task>`，独立分支） |
| 多语言环境隔离 | ✅ 已验证（`.venv` 由 worktree 钩子创建） |
| 测试门控 | ✅ 已验证（pytest，绑定 HEAD，fail-closed） |
| 单元测试 | 21/21 |
| 编排 eval | 8/8（确定性、零 LLM 成本） |
| 链路审计 | 27/27 |

---

## 架构

```
┌─ 接入面 ─────────────────────────────────────────────┐
│ 飞书群 → dispatcher（OpenClaw agent，无状态）          │
│   只做一件事：把用户的话变成任务，秒级回执              │
└──────────────────────┬───────────────────────────────┘
                       ↓ taskctl submit
┌─ 编排面（确定性，即代码）─────────────────────────────┐
│ taskctl engine —— 状态机，控制流不经 LLM               │
│   provisioning → plan → code → test → review →(fix)*  │
└──────────────────────┬───────────────────────────────┘
                       ↓
┌─ 执行面（隔离）──────────────────────────────────────┐
│ runner（常驻进程，不在任何 exec 里）                    │
│   每个任务 → 独立 worktree + 独立 .venv                │
│   角色传输：plan=claude/agent-cli  code=dsh/acp-poll   │
│             review=codex/agent-cli                     │
│   gate → orchestrator.sh test（pytest，绑定 HEAD）      │
└──────────────────────┬───────────────────────────────┘
                       ↓
┌─ 状态面（唯一事实源）────────────────────────────────┐
│ ~/.local/state/openclaw-multiagent/tasks/<task-id>/   │
│   request.json · status.json · steps/ · verdict.json  │
│   artifacts/workspace.json · log.jsonl                │
└──────────────────────────────────────────────────────┘
```

**核心原则：编排是代码，不是提示词。** LLM 只出现在边界清晰的单步里（写代码、审查、规划）。

---

## 为什么是这个形态（都是实测逼出来的）

### 为什么 dispatcher 不自己跑管线

| 如果让 agent 自己跑 | 实测后果 |
|---|---|
| `taskctl run` 在 agent 的 exec 里阻塞 1–3 分钟 | 飞书渠道有 **per-chat 300s 上限**，超时被驱逐 |
| exec 子进程里嵌套调用 `openclaw agent` | **不通** —— 不产出会话、不产出子进程，静默卡死 |
| 同一次调用要回调正在阻塞的那个 agent | **死锁** |
| 靠会话历史判断"这事做过没有" | 复述旧结果，**0 次实际执行**（22:38/22:40 实测） |

### 为什么有三条传输

> `openclaw agent --agent <id>` **永远不走 ACP**。`agentRuntime.id` 的合法取值只有
> `"openclaw"` / `"auto"` / 已注册插件 harness id（如 `codex`）/ CLI 后端别名（如 `claude-cli`）
> ——**没有 ACP 选项**。实测把 `agentRuntime.id` 设为 `"acpx"` 直接报
> `Agent harness runtime "acpx" is unavailable`。
>
> ACP 会话只能由 `sessions_spawn({runtime:"acp"})`、`bindings[].type:"acp"`、`/acp spawn` 产生。

| 角色 | 传输 | 为什么 |
|---|---|---|
| `plan` | `agent-cli` | claude 配 `claude-cli/claude-sonnet-5`，复用本机 Claude Code 登录 |
| `review` | `agent-cli` | codex 配模型级 `agentRuntime.id="codex"`，走原生 Codex app-server harness |
| `code` | `acp-poll` | **DSH 不是可注册 harness**，只能经 ACP；spawn 是异步的，必须轮询 |

### `acp-poll` 怎么取回结果

`sessions_spawn` 本质异步（`expectsCompletionMessage: true`）：立即返回
`{status:"accepted", childSessionKey:…}`，产出要等完成后由 announce 送回 —— 一次性
CLI 调用等不到（实测 `output` 为空）。

但结果**不需要**经 LLM 转述。会话库里有确定性事实：

```
session_windows.spawned_by = 发起会话的精确 session_key   ← 精确定位子会话
session_windows.status     = done | failed | killed        ← 终态判定
session_transcript_fts     = 逐条转录，assistant 最后一条即产出
```

---

## 目录结构

```
openclaw-multiagent/
├── taskctl/                    # 编排器（核心，2683 行）
│   ├── index.mjs               # CLI：submit/run/step/gate/status/report/list/resume/cancel
│   ├── lib/
│   │   ├── store.mjs           # 任务库：原子写、append-only 日志、熔断、幂等
│   │   ├── transport.mjs       # 三条传输 + 用量提取 + 僵尸死亡判定
│   │   ├── roles.mjs           # 三角色提示词 + 审查 JSON 解析（fail-safe）
│   │   ├── engine.mjs          # 确定性状态机
│   │   ├── workspace.mjs       # worktree 供应 + 环境初始化 + 测试门控
│   │   └── report.mjs          # 汇总生成
│   ├── bin/
│   │   ├── runner.mjs          # 异步执行器（launchd 常驻）
│   │   ├── audit.mjs           # 链路自检 27 项
│   │   └── reap.mjs            # 僵尸会话回收（默认 dry-run）
│   ├── test/                   # 21 项单测
│   ├── test/eval/              # 8 项编排 eval（桩传输，零成本）
│   └── Makefile                # make check / audit / reap / smoke
├── orchestrator/orchestrator.sh # worktree 池 + 环境隔离 + 测试门控 + 双模式合并
├── repo-template/              # 放到目标仓库里启用环境隔离
│   ├── .openclaw/worktree-setup.sh
│   └── .worktreeinclude
├── config/                     # 拓扑快照与生成器
└── docs/feishu-setup.md        # 飞书开发者后台配置指南
```

---

## 快速开始

```bash
# 1) 建任务
~/bin/taskctl submit --message "在 calc.py 里加个 multiply 函数并补测试" \
  --repo ~/Workspace/your-repo --channel feishu --peer "<群 id>"

# 2) 等 runner 自动执行（5 秒轮询），或手动跑一轮
cd ~/Workspace/openclaw-multiagent/taskctl && node bin/runner.mjs --once

# 3) 看结果
~/bin/taskctl status <task-id>
~/bin/taskctl report <task-id>
```

**目标仓库需要两个文件**才会启用 worktree 环境隔离（从 `repo-template/` 复制）：

- `.openclaw/worktree-setup.sh` —— 环境隔离钩子（建 `.venv` / pnpm store / Maven 本地库）
- 声明项目类型的标记文件（`pyproject.toml` / `requirements.txt` / `package.json` / `pom.xml` …）
  —— 钩子只在有标记时才建 `.venv`，而门控的 `detect_test_cmd` 又依赖 `.venv` 存在

---

## 检查

```bash
cd taskctl
make check    # 提交前必过：单测 21 + 编排 eval 8，不依赖外部服务
make audit    # 链路配置自检 27 项（需 OpenClaw 在跑）
make reap              # 列出僵尸会话 + 孤儿工作树（dry-run）
make reap-worktrees FORCE=1   # 清孤儿工作树
make reload            # 重启 runner（**改代码后必须**）
```

**eval 验的是编排逻辑，不是模型质量** —— 用桩传输注入，毫秒级、零成本、完全确定。
它抓到过一个真实 bug：第二轮 `review` 被幂等跳过，于是**一直读到旧的失败结论**，
陷入"修 → 跳过审查 → 又判失败"的死循环直到 maxFix 耗尽。

**运维要点**：runner 是常驻进程，**改完代码必须 `make reload`** 才生效
（我为此排查过两次"改了没反应"）。

---

## 关键配置（`~/.openclaw/openclaw.json`）

```jsonc
{
  "models": { "providers": { "deepseek": {
    "baseUrl": "https://api.deepseek.com",
    "api": "openai-completions",
    "apiKey": { "source": "env", "provider": "default", "id": "DEEPSEEK_API_KEY" },  // SecretRef，密钥不入库
    "models": [
      { "id": "deepseek-flash",  "input": ["text","image"], "contextWindow": 1048576, "maxTokens": 393216 },
      { "id": "deepseek-v4-pro", "input": ["text"],          "contextWindow": 1048576, "maxTokens": 393216 }
    ]
  }}},

  // dispatcher 需要 exec 才能调 taskctl；全局不能有 exec（会破坏 Codex harness）
  "tools":  { "alsoAllow": ["apply_patch","edit","process","read","write"],
              "exec": { "timeoutSeconds": 900, "backgroundMs": 240000 } },
  "agents": { "defaults": { "systemAgent": { "agentId": "dispatcher" } },
              "entries": {
                "dispatcher": { "model": "deepseek/deepseek-v4-pro",
                                "tools": { "alsoAllow": ["exec","read","write"] } },  // 注意：不含 process
                "dsh":   { "runtime": { "type": "acp", "acp": { "agent": "dsh",   "backend": "acpx" } } },
                "codex": { "model": "openai/deepseek-flash",
                           "models": { "openai/deepseek-flash": { "agentRuntime": { "id": "codex" } } } },
                "claude":{ "model": "claude-cli/claude-sonnet-5" }
              }},
  "bindings":  [{ "agentId": "dispatcher", "match": { "channel": "feishu", "peer": { "kind": "group", "id": "<群 id>" } } }],
  "channels":  { "feishu": { "replyInThread": "disabled" } }   // enabled 会让每条回复各占一条会话记录
}
```

---

## 踩过的坑（都写进了代码注释）

| 坑 | 现象 | 根因 |
|---|---|---|
| taskId 大小写 | orchestrator 拒收 | 它只接受 `[a-z0-9-]`；OpenClaw 也会把 session key 小写化 → **task id 一律小写** |
| `--repo` 不生效 | "不在 git 仓库内，且未指定 ORCH_REPO" | orchestrator 在**解析命令之前**就有顶层 `ORCH_REPO` 检查 → 必须走环境变量 |
| **DSH 在原仓库干活** | 门控在 worktree 跑、代码改在原仓库 | `opts.workdir` 压过了供应出的 worktree → 优先级修正 |
| 漏了 `env` 步骤 | 门控 exit 3「识别不出测试套件」 | `detect_test_cmd` 要求 `$wt/.venv/bin/python` 存在 |
| `env` 一轮不够 | 同上 | 钩子 110s 软件截止，重活写进 `.openclaw/env-setup.pending` → 要**多轮**补跑 |
| 第二轮 review 被跳过 | 无限修复循环 | 幂等跳过只适用于"重放同一任务"，不适用于"按意见改一版" |
| `log()` 遇 ENOENT | **runner 进程被打挂** | 外部清理任务目录时日志写入抛异常 → 已容错 |
| `message send` 无 owner | 投递失败 | 多 agent 下必须设 `agents.defaults.systemAgent.agentId` |
| 审批解析软链 | `approval requires a resolved executable` | 允许列表要匹配**软链的真实目标**，不是软链本身 |

---

## 真实场景验证（P3）

在 `~/Workspace/openclaw-multiagent-demo`（及 `_scenarios/` 下的独立仓库）上验证：

| 场景 | 仓库 | 结果 |
|---|---|---|
| S-A 纯 Python | demo 根（`pyproject.toml` + `tests/`） | ✅ `done`，门控 10 passed，已合并，worktree 已清 |
| S-B 纯 Node | `_scenarios/node`（`package.json` + `scripts.test`） | ✅ `done`，门控 `pnpm test`，6 passed |
| S-C polyglot | `_scenarios/polyglot`（Node + Python 并存） | ✅ `done`，但**只跑 Node**（见 TODO #3） |
| S-D 故意失败 | demo 根 + 一个必失败测试 | ✅ `failed`，**未合并** —— fail-closed 确认生效 |

**P3 的价值**：S-A 第一次跑就暴露了 `.gitignore` 缺失导致合并被 `__pycache__` 永久阻塞（已修 `repo-template/`）。

## 已知限制与待办

| # | 项 | 说明 |
|---|---|---|
| 1 | **审批门未自研** | 破坏性操作目前靠 `AGENTS.md` 约束而非机制。Lobster 需 OpenClaw ≥2026.10.1（当前 2026.9.9），暂不升级 |
| 2 | `Subagent terminal signal owner changed` 偶发 | 上游状态记录竞态；已通过降并发、会话隔离降低发生率，无法根除 |
| 3 | `deepseek-flash` 的图像能力未验证 | 官方文档称支持图像理解，已声明 `input: ["text","image"]`，但未实测 |
| 4 | 成本熔断以 token 为准 | DeepSeek 的 `cost.total` 返回 0；`pricing.json` 已按官方价填入（人民币元），USD 熔断需注意单位 |
| 5 | 僵尸会话需人工回收 | `make reap` 是 dry-run，需 `--force` 才真删。未接入定时任务 |
| 6 | 双模式合并未接入飞书 | `orchestrator.sh merge` 可用，但 `/merge` 群命令未做 |

---

## 相关文档

- [`taskctl/README.md`](taskctl/README.md) —— 编排器的详细设计与数据契约
- [`docs/feishu-setup.md`](docs/feishu-setup.md) —— 飞书开发者后台配置步骤
