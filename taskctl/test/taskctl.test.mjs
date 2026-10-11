/**
 * 单测重点：验证成功标准背后的**机制**，而不是表面行为。
 *
 *   S1 每次 submit 都新建任务（不复用、不合并）
 *   S2 已完成步骤不再重跑（断点恢复的基础）
 *   S5 上限由 store 强制，且优先于任何业务分支
 *   fail-safe 审查结论解析不出来时不得进入修复循环
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// MA_STATE_ROOT 在模块加载时读取，必须先设环境变量再动态 import
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "taskctl-test-"));
process.env.MA_STATE_ROOT = TMP;

const store = await import("../lib/store.mjs");
const roles = await import("../lib/roles.mjs");

test("S1: 同一请求提交两次产生两个独立任务", () => {
  const a = store.createTask({ rawText: "同样的请求", requester: "tester" });
  const b = store.createTask({ rawText: "同样的请求", requester: "tester" });
  assert.notEqual(a.taskId, b.taskId, "两次提交必须得到不同 taskId");
  assert.ok(fs.existsSync(path.join(store.taskDir(a.taskId), "status.json")));
  assert.ok(fs.existsSync(path.join(store.taskDir(b.taskId), "status.json")));
});

test("S1: 新建任务初始为 created，且 request 落盘完整", () => {
  const { taskId } = store.createTask({
    rawText: "写一个函数",
    requester: "ray",
    channel: "feishu",
    peerId: "oc_test",
    repo: "/tmp/repo",
  });
  const st = store.readStatus(taskId);
  assert.equal(st.phase, "created");
  assert.equal(st.stepIndex, 0);
  assert.deepEqual(st.attempts, { review: 0, fix: 0 });

  const req = store.readRequest(taskId);
  assert.equal(req.rawText, "写一个函数");
  assert.equal(req.channel, "feishu");
  assert.equal(req.peerId, "oc_test");
  assert.equal(req.repo, "/tmp/repo");
});

test("S2: 步骤成功记录后 stepCompleted 为真，失败记录为假", () => {
  const { taskId } = store.createTask({ rawText: "x" });
  assert.equal(store.stepCompleted(taskId, "code"), false, "未执行时不应算完成");

  store.recordStep(taskId, "code", {
    prompt: "p",
    output: "o",
    meta: { agentId: "dsh", exitCode: 0, durationMs: 10 },
  });
  assert.equal(store.stepCompleted(taskId, "code"), true);

  store.recordStep(taskId, "review", {
    prompt: "p",
    output: "o",
    meta: { agentId: "codex", exitCode: 1, durationMs: 10 },
  });
  assert.equal(store.stepCompleted(taskId, "review"), false, "非零退出不算完成");
});

test("S2: 成本按步累加", () => {
  const { taskId } = store.createTask({ rawText: "x" });
  store.recordStep(taskId, "plan", { prompt: "", output: "", meta: { exitCode: 0, costUsd: 0.25 } });
  store.recordStep(taskId, "code", { prompt: "", output: "", meta: { exitCode: 0, costUsd: 0.75 } });
  assert.equal(store.readStatus(taskId).costUsd, 1);
});

test("S5: 步数超限被 checkLimits 捕获", () => {
  const { taskId } = store.createTask({ rawText: "x", limits: { maxSteps: 2 } });
  const st = store.readStatus(taskId);
  assert.equal(store.checkLimits(st), null);

  st.stepIndex = 2;
  store.saveStatus(taskId, st);
  assert.match(store.checkLimits(store.readStatus(taskId)), /步数超限/);
});

test("S5: 墙钟超限被捕获（用伪造的 startedAt）", () => {
  const { taskId } = store.createTask({ rawText: "x", limits: { maxWallClockSec: 10 } });
  const st = store.readStatus(taskId);
  st.startedAt = new Date(Date.now() - 60_000).toISOString();
  store.saveStatus(taskId, st);
  assert.match(store.checkLimits(store.readStatus(taskId)), /墙钟超限/);
});

test("S5: token 超限被捕获（不依赖价格表，供应商无关）", () => {
  const { taskId } = store.createTask({ rawText: "x", limits: { maxTokens: 1000 } });
  const st = store.readStatus(taskId);
  assert.equal(store.checkLimits(st), null);
  st.tokensIn = 900;
  st.tokensOut = 200;
  store.saveStatus(taskId, st);
  assert.match(store.checkLimits(store.readStatus(taskId)), /token 超限/);
});

test("S5: 无价格表时 USD 熔断不生效（不编造金额）", () => {
  fs.rmSync(path.join(TMP, "pricing.json"), { force: true });
  const { taskId } = store.createTask({ rawText: "x", limits: { maxCostUsd: 0.5 } });
  const st = store.readStatus(taskId);
  st.costUsd = 9.9; // 即便成本字段很大
  store.saveStatus(taskId, st);
  assert.equal(store.checkLimits(store.readStatus(taskId)), null, "无价格表时不应按 USD 熔断");
});

test("S5: 有价格表时 USD 熔断生效，且成本按 token 算出", () => {
  fs.writeFileSync(
    path.join(TMP, "pricing.json"),
    JSON.stringify({ "test-model": { in: 1.0, out: 2.0 } })
  );
  // 1e6 input * $1/M + 1e6 output * $2/M = $3
  const c = store.computeCostUsd("test-model", 1_000_000, 1_000_000);
  assert.equal(c, 3);

  const { taskId } = store.createTask({ rawText: "x", limits: { maxCostUsd: 0.5 } });
  const st = store.readStatus(taskId);
  st.costUsd = 0.9;
  store.saveStatus(taskId, st);
  assert.match(store.checkLimits(store.readStatus(taskId)), /成本超限/);
  fs.rmSync(path.join(TMP, "pricing.json"), { force: true });
});

test("成本计算: 无价格表或未知模型时返回 null，不猜", () => {
  fs.rmSync(path.join(TMP, "pricing.json"), { force: true });
  assert.equal(store.computeCostUsd("any", 1000, 1000), null);
});

test("用量累加: 多个步骤的 token 正确相加", () => {
  const { taskId } = store.createTask({ rawText: "x" });
  store.recordStep(taskId, "plan", {
    prompt: "", output: "",
    meta: { exitCode: 0, usage: { inputTokens: 100, outputTokens: 20 } },
  });
  store.recordStep(taskId, "code", {
    prompt: "", output: "",
    meta: { exitCode: 0, usage: { inputTokens: 300, outputTokens: 80 } },
  });
  const st = store.readStatus(taskId);
  assert.equal(st.tokensIn, 400);
  assert.equal(st.tokensOut, 100);
});

test("S5: 终态任务不再受上限检查（避免重复失败）", () => {
  const { taskId } = store.createTask({ rawText: "x", limits: { maxSteps: 0 } });
  store.transition(taskId, "failed", { error: "测试" });
  assert.equal(store.checkLimits(store.readStatus(taskId)), null);
});

test("fail-safe: 审查输出无 JSON 块时判为未解析", () => {
  const r = roles.parseReviewVerdict("代码看起来不错，建议加测试。");
  assert.equal(r.parsed, false);
  assert.match(r.reason, /围栏/);
});

test("fail-safe: JSON 损坏时判为未解析而不是默认通过", () => {
  const r = roles.parseReviewVerdict('```json\n{"passed": tru}\n```');
  assert.equal(r.parsed, false);
});

test("fail-safe: 缺少 passed 字段时判为未解析", () => {
  const r = roles.parseReviewVerdict('```json\n{"severe": []}\n```');
  assert.equal(r.parsed, false);
  assert.match(r.reason, /passed/);
});

test("审查解析: 合法 JSON 正确取出严重项", () => {
  const text = [
    "审查意见如下。",
    "```json",
    '{"passed": false, "severe": ["NaN 会丢数据"], "suggestions": ["补类型注解"]}',
    "```",
  ].join("\n");
  const r = roles.parseReviewVerdict(text);
  assert.equal(r.parsed, true);
  assert.equal(r.passed, false);
  assert.deepEqual(r.severe, ["NaN 会丢数据"]);
  assert.deepEqual(r.suggestions, ["补类型注解"]);
});

test("审查解析: 多个 JSON 块时取最后一个", () => {
  const text = [
    '```json\n{"passed": true, "severe": []}\n```',
    "补充说明",
    '```json\n{"passed": false, "severe": ["后一个才算"]}\n```',
  ].join("\n");
  const r = roles.parseReviewVerdict(text);
  assert.equal(r.passed, false);
  assert.deepEqual(r.severe, ["后一个才算"]);
});

test("状态迁移: 终态写入 endedAt，且过渡被记录到日志", () => {
  const { taskId } = store.createTask({ rawText: "x" });
  store.transition(taskId, "planning");
  store.transition(taskId, "done");
  const st = store.readStatus(taskId);
  assert.equal(st.phase, "done");
  assert.ok(st.endedAt, "终态必须有 endedAt");

  const logLines = fs
    .readFileSync(path.join(store.taskDir(taskId), "log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.ok(logLines.some((l) => l.event === "task.created"));
  assert.ok(logLines.some((l) => l.event === "phase" && l.phase === "done"));
});

test("listTasks 按开始时间倒序", () => {
  const before = store.listTasks().length;
  store.createTask({ rawText: "a" });
  store.createTask({ rawText: "b" });
  const all = store.listTasks();
  assert.equal(all.length, before + 2);
  for (let i = 1; i < all.length; i += 1) {
    assert.ok(String(all[i - 1].startedAt) >= String(all[i].startedAt));
  }
});

test("安全: 非法 taskId 被拒绝（防目录穿越）", () => {
  assert.throws(() => store.taskDir("../../etc/passwd"), /非法/);
  assert.throws(() => store.taskDir("a/b"), /非法/);
});

test("安全: 空 rawText 被拒绝", () => {
  assert.throws(() => store.createTask({ rawText: "   " }), /不能为空/);
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
