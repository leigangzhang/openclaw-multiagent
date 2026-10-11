#!/bin/zsh
#
# apply-topology.sh —— 把 topology.json5 幂等合并进 ~/.openclaw/openclaw.json
#
# 设计要点：
#   * 只做深合并，不覆盖用户已有的其它配置段（gateway/auth/meta 等原样保留）
#   * 合并前备份，合并后必须通过 `openclaw config validate`，否则自动回滚
#   * 占位符从环境变量注入，密钥不落进版本库
#   * 可重复运行（幂等）
#
# 用法：
#   export FEISHU_APP_ID=cli_xxx
#   export FEISHU_APP_SECRET=xxx
#   export FEISHU_CHAT_ID=oc_xxx
#   ./apply-topology.sh --dry-run     # 只看会合并成什么
#   ./apply-topology.sh               # 实际应用
#
# macOS 默认 /bin/zsh 5.9；脚本只用 POSIX 子集，bash 3.2 亦可运行。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOPOLOGY_FILE="${SCRIPT_DIR}/topology.json5"
CONFIG_FILE="${OPENCLAW_CONFIG_PATH:-${HOME}/.openclaw/openclaw.json}"
OPENCLAW_BIN="${OPENCLAW_BIN:-${HOME}/bin/openclaw}"

# 可配置项（带默认值，允许环境变量覆盖）
DSH_BIN="${DSH_BIN:-${HOME}/dsh-playgroud/bin/dsh}"
WORKTREE_ROOT="${WORKTREE_ROOT:-${HOME}/.openclaw-worktrees}"
AGENT_HOME="${AGENT_HOME:-${HOME}/.openclaw}"

DRY_RUN=0
SKIP_FEISHU=0
FORCE_GATEWAY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)        DRY_RUN=1 ;;
    --skip-feishu)    SKIP_FEISHU=1 ;;
    --force-gateway)  FORCE_GATEWAY=1 ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

die() { print -u2 -- "apply-topology: $*"; exit 1 }

# ── 0. 前置检查 ────────────────────────────────────────────────
[[ -r "$TOPOLOGY_FILE" ]] || die "读不到拓扑文件: $TOPOLOGY_FILE"
[[ -x "$OPENCLAW_BIN" ]] || die "找不到可执行的 openclaw: $OPENCLAW_BIN（应指向钉住 node26 的 shim）"
[[ -f "$CONFIG_FILE" ]]  || die "读不到 OpenClaw 配置: $CONFIG_FILE（先跑一次 openclaw onboard）"

# ── 网关前置检查：这是踩过的真坑 ───────────────────────────────
# 本脚本用 node **直接写 openclaw.json**，不走 OpenClaw 的配置写入管线。
# 而 OpenClaw 有一条 roster 守卫：任何"会丢掉现有 agent"的写入都会被拒绝
# （报错长这样：Config write would drop agent roster entries without an explicit
#  deletion: coder, planner, reviewer）。
#
# 有 Gateway 在跑时，CLI 的配置写入是**经 Gateway** 的，用的是 Gateway 的
# 运行时配置；此时"文件里的 roster"与"管线认得的 roster"会分叉，
# 下一次经管线的写入（例如 channels login 安装插件）就会撞上守卫。
#
# 正确姿势是：停网关 → 直接改文件 → 启网关（让 Gateway 重新加载文件）。
# 顺序反了就会踩守卫。
gateway_running() {
  pgrep -qf "openclaw-gateway" 2>/dev/null && return 0
  lsof -nP -iTCP:"${GATEWAY_PORT:-18789}" -sTCP:LISTEN >/dev/null 2>&1 && return 0
  return 1
}
if gateway_running && [[ $FORCE_GATEWAY -eq 0 ]]; then
  die "检测到 OpenClaw Gateway 正在运行。

  本脚本直接改写 $CONFIG_FILE，不经 OpenClaw 的配置写入管线。
  网关在跑时会出现两个问题：
    1) 网关内存里仍是旧 roster，后续任何经网关的写入（如 channels login
       安装插件）都会被 roster 守卫拒绝：
       'Config write would drop agent roster entries without an explicit deletion'
    2) 你刚写进去的改动会被网关的下一次写入覆盖

  正确顺序：
    openclaw gateway stop
    $0 $*
    openclaw gateway start

  确认网关已停仍要继续，加 --force-gateway。"
