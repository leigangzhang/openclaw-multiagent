# taskctl —— 检查入口
#
# 所有检查都走这里，本地与未来 CI 用同一套命令（P17）。
#   make check   跑全部（提交前必过）
#   make test    单元测试
#   make eval    编排逻辑的确定性回归
#   make audit   链路配置自检（需要 OpenClaw 在跑）
#   make reap    列出僵尸会话（dry-run）
#   make smoke   用桩跑一遍完整管线（不花 LLM）

SHELL := /bin/zsh
NODE  ?= node

.PHONY: check test eval audit reap reap-worktrees reload smoke clean help

help:
	@echo "make check  —— 全部检查（test + eval）"
	@echo "make audit  —— 链路配置自检（需 OpenClaw 在跑）"
	@echo "make reap   —— 列出僵尸会话 + 孤儿工作树（dry-run）"
	@echo "make reap-worktrees FORCE=1 —— 清孤儿工作树"
	@echo "make reload —— 重启 runner（改代码后必须）"
	@echo "make smoke  —— 桩传输跑一遍完整管线（不花 LLM）"

# 提交前必过：不依赖外部服务
check: test eval
	@echo ""
	@echo "✅ check 通过"

test:
	@echo "── 单元测试 ──"
	@$(NODE) --test test/*.test.mjs

eval:
	@echo "── 编排 eval（确定性，不花 LLM）──"
	@$(NODE) test/eval/run.mjs

# 需要 OpenClaw 网关在运行
audit:
	@$(NODE) bin/audit.mjs

# 端到端：真实停机恢复（会停/启 runner 服务，约 2 分钟）
e2e-resume:
	@echo "── E2E: 真实中断恢复 ──"
	@./test/e2e/resume.sh

e2e: e2e-resume

# runner 是常驻进程，改代码后必须重启才生效（踩过两次）
reload:
	@echo "── 重启 runner（加载新代码）──"
	@launchctl kickstart -k "gui/$$UID/ai.openclaw.multiagent-runner" 2>/dev/null || \
	 launchctl bootstrap "gui/$$UID" "$$HOME/Library/LaunchAgents/ai.openclaw.multiagent-runner.plist"
	@sleep 4
	@pgrep -f runner.mjs >/dev/null && echo "✅ runner 已重启 (PID $$(pgrep -f runner.mjs | head -1))" || echo "❌ runner 未运行"

reap:
	@$(NODE) bin/reap.mjs

# 清理孤儿工作树（dry-run；真删加 FORCE=1）
reap-worktrees:
	@$(NODE) bin/reap.mjs --worktrees $(if $(FORCE),--force,)

smoke:
	@echo "── 桩传输冒烟（不调用任何模型）──"
	@$(NODE) test/eval/run.mjs >/dev/null && echo "✅ 管线可在桩上跑通"

clean:
	@echo "清理状态（默认不动：任务记录是审计证据）"
	@echo "  手动清理：rm -rf \$${MA_STATE_ROOT:-\$$HOME/.local/state/openclaw-multiagent}/tasks/*"
