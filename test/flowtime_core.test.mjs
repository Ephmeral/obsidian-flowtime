import assert from "node:assert/strict";
import test from "node:test";

import {
  buildManagedBlock,
  buildMonthStats,
  classifyDayStatus,
  flowTimeDailyPath,
  hashText,
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
