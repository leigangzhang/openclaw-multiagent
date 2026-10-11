#!/bin/zsh
#
# .openclaw/worktree-setup.sh —— 每个托管工作树的语言级依赖隔离
#
# OpenClaw 契约（docs/concepts/managed-worktrees.md:178-191）：
#   * 源仓库根的 .openclaw/worktree-setup.sh 若存在且可执行，会在新工作树创建时被调用
#   * **cwd = 新建的工作树**
#   * 环境变量：OPENCLAW_SOURCE_TREE_PATH（源检出）、OPENCLAW_WORKTREE_PATH（新工作树）
#   * 超时 120s；**非零退出会中止创建并删掉工作树与分支**
#
# 因此本脚本的核心设计约束是：**慢即降级，绝不因网络慢而让工作树创建失败**。
# 做法：设一个内部软截止（默认 110s），重活开始前检查耗时；
#       超预算就把待办写进 .openclaw/env-setup.pending 并以 0 退出，
#       由 orchestrator.sh 在无截止的情况下补跑。
#
# 隔离策略（对应"多语言虚拟环境隔离"需求）：
#   Python  → 工作树内 .venv，pip 走全局 wheel 缓存（PIP_CACHE_DIR）避免重复下载
#   Node    → pnpm install，依赖落在工作树自己的 node_modules；
#             包体走 pnpm 全局 store（硬链接，N 个工作树共享同一份磁盘）
#   Java    → -Dmaven.repo.local=<工作树>/.m2_local 独立本地仓库，
#             并用 repo.local.tail 链接共享缓存，既避免并发写锁又省磁盘
#   Rust/Go → 走各自全局缓存（CARGO_HOME / GOMODCACHE），天然可共享
#
# 可重复运行（幂等）。手动补跑：
#   OPENCLAW_WORKTREE_PATH=<wt> cd <wt> && ./.openclaw/worktree-setup.sh

emulate -L zsh 2>/dev/null || true
set -u

WT="${OPENCLAW_WORKTREE_PATH:-$(pwd)}"
SRC="${OPENCLAW_SOURCE_TREE_PATH:-$WT}"
cd "$WT" || { print -u2 -- "env-setup: 进不去工作树 $WT"; exit 1; }

# 软截止：被 OpenClaw 调用时默认 110s（硬超时 120s），手动/orchestrator 调用时不限
if [[ -z "${ENV_SETUP_DEADLINE:-}" ]]; then
  if [[ -n "${OPENCLAW_WORKTREE_PATH:-}" ]]; then ENV_SETUP_DEADLINE=110; else ENV_SETUP_DEADLINE=0; fi
fi
START_TS=$(date +%s)
PENDING=".openclaw/env-setup.pending"
mkdir -p .openclaw
: > "$PENDING"

log()  { print -- "[env-setup] $*"; }
warn() { print -u2 -- "[env-setup] $*"; }
elapsed() { echo $(( $(date +%s) - START_TS )); }
over_budget() { [[ "$ENV_SETUP_DEADLINE" -gt 0 && "$(elapsed)" -ge "$ENV_SETUP_DEADLINE" ]]; }
# 记录一个被延后的重活：defer <说明>
defer() {
  print -- "$*" >> "$PENDING"
  warn "超出 ${ENV_SETUP_DEADLINE}s 软截止，已延后：$*（orchestrator 会补跑）"
}

# ── 共享缓存根目录（macOS 惯例位置，可用环境变量覆盖）──────────
XDG_CACHE="${XDG_CACHE_HOME:-$HOME/Library/Caches}"
PIP_CACHE_DIR="${PIP_CACHE_DIR:-$XDG_CACHE/pip}"
PNPM_STORE_DIR="${PNPM_STORE_DIR:-$HOME/.pnpm-store}"
MAVEN_SHARED_REPO="${MAVEN_SHARED_REPO:-$HOME/.m2/repository}"
export PIP_CACHE_DIR