fi
[[ $FORCE_GATEWAY -eq 1 ]] && print -u2 -- "⚠ --force-gateway：网关可能在运行，写入结果可能被覆盖"

# 密钥类必须显式提供；--skip-feishu 时飞书那三个就不用了（还没建应用也能先落 ACP 层）
missing=""
if [[ $SKIP_FEISHU -eq 0 ]]; then
  [[ -n "${FEISHU_APP_ID:-}"     ]] || missing="${missing} FEISHU_APP_ID"
  [[ -n "${FEISHU_APP_SECRET:-}" ]] || missing="${missing} FEISHU_APP_SECRET"
  [[ -n "${FEISHU_CHAT_ID:-}"    ]] || missing="${missing} FEISHU_CHAT_ID"
fi
[[ -n "${DSH_BIN:-}" ]] || missing="${missing} DSH_BIN"
if [[ -n "$missing" ]]; then
  die "缺少环境变量:${missing}
  飞书 App ID / App Secret：飞书开放平台 → 开发者后台 → 凭证与基础信息
  群 chat_id：群设置页可见，形如 oc_xxxxxxxx
  （尚未创建飞书应用时，先用 --skip-feishu 只落 ACP 层）"
fi
[[ -x "$DSH_BIN" ]] || die "DSH_BIN 不可执行: $DSH_BIN"

# node 子进程只能看到导出的变量，这里统一导出（含上面算出的默认值）
export FEISHU_APP_ID FEISHU_APP_SECRET FEISHU_CHAT_ID DSH_BIN WORKTREE_ROOT AGENT_HOME
export SKIP_FEISHU

# 定位 openclaw 自带的 json5（openclaw 用 JSON5 解析配置；node 原生不支持注释）
OC_ROOT="$(cd "$(dirname "$(readlink -f "$OPENCLAW_BIN" 2>/dev/null || echo "$OPENCLAW_BIN")")" && pwd)"
if [[ ! -d "${OC_ROOT}/node_modules/json5" ]]; then
  OC_ROOT="${HOME}/.npm-global/lib/node_modules/openclaw"
fi
[[ -d "${OC_ROOT}/node_modules/json5" ]] || die "找不到 json5 解析器（预期在 ${OC_ROOT}/node_modules/json5）"

# ── 1. 渲染占位符 ──────────────────────────────────────────────
RENDERED="$(mktemp -t oc-topology-rendered)"
BAK="$(mktemp -t oc-config-backup)"
MERGED="$(mktemp -t oc-config-merged)"
trap 'rm -f "$RENDERED" "$BAK" "$MERGED"' EXIT

# 用 node 做替换，避免 sed 在含 / & 的密钥上出错
node -e '
const fs = require("fs");
const [src, dst] = process.argv.slice(1);
let s = fs.readFileSync(src, "utf8");
const map = {
  "__FEISHU_APP_ID__":     process.env.FEISHU_APP_ID,
  "__FEISHU_APP_SECRET__": process.env.FEISHU_APP_SECRET,
  "__FEISHU_CHAT_ID__":    process.env.FEISHU_CHAT_ID,
  "__DSH_BIN__":           process.env.DSH_BIN,
  "__WORKTREE_ROOT__":     process.env.WORKTREE_ROOT,
  "__AGENT_HOME__":        process.env.AGENT_HOME,
};
for (const [k, v] of Object.entries(map)) {
  if (v === undefined) {
    // --skip-feishu 时飞书那三个占位符允许缺省。
    // 注意不能替换成空串：__FEISHU_CHAT_ID__ 还作为对象键出现
    // （groups: { __FEISHU_CHAT_ID__: {} }），空串会让 JSON5 变成 { : {} } 直接解析失败。
    // 换成合法标识符占位即可 —— 这些块在下一步会被整块删掉。
    if (process.env.SKIP_FEISHU === "1" && k.startsWith("__FEISHU_")) {
      s = s.split(k).join("__SKIPPED_FEISHU__");
      continue;
    }
    console.error("未设置: " + k); process.exit(3);
  }
  s = s.split(k).join(v.replace(/\\/g, "\\\\"));
}
fs.writeFileSync(dst, s);
' "$TOPOLOGY_FILE" "$RENDERED"

