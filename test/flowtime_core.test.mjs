import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDailyGeneratedContent,
  buildManagedBlock,
  buildManagedBlockFromBody,
  buildMonthStats,
  classifyDayStatus,
  flowTimeDailyPath,
  hashText,
  isManagedBlockPristine,
  isOwnedDailyGeneratedContent,
  isSecureAuthUrl,
  removeManagedBlock,
  replaceOrInsertManagedBlock,
} from "../build-test/flowtime_core.js";

test("builds the FlowTime daily path under a year folder", () => {
  assert.equal(
    flowTimeDailyPath("FlowTime/Daily", "2026-05-28"),
    "FlowTime/Daily/2026/2026-05-28.md",
  );
});

test("replaces only the managed block and preserves user content", () => {
  const before = [
    "# 2026-05-28",
    "用户区（完全不动）",
    "<!-- flowtime:managed-start date=2026-05-28 hash=old -->",
    "old generated content",
    "<!-- flowtime:managed-end -->",
    "## 学习成长",
    "用户自己写的笔记",
  ].join("\n");
  const block = buildManagedBlock("2026-05-28", "FlowTime/Daily/2026/2026-05-28.md");

  const result = replaceOrInsertManagedBlock(before, block, "bottom");

  assert.equal(result.action, "replaced");
  assert.match(result.content, /用户区（完全不动）/);
  assert.match(result.content, /用户自己写的笔记/);
  assert.doesNotMatch(result.content, /old generated content/);
  assert.match(result.content, /!\[\[FlowTime\/Daily\/2026\/2026-05-28\]\]/);
});

test("inserts a managed block at the requested location when no marker exists", () => {
  const before = "# 2026-05-28\n\n## 学习成长\n用户自己写的笔记\n";
  const block = buildManagedBlock("2026-05-28", "FlowTime/Daily/2026/2026-05-28.md");

  const result = replaceOrInsertManagedBlock(before, block, "after-heading", "学习成长");

  assert.equal(result.action, "inserted");
  assert.match(result.content, /## 学习成长\n<!-- flowtime:managed-start/);
});

test("classifies a day with both server and local changes as conflict", () => {
  assert.equal(
    classifyDayStatus({
      hasEntries: true,
      serverChanged: true,
      localManagedHashChanged: true,
      locked: false,
      error: false,
    }),
    "conflict",
  );
});

test("builds month stats from day sync states", () => {
  const stats = buildMonthStats([
    { date: "2026-05-01", status: "synced", totalMinutes: 90 },
    { date: "2026-05-02", status: "stale", totalMinutes: 60 },
    { date: "2026-05-03", status: "conflict", totalMinutes: 30 },
    { date: "2026-05-04", status: "locked", totalMinutes: 15 },
  ]);

  assert.deepEqual(stats, {
    syncedDays: 1,
    staleDays: 1,
    conflictDays: 1,
    totalMinutes: 195,
  });
});

test("hashes text deterministically", () => {
  assert.equal(hashText("same content"), hashText("same content"));
  assert.notEqual(hashText("same content"), hashText("different content"));
});

test("marks generated daily content with a verifiable ownership hash", () => {
  const generated = buildDailyGeneratedContent("# 2026-05-28 FlowTime 日志\n");

  assert.equal(isOwnedDailyGeneratedContent(generated.content), true);
  assert.equal(hashText(generated.content), generated.renderedHash);
  assert.equal(
    isOwnedDailyGeneratedContent(`${generated.content}\n用户手动补充`),
    false,
  );
});

test("detects local edits inside managed blocks", () => {
  const block = buildManagedBlock("2026-05-28", "FlowTime/Daily/2026/2026-05-28.md");
  const edited = block.replace("## 时间日志总结", "## 手动改过的时间日志总结");

  assert.equal(isManagedBlockPristine(block), true);
  assert.equal(isManagedBlockPristine(edited), false);
});

test("builds managed blocks from inline Daily Note content", () => {
  const body = ["## FlowTime 时间日志", "", "### 时间条目", "- 09:00 **工作**"].join("\n");
  const block = buildManagedBlockFromBody("2026-05-28", body);

  assert.equal(isManagedBlockPristine(block), true);
  assert.match(block, /## FlowTime 时间日志/);
  assert.doesNotMatch(block, /!\[\[/);
});

test("removes only the managed block when clearing empty synced days", () => {
  const block = buildManagedBlock("2026-05-28", "FlowTime/Daily/2026/2026-05-28.md");
  const before = ["# 2026-05-28", "", "用户内容", "", block, "", "## 复盘"].join("\n");
  const after = removeManagedBlock(before);

  assert.match(after, /用户内容/);
  assert.match(after, /## 复盘/);
  assert.doesNotMatch(after, /flowtime:managed-start/);
});

test("allows auth over HTTPS or loopback HTTP only", () => {
  assert.equal(isSecureAuthUrl("https://flowtime.example.com/api/v1"), true);
  assert.equal(isSecureAuthUrl("http://localhost:8080/api/v1"), true);
  assert.equal(isSecureAuthUrl("http://127.0.0.1:8080/api/v1"), true);
  assert.equal(isSecureAuthUrl("http://[::1]:8080/api/v1"), true);
  assert.equal(isSecureAuthUrl("http://192.168.1.10:8080/api/v1"), false);
});