# ── 探测项目形态 ───────────────────────────────────────────────
has() { [[ -e "$1" ]]; }
IS_PYTHON=0; IS_NODE=0; IS_JAVA=0; IS_RUST=0; IS_GO=0
{ has pyproject.toml || has requirements.txt || has setup.py || has Pipfile; } && IS_PYTHON=1
{ has package.json; } && IS_NODE=1
{ has pom.xml || has build.gradle || has build.gradle.kts; } && IS_JAVA=1
{ has Cargo.toml; } && IS_RUST=1
{ has go.mod; } && IS_GO=1

log "工作树: $WT"
log "形态: python=$IS_PYTHON node=$IS_NODE java=$IS_JAVA rust=$IS_RUST go=$IS_GO"

# ══════════════════════════════════════════════════════════════
# Python：工作树内 venv + 全局 wheel 缓存
# ══════════════════════════════════════════════════════════════
if [[ $IS_PYTHON -eq 1 ]]; then
  if [[ ! -x .venv/bin/python ]]; then
    log "创建 .venv（python3 -m venv）"
    if python3 -m venv .venv 2>&1 | tail -3; then
      log "venv 就绪: $WT/.venv"
    else
      warn "python3 -m venv 失败（python3 是否可用？）"
    fi
  else
    log "复用已有 .venv"
  fi

  if [[ -x .venv/bin/python ]]; then
    # ── 测试工具链 ──────────────────────────────────────────────
    # 测试门控要跑 pytest，但很多项目并不把它列为运行依赖。
    # 这里做一次幂等补齐；不想要这个行为就设 ENV_SETUP_SKIP_TEST_TOOLS=1。
    want_pytest=0
    [[ -f pytest.ini || -f tox.ini || -d tests ]] && want_pytest=1
    grep -qs '\[tool\.pytest' pyproject.toml 2>/dev/null && want_pytest=1
    if [[ "$want_pytest" -eq 1 && "${ENV_SETUP_SKIP_TEST_TOOLS:-0}" != "1" ]] && ! .venv/bin/python -m pytest --version >/dev/null 2>&1; then
      if over_budget; then
        defer "python: pip install pytest"
      else
        log "未检测到 pytest，安装测试运行器（ENV_SETUP_SKIP_TEST_TOOLS=1 可关闭）"
        .venv/bin/python -m pip install --quiet pytest || warn "pytest 安装失败，测试门控可能跑不起来"
      fi
    fi

    # ── 项目依赖：只在那几个清单文件比 .venv 里已装版本更新时才装 ──
    STAMP=".openclaw/.venv-stamp"
    NEED_INSTALL=1
    if [[ -f "$STAMP" ]] && [[ -z "$(find pyproject.toml requirements.txt setup.py -newer "$STAMP" 2>/dev/null | head -1)" ]]; then
      NEED_INSTALL=0; log "依赖清单未变，跳过 pip install"
    fi
    if [[ $NEED_INSTALL -eq 1 ]]; then
      if over_budget; then
        defer "python: pip install"
      else
        log "pip install（缓存: $PIP_CACHE_DIR）"
        # 一律在工作树的 venv 内跑，绝不用 --user / --break-system-packages
        if [[ -f requirements.txt ]]; then
          .venv/bin/python -m pip install --quiet --upgrade pip && .venv/bin/python -m pip install --quiet -r requirements.txt && touch "$STAMP" || warn "pip install -r requirements.txt 失败"
        elif [[ -f pyproject.toml ]]; then
          .venv/bin/python -m pip install --quiet --upgrade pip && .venv/bin/python -m pip install --quiet -e . && touch "$STAMP" || warn "pip install -e . 失败（可能非包项目，可忽略）"
        fi
      fi
    fi
  fi
fi

