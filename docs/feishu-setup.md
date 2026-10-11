# 飞书接入分步指南

目标：把 OpenClaw 接进飞书，让 Planner / Coder / Reviewer 三个智能体在同一个群聊里工作。

> **事实来源**：本机 OpenClaw 2026.9.9 的官方文档（`docs/channels/feishu/`）与
> `openclaw config schema`。凡文档未写明、需要你在控制台自行确认的步骤，都标了
> **「文档未提及」**，请勿当成已验证结论。

---

## 0. 先决条件

| 项 | 要求 | 本机状态 |
|---|---|---|
| OpenClaw | ≥ 2026.5.29 | 2026.9.9 ✅ |
| `@openclaw/feishu` 插件 | 需安装 | 未安装 ⬜ |
| 飞书应用 | 自建应用，需发布并通过审批 | 未创建 ⬜ |
| Node 运行时 | 钉住 node@26 的 `openclaw` shim | 已就绪 ✅ |

**不需要公网地址。** OpenClaw 的飞书默认走 **WebSocket 长连接**：
> "WebSocket is the default event transport (**no public URL needed**); webhook mode is optional."
> — `docs/channels/feishu.md:11`

webhook 模式才需要公网回调地址或反向代理，这时才考虑 Tailscale Funnel 之类方案。
本指南只走 WebSocket。

---

## 路线 A（推荐）：用官方向导自动建机器人

向导会自动装插件、开二维码流程，扫码即可在飞书里自动创建一个机器人。

```zsh
export PATH="$HOME/bin:$PATH"        # 钉住 node26 的 openclaw shim
openclaw channels login --channel feishu
```

向导会做的事（依据 `docs/channels/feishu/setup.md:21-28`）：

1. 若缺少 `@openclaw/feishu` 插件则自动安装；
2. 提供**扫码**方式：在飞书 App 里扫码自动创建机器人，
   该流程会把 DM 锁到你自己的账号（`dmPolicy: "allowlist"` + 你的 `open_id`）；
3. 询问 API domain（`feishu` 还是 `lark`）与 group policy。

完成后验证：

```zsh
openclaw channels status --probe
```

> 向导是交互式的。它会写入 `channels.feishu.appId` / `appSecret`。
> 之后建议用 `openclaw secrets configure` 把密钥迁到 SecretRef
> （`openclaw doctor` 会对明文密钥告警）。

---

## 路线 B：手工在开发者控制台建应用

需要自己控制应用权限/审批流时走这条。

### B1. 创建自建应用

1. 打开飞书开放平台：<https://open.feishu.cn>（国际版 Lark：<https://open.larksuite.com>）
2. 创建**企业自建应用**（self-built app）
3. 在「凭证与基础信息」页复制 **App ID**（形如 `cli_xxxxxxxx`）与 **App Secret**

> 文档依据：`docs/channels/feishu/troubleshooting.md:81` —
> "In Feishu Open Platform, create a self-built app and copy its App ID and App Secret"
>
> ⚠️ **「文档未提及」**：控制台里各页面的具体点击路径，官方文档没有逐步清单。
> 下面的步骤是控制台通用流程，请以你看到的界面为准。

### B2. 开通权限（scope）

官方文档里**明确点名过**的 scope 只有下面这些：

| scope | 用途 | 是否必需 |
|---|---|---|
| `im:message:readonly` | 读取消息 | 收发消息必需 |
| `im:message.group_msg` | 接收群内**未被 @** 的消息 | 仅当你要 bot 读未 @ 的消息 |
| `im:message.group_at_msg.include_bot:readonly` | 允许接收其它 bot 的群消息 | 仅当 `allowBots: true` |
| `drive:drive.metadata:readonly` | 直接查询根目录外的云盘文件 | 仅当用 `feishu_drive info` |
| `drive:drive:readonly` | 旧版根目录查询回退 | 同上 |
| `drive:drive` | 云盘完整权限 | 仅当需要写云盘 |
| `vc:meeting.bot.join:write` | 自动加入 VC 会议 | 仅当用会议自动入会 |

> ⚠️ **「文档未提及」**：除上述之外还必需哪些 scope，官方文档只说
> "Ensure all required permission scopes are granted"，没给完整清单。
>
> **确认方法**：配置好后跑 `feishu_app_scopes` 工具
> （由 `channels.feishu.tools.scopes` 控制，默认开启）做运行时诊断，
> 它会告诉你当前应用缺哪些权限。

本方案（只 @ 触发、不接受其它 bot、不用云盘/会议）最小权限集是：
`im:message:readonly` + 发消息权限（控制台「消息与群组」一栏内勾选）。

### B3. 事件订阅

必须订阅：

