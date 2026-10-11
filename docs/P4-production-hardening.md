# P4：生产化加固（设计留档，未实现）

> 状态：**未实现**。记录于 2026-10-11。
> 触发条件：**准备把系统开放给他人使用，或接入公网/多用户**时再做。
> 个人自用（本机、单一飞书群）当前已闭环可用，P4 不是必需的。

本文档的目标是：后期实现时**不需要重新推导设计**。每一项都写清了现状、根因、设计、验收命令与工作量。

---

## 为什么 P4 可以延后

当前系统跑在：单用户、本机、私有飞书群、只有你能 @ 机器人。
在这个范围内，下面这些问题**风险可控或不存在**：

- 没有第二个用户，白名单无意义
- 触发者只有你，配额是自我约束
- 任务量小，聚合视图不如直接 `taskctl list`
- 投递失败你能立刻从群里发现

一旦要开放给他人，以上前提全部失效 —— 那时再按本文实现。

---

## F6 安全边界

### 现状

飞书群里**任何人** @ 机器人，就能让三个 agent 在你的机器上：

- 读写文件（dispatcher 有 `read`/`write`）
- 执行命令（dispatcher 有 `exec`，白名单含 `/usr/bin/git`）
- `git commit`（DSH 在 worktree 里自动提交）
- 触发完整管线（消耗你的 DeepSeek 额度）

破坏性操作（推送、合并、发布）目前**只靠 `dispatcher/AGENTS.md` 的文字约束** ——
这是提示词级别的约定，不是机制。

### 设计

**1. 触发者白名单**

```bash
# 环境变量，逗号分隔的 open_id
MA_ALLOWED_OPEN_IDS="ou_cfe3397b6bc97981ed6332109cbbff66"
```

在 `dispatcher` 的接入路径上校验。实现位置有两选：

- **A（推荐）**：`channels.feishu` 层做 —— 但 schema 是闭集，无此键，需插件支持
- **B**：`dispatcher/AGENTS.md` 要求它每次先 `taskctl check-sender --open-id <id>`，
  非白名单直接回绝。**弱约束**（模型可能不照做）

> 若要强约束，需要写一个小的 Feishu 渠道前置插件。这是 P4 最大的一块工作量。

**2. 单日配额**

复用已有的 token 熔断机制，加按天聚合：

```bash
taskctl quota --daily-tasks 50 --daily-tokens 5000000
```

超限时新 `submit` 被拒。数据源已有：`tasks/*/status.json` 的 `tokensIn/tokensOut` + `startedAt`。

**3. 破坏性操作审批门**

状态机里**已留好** `needs_approval` 与 `resume`：

```js
// engine.mjs 已有的形态（mergeMode=human 时就是这样）
return transition(taskId, "needs_approval", {
  pendingApproval: { kind: "merge", prompt: "..." },
});
```

补 `taskctl approve <id>` / `taskctl reject <id> --reason`，以及 runner 侧把审批请求
用 `openclaw message send` 推到来源渠道。

**触发点**：`orchestrator.sh merge --push`、任何 `git push`、发布类操作。

### 验收

```bash
# 白名单
openclaw ... --open-id ou_not_allowed   # 期望：被拒 + 明确提示
# 配额
taskctl quota --daily-tasks 1
taskctl submit ...; taskctl submit ...  # 期望：第二个被拒
# 审批门
taskctl submit ... --merge-mode human
# 期望：到 needs_approval 停下 + 群里收到审批请求
taskctl approve <id>                     # 期望：继续合并
```

### 工作量

白名单强约束（写渠道插件）**中大**；配额 **小**；审批门 **中**（状态机已就绪）。

---

## F7 可观测性

### 现状

- 只能 `taskctl status <id>` 单条查
- **投递失败（`delivered: false`）只写进 runner 日志，无人知晓**
- 没有聚合视图：在跑几个、今日成本、失败率

### 设计

**1. `taskctl stats`**

```bash
taskctl stats [--since 1d] [--json]
```

输出：任务数、成功率、按阶段分布、token/成本合计、失败原因分类。
数据全部已在 `tasks/*/status.json` + `verdict.json`，只是没有聚合函数。

**2. 投递失败重试**

`runner.mjs` 的 `deliver()` 加 3 次指数退避。仍失败则：

- 写入 `$STATE_ROOT/alerts/delivery-failed.jsonl`
- 可选：降级到备用渠道（如另一个群或本地通知）

**3. 结构化 runner 日志**

现在是自由文本 + JSON 混排。改为纯 JSONL，带 `taskId` 便于 `jq` 过滤。

### 验收

```bash
taskctl stats --json | jq -e '.tasks.total > 0 and .cost.total >= 0'
# 模拟投递失败（改坏 peerId）→ 期望重试 3 次后写 alerts 文件
```

### 工作量

`stats` **小**（纯聚合）；重试 **小**；日志改造 **小**。

---

## F9 小项

| 项 | 现状 | 设计 | 工作量 |
|---|---|---|---|
| **polyglot 门控**（TODO #3） | `detect_test_cmd` 只返回第一条命中；Node 存在时 Python 测试永不执行 | 改为返回命令**数组**，门控全部执行、任一失败即拒。需扩展 `orchestrator.sh` 的 gate 文件结构 | 中 |
| `plan` 产出从不参与决策 | 花 token 但纯参考 | 要么纳入门控（如"实现与计划偏离度"），要么标为可选、简单任务 `--skip-plan` 省钱 | 小 |
| `acp-poll` 触发概率性 | dispatcher 对琐碎任务会直接答掉、不 spawn | spawn 失败时自动重试 1 次；仍失败明确报错而非静默 | 小 |
| 分层超时**配置层**对齐 | 代码内已推导（F8），但 `openclaw.json` 的 `tools.exec.timeoutSeconds` 等仍独立硬编码 | 把配置层也纳入 `validateTimeoutChain` 校验范围 | 小 |
| 无 CI | 已推送到 GitHub 但无 Actions | 加 workflow 跑 `make check`（不依赖外部服务，可直接跑） | 小 |
| `docs/feishu-setup.md` | 可能已与当前配置脱节 | 对照复核 | 小 |

---

## 优先级建议

若将来要做，建议顺序：

```
1. F7 stats + 投递重试        ← 最小成本、立刻提升可运维性
2. F9 polyglot 门控            ← 正确性问题，真实仓库上会咬人
3. F6 配额 + 审批门            ← 状态机已就绪，改动集中
4. F6 白名单（渠道插件）        ← 最大工作量，开放给他人前才必须
5. F9 CI + 文档复核
```

**理由**：先做"让你自己用得更好"的（可观测性、正确性），再做"给别人用"的（安全）。

---

## 已知不会做的

| 项 | 原因 |
|---|---|
| Lobster 审批门 | 需 OpenClaw ≥2026.10.1，当前 2026.9.9；为可选增强动版本不划算（用户已明确倾向不升级） |
| 修 `Subagent terminal signal owner changed` | 上游内部竞态，我们只能降低发生率，无法根修 |
| `deepseek-flash` 上下文长度 | 已从官方文档取到（1048576），无需再做 |

---

## 参考

- 主 [`README.md`](../README.md) —— 当前架构与已解决的坑
- [`taskctl/README.md`](../taskctl/README.md) —— 编排器设计与数据契约
- [`TODO.md`](../TODO.md) —— 已确认但未做的两项（审批门、上游竞态）