# ══════════════════════════════════════════════════════════════
# Node / TypeScript：pnpm + 全局 store（硬链接共享，省磁盘）
# ══════════════════════════════════════════════════════════════
if [[ $IS_NODE -eq 1 ]]; then
  # pnpm 解析顺序：PATH → corepack → npx（兼容 DSH 运行时自带的 pnpm）
  PNPM=""
  if command -v pnpm >/dev/null 2>&1; then
    PNPM="$(command -v pnpm)"
  elif command -v corepack >/dev/null 2>&1; then
    PNPM="corepack pnpm"
  fi

  if [[ -z "$PNPM" ]]; then
    warn "找不到 pnpm，跳过 Node 依赖（装法：corepack enable pnpm 或 npm i -g pnpm）"
  elif over_budget; then
    defer "node: pnpm install"
  else
    log "pnpm install（store: $PNPM_STORE_DIR）"
    # --prefer-offline：store 里有的绝不回源，网络抖动时也能装上
    # --frozen-lockfile：有锁文件时严格按锁装，保证可复现
    PNPM_ARGS=(install --prefer-offline --store-dir "$PNPM_STORE_DIR")
    [[ -f pnpm-lock.yaml ]] && PNPM_ARGS+=(--frozen-lockfile)
    if $=PNPM $PNPM_ARGS 2>&1 | tail -5; then
      log "node_modules 就绪（隔离在工作树内，包体共享 store）"
    else
      warn "pnpm install 失败，已延后由 orchestrator 重试"
      print -- "node: pnpm install" >> "$PENDING"
    fi
  fi
fi

# ══════════════════════════════════════════════════════════════
# Java：独立本地仓库 + 共享缓存链，规避并发写锁
# ══════════════════════════════════════════════════════════════
if [[ $IS_JAVA -eq 1 ]]; then
  if ! command -v mvn >/dev/null 2>&1 && [[ ! -x ./mvnw ]]; then
    warn "既没有 mvn 也没有 ./mvnw，跳过 Java 依赖"
  elif over_budget; then
    defer "java: mvn dependency:go-offline"
  else
    MVN="./mvnw"; [[ -x "$MVN" ]] || MVN="mvn"
    LOCAL_REPO="$WT/.m2_local"
    mkdir -p "$LOCAL_REPO"
    log "maven 本地仓库隔离: $LOCAL_REPO"
    # repo.local.tail 让 Maven 先查工作树私有仓库、再落到共享缓存 ——
    # 既避免多工作树并发写同一个本地仓库导致的 .lock / _remote.repositories 冲突，
    # 又不至于每个工作树从零下载全部依赖。
    if $MVN -q -Dmaven.repo.local="$LOCAL_REPO" \
            -Dmaven.repo.local.tail="$MAVEN_SHARED_REPO" \
            dependency:go-offline 2>&1 | tail -5; then
      log "maven 依赖就绪"
    else
      warn "mvn dependency:go-offline 失败（首次离线预热属正常，测试时会再拉）"
    fi
  fi
fi

# ══════════════════════════════════════════════════════════════
# Rust / Go：直接用各自的全局缓存，天然跨工作树共享
# ══════════════════════════════════════════════════════════════
if [[ $IS_RUST -eq 1 ]] && command -v cargo >/dev/null 2>&1; then
  if over_budget; then defer "rust: cargo fetch"; else
    log "cargo fetch（CARGO_HOME=${CARGO_HOME:-$HOME/.cargo}）"
    cargo fetch 2>&1 | tail -2 || warn "cargo fetch 失败"
  fi
fi
if [[ $IS_GO -eq 1 ]] && command -v go >/dev/null 2>&1; then
  if over_budget; then defer "go: go mod download"; else
    log "go mod download（GOMODCACHE=${GOMODCACHE:-$(go env GOMODCACHE 2>/dev/null)}）"
    go mod download 2>&1 | tail -2 || warn "go mod download 失败"
  fi
fi

# ── 收尾 ───────────────────────────────────────────────────────
if [[ -s "$PENDING" ]]; then
  warn "环境未完全就绪，待办已记录在 $PENDING（共 $(wc -l < "$PENDING" | tr -d ' ') 项）"
else
  rm -f "$PENDING"
  log "环境隔离完成，耗时 $(elapsed)s"
fi

# 关键：即便有延后项也返回 0 —— 否则 OpenClaw 会删掉整个工作树
exit 0
