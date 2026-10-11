#!/bin/zsh
#
# orchestrator.sh —— OpenClaw 多智能体开发编排器
#
# 负责四件事（对应需求的 2/3/4 条）：
#   1. 工作树池：为每个活跃编码智能体分配物理隔离的独立工作区
#   2. 环境隔离：调用 .openclaw/worktree-setup.sh 做 Python/Node/Java 本地依赖解析
#   3. 测试门控：跑测试套件，只有 100% 通过才写出 gate 通行证
#   4. 双模式合并：AI 自动合并 / 人工干预合并（/merge），两者都受 gate 约束
#
# 设计原则：
#   * 门控 fail-closed：任何一步不确定都拒绝合并，而不是放行
#   * 门控绑定 HEAD：测试通过时记录的 commit sha 必须等于合并时的 HEAD，防止"测完又改"
#   * Git 锁退避：index.lock / worktree 锁冲突用指数退避重试，而非直接失败
#   * 分层退出码：0 成功 / 2 用法错 / 3 前置缺失 / 4 门控未过 / 5 git 冲突 / 6 锁超时
#
# 用法：orchestrator.sh <命令> [参数]
#   new <task> [--repo R] [--base REF] [--layout managed|inrepo] [--agent NAME]
#   env <task>                     重新初始化隔离环境（含补跑延后项）
#   test <task>                    跑测试门控
#   gate <task>                    查看门控状态
#   merge <task> [--as ai|human] [--push] [--force-gate]
#   clean <task> [--force]         清理工作树（保留 OpenClaw 快照）
#   gc                             openclaw worktrees gc + git worktree prune
#   list / status <task>
#
# macOS /bin/zsh 5.9，只用 POSIX 子集 + zsh 数组。

emulate -L zsh 2>/dev/null || true
set -u

VERSION="1.0.0"

# ── 退出码（分层，便于上层脚本区分"拒绝"与"故障"）──────────────
EX_OK=0; EX_USAGE=2; EX_PRECOND=3; EX_GATE=4; EX_CONFLICT=5; EX_LOCK=6

die()  { local code="$1"; shift; print -u2 -- "orchestrator: $*"; exit "$code"; }
log()  { print -- "[orch] $*"; }
warn() { print -u2 -- "[orch] $*" }

OPENCLAW_BIN="${OPENCLAW_BIN:-$HOME/bin/openclaw}"

# ════════════════════════════════════════════════════════════════
# Git 锁退避重试
# 场景：并发 agent 同时操作仓库时，git 会因 .git/index.lock、worktree 锁、
#      gc.pid 等报 "Unable to create ... .lock: File exists" 或
#      "another git process seems to be running"。这类是**瞬时**冲突，
#      应当退避重试；而真正的冲突（merge conflict）必须立刻停下报告。
# ════════════════════════════════════════════════════════════════
git_retry() {
  local max="${GIT_RETRY_MAX:-5}" base="${GIT_RETRY_BASE:-1}"
  local attempt=1 delay out rc
  while true; do
    out="$( "$@" 2>&1 )"; rc=$?
    if [[ $rc -eq 0 ]]; then print -- "$out"; return 0; fi

    # 真冲突 / 真错误：不重试，原样上报
    if print -- "$out" | grep -qiE "CONFLICT|Merge conflict|not something we can merge|could not resolve host"; then
      print -u2 -- "$out"; return $rc
    fi
    # 锁竞争：退避重试
    if print -- "$out" | grep -qiE "index\.lock|Unable to create .*\.lock|another git process|gc\.pid|is locked|already locked|lock file already exists"; then
      if [[ $attempt -ge $max ]]; then
        warn "Git 锁竞争重试 $max 次仍失败，放弃。最后一次输出："
        print -u2 -- "$out"
        return $EX_LOCK
      fi
      delay=$(( base * attempt ))
      warn "Git 锁竞争（第 $attempt/$max 次），${delay}s 后重试…"
      sleep "$delay"
      attempt=$(( attempt + 1 ))
      continue
    fi
    # 其它错误：原样返回
    print -u2 -- "$out"; return $rc
  done
}

