#!/bin/zsh
#
# e2e-resume.sh —— 真实中断恢复验证（S2 的端到端证据）
#
# 为什么需要它：resume 之前只有单元测试覆盖 `stepCompleted()` 这个函数，
# 从没验证过"服务真的被杀 → 重启 → 接着跑且不重跑已完成步骤"。
# 单测通过 ≠ 端到端可用，这个脚本补的就是那个缺口。
#
# 做法：
#   1. 提交一个带仓库的真实任务（会经过 provisioning → plan → code → …）
#   2. 轮询到 plan 步骤落盘后，**kill 掉 runner 进程**（模拟崩溃/重启）
#   3. 记录 plan/meta.json 的 mtime 作为基线
#   4. 重启 runner，让它 resume 同一个任务
#   5. 断言：任务跑到终态，且 plan 的 meta.json **未被重写**
#
# 退出码：0 通过 / 1 断言失败 / 2 环境不满足

set -u
emulate -L zsh 2>/dev/null || true

TASKCTL_DIR="${TASKCTL_DIR:-$HOME/Workspace/openclaw-multiagent/taskctl}"
STATE="${MA_STATE_ROOT:-$HOME/.local/state/openclaw-multiagent}"
LABEL="ai.openclaw.multiagent-runner"
REPO="${E2E_REPO:-$HOME/dsh-playgroud/.scratch-orch-repo}"
TASKCTL="$HOME/bin/taskctl"

die()  { print -u2 -- "e2e-resume: $*"; exit "${2:-1}"; }
log()  { print -- "[e2e] $*"; }

[[ -x "$TASKCTL" ]] || die "找不到 taskctl: $TASKCTL" 2
[[ -d "$REPO" ]]    || die "找不到测试仓库: $REPO（用 E2E_REPO 覆盖）" 2
launchctl list 2>/dev/null | grep -q "$LABEL" || die "runner 服务未加载（先 launchctl bootstrap）" 2

phase_of() {
  python3 -c "
import json,sys
try: print(json.load(open('$STATE/tasks/$1/status.json'))['phase'])
except: print('?')" 2>/dev/null
}

mtime_of() { stat -f '%m' "$STATE/tasks/$1/steps/plan/meta.json" 2>/dev/null || echo 0; }

# 清理：不留测试任务
cleanup() {
  [[ -n "${TASK:-}" ]] && rm -rf "$STATE/tasks/$TASK" 2>/dev/null
}
trap cleanup EXIT

log "提交任务（repo=$REPO）"
TASK=$("$TASKCTL" submit --message "在 calc.py 里新增 divide(a,b) 函数并补一个 pytest 用例" \
        --repo "$REPO" --max-steps 10 --max-wall-clock 900 --max-fix 1 2>/dev/null | tail -1)
[[ -n "$TASK" ]] || die "submit 未返回 taskId"
log "taskId=$TASK"

log "等待 plan 步骤落盘（最多 180s）..."
for i in $(seq 1 60); do
  sleep 3
  if [[ -f "$STATE/tasks/$TASK/steps/plan/meta.json" ]]; then
    log "plan 已完成（${i}×3s）"
    break
  fi
done
[[ -f "$STATE/tasks/$TASK/steps/plan/meta.json" ]] || die "超时未见 plan 落盘（任务卡在 $(phase_of $TASK)）"

PHASE_BEFORE=$(phase_of "$TASK")
MTIME_BEFORE=$(mtime_of "$TASK")
log "中断前 phase=$PHASE_BEFORE　plan/meta.json mtime=$MTIME_BEFORE"

log "停机 runner（模拟崩溃/重启）"
# 用 bootout 而不是 kill：KeepAlive 会在 1 秒内把被 kill 的进程拉回来，
# 拿不到可观测的停机窗口。bootout 停止服务且保持停止，才是可靠的中断。
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null
sleep 2
pkill -9 -f "runner.mjs" 2>/dev/null
sleep 2
if pgrep -f "runner.mjs" >/dev/null; then die "runner 未停机（PID $(pgrep -f runner.mjs | tr '\n' ' '))"; fi
log "  runner 已停机"

PHASE_KILLED=$(phase_of "$TASK")
log "kill 后 phase=$PHASE_KILLED（应仍为非终态）"
[[ "$PHASE_KILLED" != "done" && "$PHASE_KILLED" != "failed" ]] \
  || die "任务在 kill 前已到终态（$PHASE_KILLED），无法验证恢复"

log "重启 runner"
launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null || launchctl kickstart -k "gui/$UID/$LABEL" 2>/dev/null
for i in $(seq 1 20); do
  sleep 2
  pgrep -f "runner.mjs" >/dev/null && break
done
pgrep -f "runner.mjs" >/dev/null || die "runner 未恢复运行"
log "  runner 已恢复（PID $(pgrep -f runner.mjs | head -1)）"

log "等待任务恢复并跑到终态（最多 600s）..."
FINAL="?"
for i in $(seq 1 120); do
  sleep 5
  FINAL=$(phase_of "$TASK")
  case "$FINAL" in done|failed|cancelled) break;; esac
done
log "最终 phase=$FINAL"

# ── 断言 ──────────────────────────────────────────────────
FAIL=0
if [[ "$FINAL" != "done" ]]; then
  print -u2 -- "❌ 断言失败：任务未恢复完成（phase=$FINAL）"
  "$TASKCTL" report "$TASK" 2>&1 | head -12 | sed 's/^/    /'
  FAIL=1
fi

MTIME_AFTER=$(mtime_of "$TASK")
if [[ "$MTIME_BEFORE" != "$MTIME_AFTER" ]]; then
  print -u2 -- "❌ 断言失败：plan/meta.json 被重写（$MTIME_BEFORE → $MTIME_AFTER）"
  FAIL=1
fi

# 该步的 mtime 不该变，且步骤目录不应多出 plan 的重跑痕迹
STEPS=$(ls "$STATE/tasks/$TASK/steps" 2>/dev/null | tr '\n' ' ')
log "步骤目录: $STEPS"

if [[ $FAIL -eq 0 ]]; then
  log "✅ S2 通过：中断后恢复完成，且已完成步骤未被重跑"
  exit 0
fi
exit 1