- `im.message.receive_v1` — 接收消息（**核心**）
- `drive.notice.comment_add_v1` — 云文档评论通知（OpenClaw 会持久化排队该事件；不用云文档可不开）

可选：

- `vc.bot.meeting_invited_v1` — 会议邀请自动入会（需配合 `vcAutoJoin`）

> 依据：`docs/channels/feishu/troubleshooting.md:25-26`、`docs/channels/feishu/setup.md:43`

**订阅方式必须选「长连接」（persistent connection / WebSocket）**，不要选 webhook 回调地址。
> 依据：`troubleshooting.md:27` — "Ensure **persistent connection** (WebSocket) is selected"

### B4. 发布版本并等待审批

> 依据：`troubleshooting.md:24` — "Ensure the bot is published and approved in Feishu Open Platform / Lark Developer"
>
> ⚠️ 企业自建应用通常需要管理员审批后权限才生效。**权限没批下来时表现是「机器人沉默」**，
> 而不是报错 —— 见 `docs/channels/feishu/troubleshooting.md` 的 "Bot does not receive messages"。

### B5. 把机器人拉进群，并拿到 chat_id

1. 在飞书里建一个群（或用现有群）
2. 群设置 → 群机器人 → 添加机器人 → 选你刚建的应用
3. 群 ID 取法：群设置页可见 `chat_id`，形如 `oc_xxxxxxxx`

> 依据：`troubleshooting.md:17`（"Ensure the bot is added to the group"）、
> `docs/channels/feishu/access-control.md:182`（`chat_id` 格式 `oc_xxx`）

用户 open_id（形如 `ou_xxx`）用于 DM 白名单，取法见 `access-control.md` 的
"Get group/user IDs" 一节。

---

## 3. 写入配置

拿到 `App ID` / `App Secret` / `chat_id` 之后，用本仓库的脚本一步落配置：

```zsh
cd ~/Workspace/openclaw-multiagent/config

export FEISHU_APP_ID=cli_xxxxxxxx
export FEISHU_APP_SECRET=xxxxxxxx
export FEISHU_CHAT_ID=oc_xxxxxxxx

./apply-topology.sh --dry-run    # 先看要合并成什么
./apply-topology.sh              # 实际写入（自动备份 + schema 校验 + 失败回滚）
```

脚本会做的关键事：

- 装插件（若缺）：`openclaw plugins install @openclaw/feishu`
- 写入拓扑里与本方案相关的部分：三个 agent、ACP 运行时、群聊 broadcast、循环保护、飞书渠道
- 必须通过 `openclaw config validate`，否则**自动回滚**到合并前状态

---

## 4. 关键配置项说明（都在 `topology.json5` 里）

### 4.1 群聊里的 @ 提及

```json5
channels: {
  feishu: {
    groupPolicy: "allowlist",     // 只服务白名单群
    groups: { "oc_xxx": {} },     // 显式列出目标群（同时完成准入）
    requireMention: true,         // 群里必须 @ 机器人才响应
  },
}
```

**注意一个容易搞混的点**：飞书**没有** `channels.feishu.mentionPatterns` 这个键
（`channels.feishu` 是 `additionalProperties: false` 的闭集，schema 里不存在该键）。
飞书侧的 @ 门禁由 `requireMention` 单独控制。

多智能体的「@ 谁就跑谁」靠的是**顶层 `broadcast`** + **每个 agent 的
`groupChat.mentionPatterns`**：

```json5
agents: {
  entries: {
    planner:  { groupChat: { mentionPatterns: ["@planner\\b", "@规划\\b"] } },
    coder:    { groupChat: { mentionPatterns: ["@coder\\b", "@编码\\b"] } },
    reviewer: { groupChat: { mentionPatterns: ["@reviewer\\b", "@审查\\b"] } },
  },
},
broadcast: {
  "feishu:oc_xxx": {
    agents: ["planner", "coder", "reviewer"],
    mentionGating: true,   // @ 到谁只跑谁；都没 @ 才全员跑
    maxRounds: 2,
    maxTurns: 6,
  },
},
```

> ⚠️ **待实测项**：官方文档说明 `agents.entries.*.groupChat.mentionPatterns`
> 是"与其它频道共享"的提及模式（`docs/channels/group-messages.md:16`），
> 但**飞书文档全文未提及**该键。飞书插件是否消费它，属于文档未覆盖的部分。
> `broadcast` 的参与者选择文档只点名了 Discord / Slack / Telegram。
>
> **验证方法**：接好之后在群里 @coder 发一条，看 `openclaw logs --follow | grep -i broadcast`
> 是否出现 "Broadcasting message to N agents"，以及实际跑了几个 agent。
> 若 @ 不生效，退路是让 Planner 统一接收、再由它用 `sessions_spawn` 派活。

### 4.2 机器人循环保护（防 token 失控）

