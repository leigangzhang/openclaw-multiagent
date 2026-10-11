#!/bin/zsh
#
# refresh-topology.sh —— 从**线上真实配置**重新生成 topology.json5
#
# 为什么这样设计：
#   之前 topology.json5 是手工维护的"期望状态"，apply-topology.sh 把它合并进 openclaw.json。
#   但实际排障中配置被大量调整（模型、路由、provider、渠道细节），
#   手工文件很快就不代表现实 —— 此时重跑 apply 会把线上的真实成果**覆盖掉**。
#
#   所以改为：topology.json5 是**线上配置的快照**（只取本方案关心的子集），
#   由本脚本生成。apply-topology.sh 仍然可用，但它的输入始终等于线上现状，
#   重跑是幂等的、不会再造成破坏。
#
# 安全：生成时会把密钥类字段替换回占位符，绝不写入明文。
#
# 用法：
#   ./refresh-topology.sh              # 需要网关已停（避免读到分叉的配置）
#   ./refresh-topology.sh --force      # 网关在跑也照办

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="${SCRIPT_DIR}/topology.json5"
CONFIG_FILE="${OPENCLAW_CONFIG_PATH:-${HOME}/.openclaw/openclaw.json}"
GATEWAY_PORT="${GATEWAY_PORT:-18789}"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

die() { print -u2 -- "refresh-topology: $*"; exit 1 }

[[ -f "$CONFIG_FILE" ]] || die "读不到配置: $CONFIG_FILE"

if [[ $FORCE -eq 0 ]] && { pgrep -qf "openclaw-gateway" 2>/dev/null || lsof -nP -iTCP:"$GATEWAY_PORT" -sTCP:LISTEN >/dev/null 2>&1; }; then
  die "Gateway 正在运行。停掉它再生成，避免快照到分叉状态：
    openclaw gateway stop
    $0
    openclaw gateway start
  （确认要用当前状态生成，加 --force）"
fi

BACKUP="${OUT}.bak-$(date +%Y%m%d-%H%M%S)"
[[ -f "$OUT" ]] && { cp -p "$OUT" "$BACKUP"; print -- "旧快照已备份: $BACKUP"; }

node - "$CONFIG_FILE" "$OUT" <<'NODE'
const fs = require("fs");
const [cfgPath, outPath] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

// 只取本方案关心的子集，其余（gateway/auth/meta/wizard 等）不纳入快照
const pick = (obj, keys) => {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
};

const agents = cfg.agents || {};
const entries = agents.entries || {};
// 每个 agent 只保留本方案用到的字段，避免把无关的个人设置带进交付物
const entryKeys = ["name", "workspace", "model", "models", "runtime", "subagents", "groupChat"];

const snap = {
  acp: cfg.acp,
  plugins: {
    entries: pick(cfg.plugins?.entries || {}, ["acpx", "feishu", "codex", "anthropic", "openai"]),
  },
  models: cfg.models,
  worktreeRoot: cfg.worktreeRoot,
  worktreeAcceleration: cfg.worktreeAcceleration,
  agents: {
    ownership: agents.ownership,
    defaults: pick(agents.defaults || {}, ["model", "compaction", "maxConcurrent", "subagents"]),
    entries: Object.fromEntries(
      Object.entries(entries).map(([id, v]) => [id, pick(v, entryKeys)])
    ),
  },
  bindings: cfg.bindings,
  broadcast: cfg.broadcast,
  tools: cfg.tools,
  channels: cfg.channels,
};

// ── 脱敏：密钥类字段还原成占位符 ────────────────────────────────
let json = JSON.stringify(snap, null, 2);
const redactions = [
  [/("appSecret"\s*:\s*)"[^"]*"/g,   '$1"__FEISHU_APP_SECRET__"'],
  [/("appId"\s*:\s*)"cli_[^"]*"/g,   '$1"__FEISHU_APP_ID__"'],
  [/("token"\s*:\s*)"[^"]{8,}"/g,    '$1"__REDACTED__"'],
];
for (const [re, rep] of redactions) json = json.replace(re, rep);

// apiKey 单独处理：SecretRef（形如 {"source":"env",...}）本身不含密钥，必须原样保留，
// 否则快照会写进一个非法值；只有字面量形式的密钥才需要脱敏。
json = json.replace(/"apiKey":\s*"((?:[^"\\]|\\.)*)"/g, (m, value) =>
  value.startsWith("__") ? m : '"apiKey": "__REDACTED_LITERAL_KEY__"'
);
// 群里出现的真实 chat_id 也还原成占位符
json = json.replace(/"oc_[a-z0-9]{20,}"/g, '"__FEISHU_CHAT_ID__"')
           .replace(/oc_[a-z0-9]{20,}/g,  '__FEISHU_CHAT_ID__')
           .replace(/ou_[a-z0-9]{20,}/g,  '__FEISHU_OPEN_ID__');

const header = `/**
 * OpenClaw 多智能体拓扑 —— **线上配置快照**（自动生成，请勿手工编辑）
 *
 * 生成时间: ${new Date().toISOString()}
 * 来源:     ${cfgPath}
 * 生成器:   config/refresh-topology.sh
 *
 * 这是现状的**记录**，不是期望状态。要改配置请用 \`openclaw config set\`，
 * 改完再跑 refresh-topology.sh 更新本文件。
 *
 * 密钥已脱敏为占位符，可安全提交。
 */

`;
fs.writeFileSync(outPath, header + json + "\n");
print = console.log;
print(`已生成: ${outPath}`);
NODE

print -- ""
print -- "提醒：这是快照。改动配置请用 openclaw config set，别直接改这个文件。"