# ════════════════════════════════════════════════════════════════
# 路径与状态
# ════════════════════════════════════════════════════════════════
REPO="${ORCH_REPO:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[[ -n "$REPO" ]] || die $EX_PRECOND "当前目录不在 git 仓库内，且未指定 ORCH_REPO"
STATE="${ORCH_STATE:-$REPO/.agents}"
TASKS="$STATE/tasks"; GATES="$STATE/gates"
mkdir -p "$TASKS" "$GATES" || die $EX_PRECOND "无法创建状态目录 $STATE"

task_file() { print -- "$TASKS/$1.json"; }
gate_file() { print -- "$GATES/$1.json"; }

# 读任务字段：task_get <task> <key>
task_get() {
  local f; f="$(task_file "$1")"
  [[ -f "$f" ]] || return 1
  jq -r --arg k "$2" '.[$k] // empty' "$f"
}

task_exists() { [[ -f "$(task_file "$1")" ]]; }

require_task() {
  task_exists "$1" || die $EX_PRECOND "任务不存在: $1（先跑 orchestrator.sh new $1）"
}

# 把编排器自己的状态目录写进仓库本地排除表，避免它让仓库永远"脏"。
# 用 .git/info/exclude 而不是 .gitignore：这是本地约定，不该进版本历史、
# 也不该替用户决定他的 .gitignore 长什么样。
ensure_excluded() {
  local repo="$1" entry="$2"
  local common
  common="$(git -C "$repo" rev-parse --git-common-dir 2>/dev/null)" || return 0
  [[ "$common" != /* ]] && common="$repo/$common"
  local ex="$common/info/exclude"
  mkdir -p "$common/info" 2>/dev/null || return 0
  [[ -f "$ex" ]] || : > "$ex" 2>/dev/null || return 0
  grep -qxF "$entry" "$ex" 2>/dev/null && return 0
  print -- "$entry" >> "$ex" 2>/dev/null || return 0
  log "已把 $entry 写入 $(basename "$common")/info/exclude（本地排除，不进版本库）"
}

# 计算工作区内容指纹：<HEAD>:<工作区 tree sha>
#
# 为什么不能只比对 HEAD：agent 完全可以在测试通过之后继续改文件但不提交。
# 此时 HEAD 不变，只比 HEAD 的门控看起来依然有效，被改动的代码却被放行合并 ——
# 测试等于没跑。所以指纹必须覆盖全部工作区内容（含未跟踪文件的内容）。
# 做法是用一个临时索引跑 git add -A + write-tree，不动用户真正的索引。
worktree_fingerprint() {
  local wt="$1" tmpidx tree head rc
  head="$(git -C "$wt" rev-parse HEAD 2>/dev/null)"
  [[ -n "$head" ]] || return 1
  tmpidx="$(mktemp -t orch-idx)"
  rm -f "$tmpidx"   # git 要自己创建索引文件；预先存在的空文件会被判为损坏
  # ⚠ 这里不能用 ':(exclude).venv' 这类路径规格来排除隔离目录：
  #   当该路径同时被项目的 .gitignore 忽略时，git 会以
  #   "The following paths are ignored by one of your .gitignore files" 直接失败。
  #   一次失败的 add 会让 write-tree 产出错误/空树 —— 不同内容得到相同指纹，
  #   门控就彻底失效。所以隔离目录改由 .git/info/exclude 排除
  #   （见 ensure_isolation_excludes），这里只做普通 add，并硬校验退出码。
  GIT_INDEX_FILE="$tmpidx" git -C "$wt" add -A -- . >/dev/null 2>&1
  rc=$?
  if [[ $rc -ne 0 ]]; then
    rm -f "$tmpidx"
    warn "指纹计算失败：git add 退出码 $rc（工作树 $wt）"
    return 1
  fi
  tree="$(GIT_INDEX_FILE="$tmpidx" git -C "$wt" write-tree 2>/dev/null)"
  rm -f "$tmpidx"
  [[ -n "$tree" ]] || { warn "指纹计算失败：write-tree 无输出"; return 1; }
  print -- "${head}:${tree}"
}

# 把隔离层目录写进仓库本地排除表。
# 用 .git/info/exclude 而不是项目的 .gitignore：这是本地约定，不该进版本历史，
# 也不该替用户决定他的 .gitignore 长什么样。info/exclude 由同一仓库的所有工作树
# 共享，所以每个仓库只需写一次。
ensure_isolation_excludes() {
  local repo="$1"
  ensure_excluded "$repo" ".venv/"
  ensure_excluded "$repo" "node_modules/"
  ensure_excluded "$repo" ".m2_local/"
  ensure_excluded "$repo" ".agents/"
  # 环境隔离产生的中间标记：本机产物，不该进版本历史
  ensure_excluded "$repo" ".openclaw/.venv-stamp"
  ensure_excluded "$repo" ".openclaw/env-setup.pending"
}

# ════════════════════════════════════════════════════════════════
# 命令：new —— 分配隔离工作树 + 初始化环境
# ════════════════════════════════════════════════════════════════
cmd_new() {
  local task="" repo="$REPO" base="HEAD" layout="managed" agent="coder"
  local managed_id=""
  task="${1:-}"; shift 2>/dev/null || true
  [[ -n "$task" ]] || die $EX_USAGE "用法: orchestrator.sh new <task_id> [--repo R] [--base REF] [--layout managed|inrepo] [--agent NAME]"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repo)   repo="$2"; shift 2 ;;
      --base)   base="$2"; shift 2 ;;
      --layout) layout="$2"; shift 2 ;;
      --agent)  agent="$2"; shift 2 ;;
      *) die $EX_USAGE "未知参数: $1" ;;
    esac
  done

  # task_id 必须能安全用作分支名与目录名
  [[ "$task" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || die $EX_USAGE "task_id 只允许 [a-z0-9-]，首字符为字母数字，最长 63：$task"
  task_exists "$task" && die $EX_PRECOND "任务已存在: $task（先 clean 或换个 id）"

  repo="$(cd "$repo" && git rev-parse --show-toplevel)" || die $EX_PRECOND "不是 git 仓库: $repo"

  # 编排器自己的状态目录（含仓库内工作树）先本地排除掉，
  # 否则它会一直出现在 git status 里，把"源仓库必须干净"的合并前置检查永远卡死。
  ensure_isolation_excludes "$repo"
  local rel_state="${STATE#$repo/}"
  [[ "$rel_state" != "$STATE" ]] && ensure_excluded "$repo" "/${rel_state}/"

  # 源仓库必须干净，否则工作树会带着未提交改动，污染隔离性
  if [[ -n "$(git -C "$repo" status --porcelain)" ]]; then
    warn "源仓库有未提交改动，工作树会从 $base 新建（不含这些改动）"
  fi

  local wt="" branch="" kind=""
  if [[ "$layout" == "managed" && -x "$OPENCLAW_BIN" ]]; then
    # 优先用 OpenClaw 原生托管工作树：APFS 克隆加速 + 自动快照 + 统一 GC
    log "分配 OpenClaw 托管工作树（--name $task）"
    local jout
    if jout="$(git_retry "$OPENCLAW_BIN" worktrees create "$repo" --name "$task" --base-ref "$base" --json)"; then
      wt="$(print -- "$jout" | jq -r '.path // .worktreePath // .worktree // empty' 2>/dev/null)"
      branch="$(print -- "$jout" | jq -r '.branch // empty' 2>/dev/null)"
      # 记下托管 id：`worktrees remove` 要的是 UUID 而不是 name
      managed_id="$(print -- "$jout" | jq -r '.id // empty' 2>/dev/null)"
      kind="managed"
    else
      warn "openclaw worktrees create 失败，回退到仓库内 git worktree"
    fi
  fi

  if [[ -z "$wt" ]]; then
    # 回退路径：用户原始规格的仓库内布局 .agents/worktree_<task_id>
    kind="inrepo"
    branch="agent/$task"
    wt="$repo/.agents/worktree_$task"
    if git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
      die $EX_PRECOND "分支已存在: $branch"
    fi
    mkdir -p "$repo/.agents"
    log "创建 git worktree: $wt（分支 $branch，基于 $base）"
    git_retry git -C "$repo" worktree add -b "$branch" "$wt" "$base" >/dev/null || die $EX_PRECOND "git worktree add 失败"
  fi

  [[ -d "$wt" ]] || die $EX_PRECOND "工作树目录不存在: $wt"

  # 落任务记录
  jq -n \
    --arg id "$task" --arg repo "$repo" --arg wt "$wt" --arg br "$branch" \
    --arg kind "$kind" --arg agent "$agent" --arg base "$base" \
    --arg created "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg mid "$managed_id" \
    '{id:$id, repo:$repo, worktree:$wt, branch:$br, kind:$kind,
      agent:$agent, base_ref:$base, created_at:$created,
      managed_id:$mid, state:"allocated"}' > "$(task_file "$task")"

  log "任务 $task → $wt"
  cmd_env "$task"
  print -- "$wt"
}

# ════════════════════════════════════════════════════════════════
# 命令：env —— 语言级环境隔离（复用仓库内的 setup 脚本）
# ════════════════════════════════════════════════════════════════
cmd_env() {
  local task="${1:-}"; [[ -n "$task" ]] || die $EX_USAGE "用法: orchestrator.sh env <task_id>"
  require_task "$task"
  local wt; wt="$(task_get "$task" worktree)"
  [[ -d "$wt" ]] || die $EX_PRECOND "工作树已不存在: $wt"

  local setup="$wt/.openclaw/worktree-setup.sh"
  if [[ ! -x "$setup" ]]; then
    warn "工作树内没有可执行的 .openclaw/worktree-setup.sh，跳过环境隔离"
    warn "（把 repo-template/.openclaw/worktree-setup.sh 放进源仓库即可启用）"
    return 0
  fi

  log "环境隔离：$task（无软截止，可跑重活）"
  # 关键：清掉 deadline，让 pip/pnpm/mvn 跑完；并显式传 OpenClaw 契约变量
  (
    cd "$wt" || exit 1
    ENV_SETUP_DEADLINE=0 \
    OPENCLAW_WORKTREE_PATH="$wt" \
    OPENCLAW_SOURCE_TREE_PATH="$(task_get "$task" repo)" \
    "$setup"
  )
  local rc=$?
  jq --arg s "$([[ $rc -eq 0 ]] && echo ready || echo env_failed)" \
     '.state=$s' "$(task_file "$task")" > "$(task_file "$task").tmp" && mv "$(task_file "$task").tmp" "$(task_file "$task")"
  return $rc
}

# ════════════════════════════════════════════════════════════════
# 测试命令探测
# ════════════════════════════════════════════════════════════════
# 探测测试命令：detect_test_cmd <worktree> → 打印命令；找不到打印空
detect_test_cmd() {
  local wt="$1"
  if [[ -f "$wt/pom.xml" || -f "$wt/build.gradle" || -f "$wt/build.gradle.kts" ]]; then
    if [[ -x "$wt/mvnw" ]]; then
      print -- "./mvnw -q -B -Dmaven.repo.local=$wt/.m2_local -Dmaven.repo.local.tail=$HOME/.m2/repository test"
    elif [[ -f "$wt/pom.xml" ]]; then
      print -- "mvn -q -B -Dmaven.repo.local=$wt/.m2_local -Dmaven.repo.local.tail=$HOME/.m2/repository test"
    else
      print -- "./gradlew test"
    fi
    return
  fi
  if [[ -f "$wt/package.json" ]]; then
    if jq -e '.scripts.test' "$wt/package.json" >/dev/null 2>&1; then
      print -- "pnpm test"
      return
    fi
  fi
  if [[ -x "$wt/.venv/bin/python" ]] && \
     { [[ -f "$wt/pytest.ini" || -f "$wt/tox.ini" || -f "$wt/setup.cfg" ]] || grep -qs '\[tool.pytest' "$wt/pyproject.toml" 2>/dev/null || [[ -d "$wt/tests" ]]; }; then
    print -- ".venv/bin/python -m pytest -q"
    return
  fi
  if [[ -f "$wt/Cargo.toml" ]]; then print -- "cargo test --quiet"; return; fi
  if [[ -f "$wt/go.mod" ]];      then print -- "go test ./..."; return; fi
  print -- ""
}

# ════════════════════════════════════════════════════════════════
# 命令：test —— 测试门控
# 规则：只有整套测试退出码为 0（= 100% 通过）才写出通行证，
#       并把当时的 HEAD sha 一并封进去，防止"测完又改代码"。
# ════════════════════════════════════════════════════════════════
cmd_test() {
  local task="${1:-}"; [[ -n "$task" ]] || die $EX_USAGE "用法: orchestrator.sh test <task_id>"
  require_task "$task"
  local wt; wt="$(task_get "$task" worktree)"
  [[ -d "$wt" ]] || die $EX_PRECOND "工作树已不存在: $wt"

  local cmd; cmd="$(detect_test_cmd "$wt")"
  [[ -n "$cmd" ]] || die $EX_PRECOND "在 $wt 里识别不出测试套件（无 pytest/jest/mvn/cargo/go 迹象）"

  local head; head="$(git -C "$wt" rev-parse HEAD 2>/dev/null)"
  [[ -n "$head" ]] || die $EX_PRECOND "无法读取工作树 HEAD"
  # 门控绑的是"工作区内容指纹"而不是 HEAD：见 worktree_fingerprint 的说明
  local fp; fp="$(worktree_fingerprint "$wt")"
  [[ -n "$fp" ]] || die $EX_PRECOND "无法计算工作区指纹"

  # 环境若还有延后项，先补跑，避免拿"半装好"的环境去测
  if [[ -s "$wt/.openclaw/env-setup.pending" ]]; then
    log "检测到未完成的环境初始化，先补跑"
    cmd_env "$task" || warn "环境补跑未成功，继续测试（结果可能失真）"
  fi

  log "测试门控：$task"
  log "命令: $cmd"
  log "HEAD: $head"

  local out rc start dur
  start=$(date +%s)
  out="$( (cd "$wt" && eval "$cmd") 2>&1 )"; rc=$?
  dur=$(( $(date +%s) - start ))
  print -- "$out" | tail -30

  # 汇总：把常见测试框架的结果行抽出来，便于群聊里直接看
  local summary
  summary="$(print -- "$out" | grep -iE "passed|failed|error|tests? run|BUILD SUCCESS|BUILD FAILURE|^ok |FAIL" | tail -5 | tr '\n' ' ' || true)"

  local passed=false
  [[ $rc -eq 0 ]] && passed=true

  jq -n \
    --arg id "$task" --arg wt "$wt" --arg head "$head" --arg cmd "$cmd" \
    --arg fp "$fp" \
    --argjson rc "$rc" --argjson passed "$passed" \
    --argjson dur "$dur" --arg summary "$summary" \
    --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{task_id:$id, worktree:$wt, head_sha:$head, fingerprint:$fp, test_cmd:$cmd,
      exit_code:$rc, passed:$passed, duration_s:$dur,
      summary:$summary, tested_at:$at,
      policy:"exit_code==0 means 100% pass; fingerprint 必须与合并时一致"}' > "$(gate_file "$task")"

  if [[ "$passed" == true ]]; then
    jq '.state="tested_pass"' "$(task_file "$task")" > "$(task_file "$task").tmp" && mv "$(task_file "$task").tmp" "$(task_file "$task")"
    log "✅ 门控通过（${dur}s）：$summary"
    return $EX_OK
  else
    jq '.state="tested_fail"' "$(task_file "$task")" > "$(task_file "$task").tmp" && mv "$(task_file "$task").tmp" "$(task_file "$task")"
    warn "❌ 门控未通过（exit=$rc，${dur}s）：$summary"
    return $EX_GATE
  fi
}

# ════════════════════════════════════════════════════════════════
# 命令：gate —— 查看门控状态
# ════════════════════════════════════════════════════════════════
cmd_gate() {
  local task="${1:-}"; [[ -n "$task" ]] || die $EX_USAGE "用法: orchestrator.sh gate <task_id>"
  require_task "$task"
  local gf; gf="$(gate_file "$task")"
  if [[ ! -f "$gf" ]]; then
    warn "没有门控记录：$task（先跑 orchestrator.sh test $task）"
    return $EX_GATE
  fi
  jq '.' "$gf"

  # 关键校验：工作区内容指纹是否仍与测试时一致。
  # 只比 HEAD 会漏掉"测试后改了文件但没提交"这种情况 —— 那正是最常见的绕过方式。
  local wt now rec
  wt="$(task_get "$task" worktree)"
  rec="$(jq -r '.fingerprint // ""' "$gf")"
  now="$(worktree_fingerprint "$wt")"
  if [[ -z "$rec" || "$now" != "$rec" ]]; then
    warn "⚠ 门控已失效：测试时指纹=$rec，当前指纹=$now"
    warn "   （测试之后工作区内容变过，必须重跑 test 才能合并）"
    return $EX_GATE
  fi
  jq -e '.passed==true' "$gf" >/dev/null || { warn "⚠ 门控未通过"; return $EX_GATE; }
  log "✅ 门控有效且通过"
}

# ════════════════════════════════════════════════════════════════
# 命令：merge —— 双模式合并
#   --as ai     AI 驱动：门控必须通过，且 HEAD 必须与测试时一致
#   --as human  人工干预（/merge 命令走这条）：同样受门控约束，
#               除非显式 --force-gate（留痕，事后可审计）
# ════════════════════════════════════════════════════════════════
cmd_merge() {
  local task="${1:-}"; shift 2>/dev/null || true
  [[ -n "$task" ]] || die $EX_USAGE "用法: orchestrator.sh merge <task_id> [--as ai|human] [--push] [--force-gate]"
  local as="ai" push=0 force_gate=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --as)         as="$2"; shift 2 ;;
      --push)       push=1; shift ;;
      --force-gate) force_gate=1; shift ;;
      *) die $EX_USAGE "未知参数: $1" ;;
    esac
  done
  [[ "$as" == "ai" || "$as" == "human" ]] || die $EX_USAGE "--as 只能是 ai 或 human"

  require_task "$task"
  local repo wt branch
  repo="$(task_get "$task" repo)"; wt="$(task_get "$task" worktree)"; branch="$(task_get "$task" branch)"
  [[ -d "$wt" ]] || die $EX_PRECOND "工作树已不存在: $wt"

  # ── 1. 门控校验（fail-closed）────────────────────────────────
  local gf; gf="$(gate_file "$task")"
  if [[ $force_gate -eq 1 && "$as" != "human" ]]; then
    die $EX_USAGE "--force-gate 仅允许与 --as human 同时使用"
  fi
  if [[ ! -f "$gf" ]]; then
    [[ $force_gate -eq 1 ]] || die $EX_GATE "没有门控记录，拒绝合并。先跑: orchestrator.sh test $task"
    warn "⚠ --force-gate：绕过门控（无测试记录）"
  else
    local passed rec now
    passed="$(jq -r '.passed' "$gf")"
    rec="$(jq -r '.fingerprint // ""' "$gf")"
    now="$(worktree_fingerprint "$wt")"
    if [[ "$passed" != "true" ]]; then
      [[ $force_gate -eq 1 ]] || die $EX_GATE "测试未通过，拒绝合并（门控记录见 $gf）"
      warn "⚠ --force-gate：测试未通过仍继续"
    elif [[ -z "$rec" || "$now" != "$rec" ]]; then
      [[ $force_gate -eq 1 ]] || die $EX_GATE "门控失效：工作区内容在测试之后变过（$rec → $now）。请重跑: orchestrator.sh test $task"
      warn "⚠ --force-gate：工作区指纹已变（$rec → $now）"
    fi
  fi

  # ── 2. 目标仓库前置检查 ──────────────────────────────────────
  local cur
  cur="$(git -C "$repo" rev-parse --abbrev-ref HEAD)"
  [[ "$cur" != "$branch" ]] || die $EX_PRECOND "目标仓库当前就在 $branch 上，无法合并自身"

  # 自愈：老任务可能是本功能加入之前建的，这里补一次本地排除
  ensure_isolation_excludes "$repo"
  ensure_excluded "$repo" "/.agents/"

  local dirty
  dirty="$(git -C "$repo" status --porcelain)"
  if [[ -n "$dirty" ]]; then
    warn "目标仓库有未提交改动，拒绝合并以免污染："
    print -u2 -- "$dirty" | head -10
    die $EX_PRECOND "请先在 $repo 提交或 stash"
  fi

  # ── 3. 提交工作树里未提交的产出 ──────────────────────────────
  if [[ -n "$(git -C "$wt" status --porcelain)" ]]; then
    log "工作树有未提交改动，自动提交为一个 commit"
    # 隔离层目录（.venv / node_modules / .m2_local / .agents）由
    # ensure_isolation_excludes 写进 .git/info/exclude 排除，所以这里用普通 add。
    # 不能用 ':(exclude)...' 路径规格：路径同时被项目 .gitignore 忽略时 git 会报错。
    git_retry git -C "$wt" add -A -- . >/dev/null || die $EX_CONFLICT "git add 失败"
    git_retry git -C "$wt" commit -q -m "chore($task): agent 产出（$as 模式合并前自动提交）" >/dev/null || warn "提交失败或无可提交内容"
  fi

  # ── 4. 合并 ─────────────────────────────────────────────────
  log "合并 $branch → $cur（模式：$as）"
  local mo
  if mo="$(git_retry git -C "$repo" merge --no-ff -m "merge($task): $as 模式合并（门控 $( [[ -f "$gf" ]] && jq -r '.head_sha[0:8]' "$gf" || echo none) )" "$branch")"; then
    log "✅ 合并成功"
  else
    warn "合并失败（可能是真冲突），目标仓库保持原样，请人工处理："
    print -u2 -- "$mo" | head -20
    git -C "$repo" merge --abort 2>/dev/null || true
    jq --arg s "merge_conflict" '.state=$s' "$(task_file "$task")" > "$(task_file "$task").tmp" && mv "$(task_file "$task").tmp" "$(task_file "$task")"
    return $EX_CONFLICT
  fi

  # ── 5. 推送 ─────────────────────────────────────────────────
  if [[ $push -eq 1 ]]; then
    if git_retry git -C "$repo" push origin "$cur" >/dev/null; then
      log "已推送 origin/$cur"
    else
      warn "推送失败（保留本地提交，未做 force）"
    fi
  fi

  jq --arg s "merged" --arg m "$as" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
     '.state=$s | .merged_as=$m | .merged_at=$at' "$(task_file "$task")" > "$(task_file "$task").tmp" && mv "$(task_file "$task").tmp" "$(task_file "$task")"
  return $EX_OK
}

# ════════════════════════════════════════════════════════════════
# 命令：clean / gc —— 清理，防磁盘膨胀
# ════════════════════════════════════════════════════════════════
cmd_clean() {
  local task="${1:-}"; shift 2>/dev/null || true
  [[ -n "$task" ]] || die $EX_USAGE "用法: orchestrator.sh clean <task_id> [--force]"
  local force=0
  [[ "${1:-}" == "--force" ]] && force=1
  require_task "$task"

  local repo wt kind
  repo="$(task_get "$task" repo)"; wt="$(task_get "$task" worktree)"; kind="$(task_get "$task" kind)"

  # 有未合并的产出就别默默删掉。
  # 注意：这里刻意拆成几步、避免"双引号内嵌多层 $() 再套单引号"的写法 ——
  # zsh 解析不了那种嵌套（会报 unmatched "），bash 能过，所以很容易踩。
  local branch_name head_sha unmerged
  branch_name="$(task_get "$task" branch)"
  head_sha="$(git -C "$repo" rev-parse HEAD 2>/dev/null)"
  unmerged=0
  if [[ -n "$head_sha" ]]; then
    unmerged="$(git -C "$repo" rev-list --count "${head_sha}..${branch_name}" 2>/dev/null || echo 0)"
  fi
  if [[ "$unmerged" != "0" && $force -eq 0 ]]; then
    warn "分支 ${branch_name} 上还有 $unmerged 个未合并提交；OpenClaw 托管工作树会先打快照。"
    warn "确认要清理请加 --force"
    return $EX_PRECOND
  fi

  if [[ "$kind" == "managed" && -x "$OPENCLAW_BIN" ]]; then
    # OpenClaw 会先做快照再删除，30 天内可 restore。
    # 注意：`worktrees remove` 收的是 UUID，不是 --name 创建时用的名字。
    local wid; wid="$(task_get "$task" managed_id)"
    if [[ -z "$wid" ]]; then
      # 老任务记录里没存 id：按路径反查
      wid="$("$OPENCLAW_BIN" worktrees list --json 2>/dev/null | jq -r --arg wt "$wt" '.worktrees[]? | select(.path==$wt) | .id' 2>/dev/null | head -1)"
    fi
    if [[ -n "$wid" ]] && git_retry "$OPENCLAW_BIN" worktrees remove "$wid" --json >/dev/null 2>&1; then
      log "已通过 OpenClaw 移除托管工作树 $task（id=$wid，保留可恢复快照）"
    else
      warn "openclaw worktrees remove 未成功（id=${wid:-未找到}），回退 git worktree remove"
      git_retry git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1 || true
    fi
  else
    log "移除仓库内工作树 $wt"
    git_retry git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1 || { warn "worktree remove 失败，改为直接删目录再 prune"; rm -rf "$wt"; }
    git_retry git -C "$repo" worktree prune >/dev/null 2>&1 || true
  fi

  rm -f "$(gate_file "$task")"
  jq --arg s "cleaned" '.state=$s' "$(task_file "$task")" > "$(task_file "$task").tmp" && mv "$(task_file "$task").tmp" "$(task_file "$task")"
  log "任务 $task 已清理"
}

cmd_gc() {
  log "清理托管工作树"
  if [[ -x "$OPENCLAW_BIN" ]]; then
    git_retry "$OPENCLAW_BIN" worktrees gc 2>&1 | tail -5 || warn "worktrees gc 失败"
  fi
  log "清理 git worktree 残留"
  git_retry git -C "$REPO" worktree prune -v 2>&1 | tail -5 || true
  # 清理被中断留下的陈旧 index.lock（仅在确实没有 git 进程时）
  if [[ -f "$REPO/.git/index.lock" ]] && ! pgrep -x git >/dev/null 2>&1; then
    warn "发现陈旧 $REPO/.git/index.lock 且无 git 进程，删除"
    rm -f "$REPO/.git/index.lock"
  fi
  # 统计占用
  local wt_root; wt_root="$(jq -r '.worktreeRoot // empty' "$HOME/.openclaw/openclaw.json" 2>/dev/null)"
  [[ -n "$wt_root" ]] && log "托管工作树根目录占用：$(du -sh "$wt_root" 2>/dev/null | cut -f1)"
  log "完成"
}

# ════════════════════════════════════════════════════════════════
# 命令：list / status
# ════════════════════════════════════════════════════════════════
cmd_list() {
  local n=0
  # 注意：local 必须声明在循环外。zsh 里在循环内重复 local 会把变量值打印出来
  # （bash 不会），列表输出会被污染。
  local id st gd wt
  printf "%-24s %-14s %-10s %s\n" "TASK" "STATE" "GATE" "WORKTREE"
  for f in "$TASKS"/*.json(N); do
    id="$(jq -r '.id' "$f")"; st="$(jq -r '.state // "-"' "$f")"
    wt="$(jq -r '.worktree' "$f")"
    if [[ -f "$(gate_file "$id")" ]]; then
      gd="$(jq -r 'if .passed then "PASS" else "FAIL" end' "$(gate_file "$id")")"
    else
      gd="-"
    fi
    printf "%-24s %-14s %-10s %s\n" "$id" "$st" "$gd" "$wt"
    n=$(( n + 1 ))
  done
  [[ $n -eq 0 ]] && log "没有任务记录（$TASKS）"
  return 0
}

cmd_status() {
  local task="${1:-}"; [[ -n "$task" ]] || die $EX_USAGE "用法: orchestrator.sh status <task_id>"
  require_task "$task"
  jq '.' "$(task_file "$task")"
  [[ -f "$(gate_file "$task")" ]] && { print -- "── gate ──"; jq '.' "$(gate_file "$task")"; }
}

# ════════════════════════════════════════════════════════════════
# 分发
# ════════════════════════════════════════════════════════════════
usage() {
  sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
}

cmd="${1:-}"; shift 2>/dev/null || true
case "$cmd" in
  new)     cmd_new "$@" ;;
  env)     cmd_env "$@" ;;
  test)    cmd_test "$@" ;;
  gate)    cmd_gate "$@" ;;
  merge)   cmd_merge "$@" ;;
  clean)   cmd_clean "$@" ;;
  gc)      cmd_gc "$@" ;;
  list)    cmd_list "$@" ;;
  status)  cmd_status "$@" ;;
  version) print -- "orchestrator.sh $VERSION" ;;
  ""|-h|--help|help) usage ;;
  *) die $EX_USAGE "未知命令: $cmd（可用: new env test gate merge clean gc list status）" ;;
esac