# ── 2. 解析 + 深合并 ───────────────────────────────────────────
cp -p "$CONFIG_FILE" "$BAK"

node -e '
const fs = require("fs");
const JSON5 = require(process.argv[1] + "/node_modules/json5");
const [topoPath, cfgPath, outPath] = process.argv.slice(2);
const topo = JSON5.parse(fs.readFileSync(topoPath, "utf8"));
const cfg  = JSON5.parse(fs.readFileSync(cfgPath, "utf8"));

// --skip-feishu：还没建飞书应用时，先把 ACP 层落地。
// 飞书相关的四块都依赖 chat_id / App 凭证，整体跳过；
// channels.defaults.botLoopProtection 与渠道无关，保留。
if (process.env.SKIP_FEISHU === "1") {
  if (topo.plugins?.entries) delete topo.plugins.entries.feishu;
  if (topo.channels) delete topo.channels.feishu;
  delete topo.bindings;
  delete topo.broadcast;
}

const isPlain = (v) => v && typeof v === "object" && !Array.isArray(v);

// 深合并：对象递归；数组整体替换（数组语义是"这份配置项就该长这样"）
function merge(base, patch) {
  const out = isPlain(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlain(v) && isPlain(out[k]) ? merge(out[k], v) : v;
  }
  return out;
}

const merged = merge(cfg, topo);
// 保留原文件里的键序更稳，但语义正确优先；这里直接写合并结果
fs.writeFileSync(outPath, JSON.stringify(merged, null, 2) + "\n");
' "$OC_ROOT" "$RENDERED" "$CONFIG_FILE" "$MERGED"

if [[ $DRY_RUN -eq 1 ]]; then
  print -- "── 合并结果（未写入）────────────────────────────"
  # 只展示本次拓扑涉及的顶层键，并对密钥脱敏
  node -e '
    const fs=require("fs"); const JSON5=require(process.argv[1]+"/node_modules/json5");
    const cfg=JSON5.parse(fs.readFileSync(process.argv[2],"utf8"));
    const keys=["acp","plugins","worktreeRoot","worktreeAcceleration","agents","bindings","broadcast","tools","channels"];
    const pick={}; for(const k of keys) if(k in cfg) pick[k]=cfg[k];
    if(pick.channels?.feishu?.appSecret) pick.channels.feishu.appSecret="<REDACTED>";
    if(pick.plugins?.entries?.acpx?.config?.agents) { /* 无密钥 */ }
    console.log(JSON.stringify(pick,null,2));
  ' "$OC_ROOT" "$MERGED"
  print -- ""
  print -- "dry-run：配置未改动。"
  exit 0
fi

cp "$MERGED" "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE"

# ── 3. 校验；失败回滚 ──────────────────────────────────────────
if "$OPENCLAW_BIN" config validate >/tmp/oc-validate.out 2>&1; then
  print -- "✅ 拓扑已应用并通过校验"
  print -- "   配置: $CONFIG_FILE"
  print -- "   备份: $BAK"
  grep -E "warning|!" /tmp/oc-validate.out 2>/dev/null | head -10 || true
else
  cp -p "$BAK" "$CONFIG_FILE"
  print -u2 -- "❌ 校验失败，已回滚到合并前状态。校验输出："
  cat /tmp/oc-validate.out >&2
  exit 1
fi
