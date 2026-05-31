export type DaySyncStatus =
  | "empty"
  | "synced"
  | "stale"
  | "conflict"
  | "locked"
  | "syncing"
  | "error";

export type ManagedBlockInsertLocation = "bottom" | "top" | "after-heading";

export interface DaySyncState {
  date: string;
  status: DaySyncStatus;
  flowtimeDailyPath?: string;
  obsidianDailyPath?: string;
  lastSyncedAt?: string;
  serverCursor?: string;
  renderedHash?: string;
  managedBlockHash?: string;
  errorMessage?: string;
  locked?: boolean;
  totalMinutes?: number;
  entryCount?: number;
  topCategory?: string;
}

export interface MonthStats {
  syncedDays: number;
  staleDays: number;
  conflictDays: number;
  totalMinutes: number;
}

export interface DayStatusInput {
  hasEntries: boolean;
  serverChanged: boolean;
  localManagedHashChanged: boolean;
  locked: boolean;
  error: boolean;
}

export interface ManagedBlockResult {
  action: "replaced" | "inserted";
  content: string;
}

const MANAGED_BLOCK_PATTERN =
  /<!--\s*flowtime:managed-start\b[^>]*-->\r?\n?[\s\S]*?\r?\n?<!--\s*flowtime:managed-end\s*-->/i;

export function flowTimeDailyPath(targetFolder: string, date: string): string {
  const normalizedFolder = normalizePath(targetFolder || "FlowTime/Daily");
  const year = date.slice(0, 4);
  return normalizePath(`${normalizedFolder}/${year}/${date}.md`);
}

export function buildManagedBlock(date: string, flowtimeDailyPathValue: string): string {
  const embedPath = stripMarkdownExtension(normalizePath(flowtimeDailyPathValue));
  const body = [`## 时间日志总结`, "", `![[${embedPath}]]`].join("\n");
  return [
    `<!-- flowtime:managed-start date=${date} hash=${hashText(body)} -->`,
    body,
    "<!-- flowtime:managed-end -->",
  ].join("\n");
}

export function replaceOrInsertManagedBlock(
  content: string,
  block: string,
  location: ManagedBlockInsertLocation,
  heading?: string,
): ManagedBlockResult {
  if (MANAGED_BLOCK_PATTERN.test(content)) {
    return {
      action: "replaced",
      content: content.replace(MANAGED_BLOCK_PATTERN, block),
    };
  }

  return {
    action: "inserted",
    content: insertManagedBlock(content, block, location, heading),
  };
}

export function hasManagedBlock(content: string): boolean {
  return MANAGED_BLOCK_PATTERN.test(content);
}

export function extractManagedBlock(content: string): string | null {
  return content.match(MANAGED_BLOCK_PATTERN)?.[0] ?? null;
}

export function classifyDayStatus(input: DayStatusInput): DaySyncStatus {
  if (input.error) return "error";
  if (input.serverChanged && input.localManagedHashChanged) return "conflict";
  if (input.locked) return "locked";
  if (!input.hasEntries) return "empty";
  if (input.serverChanged) return "stale";
  return "synced";
}

export function buildMonthStats(states: DaySyncState[]): MonthStats {
  return states.reduce<MonthStats>(
    (stats, state) => {
      if (state.status === "synced") stats.syncedDays += 1;
      if (state.status === "stale") stats.staleDays += 1;
      if (state.status === "conflict") stats.conflictDays += 1;
      stats.totalMinutes += state.totalMinutes ?? 0;
      return stats;
    },
    {
      syncedDays: 0,
      staleDays: 0,
      conflictDays: 0,
      totalMinutes: 0,
    },
  );
}

export function hashText(value: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `h${combined.toString(16)}`;
}

function insertManagedBlock(
  content: string,
  block: string,
  location: ManagedBlockInsertLocation,
  heading?: string,
): string {
  if (location === "top") {
    return `${block}\n\n${content.trimStart()}`;
  }

  if (location === "after-heading" && heading) {
    const headingPattern = new RegExp(`(^#{2,6}\\s+${escapeRegExp(heading)}\\s*$)`, "m");
    const match = content.match(headingPattern);
    if (match?.index !== undefined && match[1]) {
      const insertionPoint = match.index + match[1].length;
      return `${content.slice(0, insertionPoint)}\n${block}\n${content.slice(insertionPoint).replace(/^\r?\n/, "")}`;
    }
  }

  return `${content.trimEnd()}\n\n${block}\n`;
}

function stripMarkdownExtension(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -3) : path;
}

function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