```json5
channels: {
  defaults: {
    botLoopProtection: {
      enabled: true,
      maxEventsPerWindow: 10,   // 默认 20
      windowSeconds: 60,        // 默认 60
      cooldownSeconds: 120,     // 默认 60
    },
  },
}
```

机制（`docs/channels/bot-loop-protection.md:12-27`）：

- 防的是**两个 bot 身份之间的快速往复**（bot ↔ bot），核心按**参与者对**统计，
  A→B 与 B→A 算同一对；
- 滑动窗口速率闸门：超预算后对该对子进入冷却期**抑制**（近似熔断），不是全局丢弃；
- **不影响人类发的消息**、单 bot 部署、自身消息过滤、以及未超预算的 bot 回复。

> **重要**：飞书**只**认这份共享基线。
> "Feishu intentionally uses only this shared baseline."
> 即 `channels.feishu.botLoopProtection` 是**非法键**，写了会被 schema 拒绝。

还有一道独立闸在 `broadcast` 上：协调器预算**最多 4 轮 / 32 个参与者回合**，
槽位在并行派发**之前**就已预留。我们的拓扑设的是 2 轮 / 6 回合。

另有一道单 agent 内部的工具调用死循环检测：`tools.loopDetection.enabled`。

### 4.3 人工干预合并 `/merge`

**必须先知道一件事**：`/merge` **不是** OpenClaw 内置命令，飞书也没有
`customCommands` 这类键（该键只存在于 Telegram）。要让群里能敲 `/merge <task>`，
只有两条路：

**路线 1（当下可用）**：由 Planner（Claude Code）理解意图后调用编排器：

```zsh
~/Workspace/openclaw-multiagent/orchestrator/orchestrator.sh merge <task> --as human
```

**路线 2（要做成真正的确定性命令）**：写一个极小的 OpenClaw 插件，
用 `api.registerCommand()` 注册 `/merge`，直接 shell 出去调上面的命令。
`registerCommand` 的定义是"绕过 LLM 的自定义命令"，正好符合需求：
群里敲 `/merge t1` → 不经过任何模型 → 直接执行门控 + 合并。

> 依据：`docs/plugins/sdk-overview/tools-and-commands.md:32`
> （"Custom command (bypasses the LLM)"）

无论走哪条，合并都受同一套门控约束（见 README 的"双模式合并"一节）。

---

## 5. 验收清单

```zsh
# 1) 插件与渠道状态
export PATH="$HOME/bin:$PATH"
openclaw plugins list | grep -i feishu          # 应为 enabled
openclaw channels status --probe                # 飞书应显示已连接

# 2) 配置合法性
openclaw config validate                        # Config valid

# 3) 飞书应用权限自检（在群里发）
#    /status   → 机器人状态
#    /model    → 当前模型
#    注意：飞书不支持原生斜杠菜单，这些要当普通文本单独发一条

# 4) 端到端：在群里 @planner 说一句需求，看日志
openclaw logs --follow
```

> 飞书不支持原生斜杠命令菜单，`/status`、`/reset`、`/model`、`/acp ...`
> 都必须**单独发一条纯文本**。
> 依据：`docs/channels/feishu.md:93`、`docs/channels/feishu/advanced-configuration.md:150`

---

## 6. 排障速查

| 症状 | 先查什么 |
|---|---|
| 机器人完全收不到消息 | 事件订阅是否含 `im.message.receive_v1`；是否选了**长连接**；应用是否已发布且审批通过 |
| 群里 @ 了没反应 | `groupPolicy` 是否放行该群；`requireMention`；bot 是否已入群 |
| DM 不回复 | `dmPolicy` 默认是 `pairing`，需要先完成配对 |
| 权限不生效 | 跑 `feishu_app_scopes` 工具看缺哪些 scope |
| 群里有多个 bot 时互相刷屏 | 保持 `allowBots: false`（本方案默认）；或收紧 `botLoopProtection` |
| App Secret 泄露 | 控制台重置 App Secret，然后更新配置 |

> 来源：`docs/channels/feishu/troubleshooting.md`

---

## 7. 安全提醒

1. **App Secret 不要写进版本库。** `apply-topology.sh` 从环境变量注入，
   写入后配置文件权限为 `0600`。后续建议迁移到 SecretRef：
   `openclaw secrets configure`。
2. `openclaw doctor` 会报 `plaintext secret-bearing config` —— 那是这台机器上
   **升级前就存在**的问题（gateway auth token 明文），不是接入飞书引入的。
3. 飞书渠道**不需要**公网暴露 Gateway。如果因为什么原因改用了 webhook 模式，
   才需要处理公网回调与签名校验（含 1 小时的时钟容差窗口，务必保持 NTP 同步）。
