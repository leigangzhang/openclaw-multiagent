#!/bin/zsh
#
# set-feishu-chat-id.sh —— 把飞书群 chat_id 在三个地方一次性对齐
#
# 为什么单独写一个脚本：chat_id 在配置里出现在**三个互相独立的位置**，
# 漏改任何一个都会导致"机器人沉默"，而且不会报错：
#   1. channels.feishu.groups.<chat_id>          —— 群白名单准入
#   2. bindings[].match.peer.id                  —— 路由归属哪个 agent
#   3. broadcast["feishu:<chat_id>"]             —— 多智能体 fan-out
#
# 本脚本只动这三处，不碰 agents / plugins / 其它渠道配置。
# 先备份 → 改 → openclaw config validate → 失败自动回滚。
#
# 用法：
#   ./set-feishu-chat-id.sh oc_真实群ID
#   ./set-feishu-chat-id.sh oc_真实群ID --from oc_xxxxxxxx   # 显式指定旧值
#
# 拿真实 chat_id：
#   openclaw gateway start
#   openclaw directory groups list --channel feishu
#
# 注意：本脚本直接写文件，不走 OpenClaw 的配置写入管线。
# 网关在跑时会被前置检查拦下（原因见 README「已知坑 1」）。

set -euo pipefail

CONFIG_FILE="${OPENCLAW_CONFIG_PATH:-${HOME}/.openclaw/openclaw.json}"
OPENCLAW_BIN="${OPENCLAW_BIN:-${HOME}/bin/openclaw}"
GATEWAY_PORT="${GATEWAY_PORT:-18789}"

die()  { print -u2 -- "set-feishu-chat-id: $*"; exit 1 }
log()  { print -- "[chat-id] $*"; }
warn() { print -u2 -- "[chat-id] $*"; }

NEW_ID=""
OLD_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) OLD_ID="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "未知参数: $1" ;;
    *) [[ -z "$NEW_ID" ]] && NEW_ID="$1" || die "多余参数: $1"; shift ;;
  esac
done

[[ -n "$NEW_ID" ]] || die "用法: $0 <新的 chat_id> [--from <旧 chat_id>]"
[[ "$NEW_ID" == oc_* ]] || die "chat_id 应以 oc_ 开头（飞书群 ID 格式 oc_xxx）"
[[ "$NEW_ID" == "oc_xxxxxxxx" ]] && die "$NEW_ID 就是占位符本身，请填真实群 ID"

[[ -f "$CONFIG_FILE" ]] || die "读不到配置: $CONFIG_FILE"
[[ -x "$OPENCLAW_BIN" ]] || die "找不到 openclaw: $OPENCLAW_BIN"

# ── 网关前置检查（同 README 坑 1）──────────────────────────────
if pgrep -qf "openclaw-gateway" 2>/dev/null \
   || lsof -nP -iTCP:"$GATEWAY_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "检测到 Gateway 正在运行。
  本脚本直接改写 $CONFIG_FILE，请先停网关，改完再启：
    openclaw gateway stop
    $0 $NEW_ID
    openclaw gateway start"
fi

# ── 定位旧值 ───────────────────────────────────────────────────
if [[ -z "$OLD_ID" ]]; then
  OLD_ID="$(jq -r '
    [ (.channels.feishu.groups // {} | keys[])
    , (.bindings // [] | .[] | select(.match.channel=="feishu") | .match.peer.id)
    , ((.broadcast // {}) | to_entries | .[] | select(.key|startswith("feishu:")) | .key|sub("^feishu:";""))
    ] | map(select(. != null and . != "")) | unique | .[0] // empty' "$CONFIG_FILE")"
fi
[[ -n "$OLD_ID" ]] || die "在配置里找不到任何飞书群 ID，请用 --from 指定旧值"

log "配置文件: $CONFIG_FILE"
log "旧 chat_id: $OLD_ID"
log "新 chat_id: $NEW_ID"
[[ "$OLD_ID" == "$NEW_ID" ]] && { log "新旧相同，无需改动"; exit 0; }

BAK="$(mktemp -t oc-chatid-backup)"
cp -p "$CONFIG_FILE" "$BAK"
trap 'rm -f "$BAK"' EXIT

# ── 定点替换三处 ───────────────────────────────────────────────
jq --arg old "$OLD_ID" --arg new "$NEW_ID" '
  # 1) 群白名单：键名换掉，值保留
  ( if (.channels.feishu.groups // {})[$old] != null
    then .channels.feishu.groups = ((.channels.feishu.groups | del(.[$old])) + {($new): .channels.feishu.groups[$old]})
    else . end )
  # 2) 路由绑定：只改 feishu 的 group peer
  | ( if .bindings then
        .bindings = [ .bindings[] |
          if (.match.channel == "feishu" and .match.peer.id == $old)
          then .match.peer.id = $new else . end ]
      else . end )
  # 3) broadcast：键名 "feishu:<id>" 换掉
  | ( if .broadcast and (.broadcast["feishu:" + $old] != null)
      then .broadcast = ((.broadcast | del(.["feishu:" + $old])) + {("feishu:" + $new): .broadcast["feishu:" + $old]})
      else . end )
' "$CONFIG_FILE" > "$CONFIG_FILE.tmp"

mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE"

# ── 校验，失败回滚 ─────────────────────────────────────────────
if "$OPENCLAW_BIN" config validate >/tmp/oc-chatid-validate.out 2>&1; then
  log "✅ 已更新并通过校验"
  log "   file://$CONFIG_FILE"
  log "   backup: $BAK"
  log ""
  log "三处现状："
  jq -r '
    "  channels.feishu.groups : \( (.channels.feishu.groups // {} | keys) | join(", ") )",
    "  bindings peer.id       : \( [ (.bindings // [])[] | select(.match.channel=="feishu") | .match.peer.id ] | join(", ") )",
    "  broadcast key          : \( [ (.broadcast // {} | keys[]) | select(startswith("feishu:")) ] | join(", ") )"
  ' "$CONFIG_FILE"
  log ""
  log "下一步: openclaw gateway start && openclaw channels status --probe"
else
  cp -p "$BAK" "$CONFIG_FILE"
  warn "❌ 校验失败，已回滚。校验输出："
  cat /tmp/oc-chatid-validate.out >&2
  exit 1
fi
