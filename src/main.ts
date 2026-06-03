import {
  App,
  ItemView,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath,
  requestUrl,
  moment,
} from "obsidian";

import {
  DaySyncState,
  DaySyncStatus,
  ManagedBlockInsertLocation,
  buildManagedBlockFromBody,
  buildMonthStats,
  extractManagedBlock,
  flowTimeDailyPath,
  hashText,
  isManagedBlockPristine,
  isOwnedDailyGeneratedContent,
  isSecureAuthUrl,
  removeManagedBlock,
  replaceOrInsertManagedBlock,
} from "./flowtime_core";

const VIEW_TYPE_FLOWTIME_CALENDAR = "flowtime-calendar-view";

interface FlowTimePluginSettings {
  serverUrl: string;
  email: string;
  accessToken: string;
  tokenType: string;
  tokenExpiresAt: string;
  targetFolder: string;
  dailyNoteFolder: string;
  dailyNoteBridgeEnabled: boolean;
  dailyNoteInsertLocation: ManagedBlockInsertLocation;
  dailyNoteInsertHeading: string;
  dailyNoteTemplatePath: string;
  dayStates: Record<string, DaySyncState>;
  lastSyncAt: string;
  lastSyncedDailyPath: string;
  clickToOpenDailyNote: boolean;
  weeklyNoteFolder: string;
  weeklyNoteFormat: string;
  weeklyNoteTemplatePath: string;
}

const DEFAULT_SETTINGS: FlowTimePluginSettings = {
  serverUrl: "http://localhost:8080",
  email: "",
  accessToken: "",
  tokenType: "Bearer",
  tokenExpiresAt: "",
  targetFolder: "FlowTime/Daily",
  dailyNoteFolder: "",
  dailyNoteBridgeEnabled: false,
  dailyNoteInsertLocation: "bottom",
  dailyNoteInsertHeading: "",
  dailyNoteTemplatePath: "",
  dayStates: {},
  lastSyncAt: "",
  lastSyncedDailyPath: "",
  clickToOpenDailyNote: true,
  weeklyNoteFolder: "FlowTime/Weekly",
  weeklyNoteFormat: "YYYY-[W]WW",
  weeklyNoteTemplatePath: "",
};

interface FlowTimeApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

interface FlowTimeUser {
  id: string;
  email: string;
  display_name: string;
  timezone: string;
  locale: string;
}

interface FlowTimeAuthResponse {
  user: FlowTimeUser;
  access_token: string;
  token_type: string;
  expires_at: string;
}

interface SyncPullResponse {
  records: SyncRecordResponse[];
  latest_version: number;
  server_time: string;
}

interface SyncRecordResponse {
  collection: string;
  record_id: string;
  payload: Record<string, unknown>;
  deleted: boolean;
  server_version: number;
  updated_at: string;
}

interface FlowTimeCategory {
  id: string;
  name: string;
  is_deleted: boolean;
}

interface FlowTimeTag {
  id: string;
  name: string;
  is_archived: boolean;
}

interface FlowTimeEntry {
  id: string;
  category_id: string;
  start_time: string;
  end_time: string | null;
  note: string | null;
  tags: string[];
  focus_rating: number | null;
  is_focus_mode: boolean;
  pleasure_score: number | null;
  meaning_score: number | null;
}

interface FlowTimeDataSet {
  categories: Map<string, FlowTimeCategory>;
  tags: Map<string, FlowTimeTag>;
  entryRecords: SyncRecordResponse[];
}

interface DayEntries {
  date: string;
  entries: FlowTimeEntry[];
  maxServerVersion: number;
}

interface BridgeWriteResult {
  path?: string;
  managedBlockHash?: string;
  conflict?: boolean;
  errorMessage?: string;
}

interface EmptyCleanupResult {
  conflict: boolean;
  errorMessage?: string;
}

export default class FlowTimePlugin extends Plugin {
  settings: FlowTimePluginSettings = { ...DEFAULT_SETTINGS };
  private cachedCategoryRecords: SyncRecordResponse[] = [];
  private cachedTagRecords: SyncRecordResponse[] = [];
  private cachedEntryRecords: SyncRecordResponse[] = [];
  private collectionCursors: Record<string, number> = {};

  async onload() {
    await this.loadSettings();

    this.registerView(
      VIEW_TYPE_FLOWTIME_CALENDAR,
      (leaf) => new FlowTimeCalendarView(leaf, this),
    );

    this.addRibbonIcon("calendar-days", "Open FlowTime calendar", () => {
      void this.activateCalendarView();
    });

    this.addCommand({
      id: "open-flowtime-calendar",
      name: "Open FlowTime calendar",
      callback: () => {
        void this.activateCalendarView();
      },
    });

    this.addCommand({
      id: "sync-flowtime-today",
      name: "Sync today's FlowTime log",
      callback: () => {
        void this.syncToday();
      },
    });

    this.addCommand({
      id: "sync-flowtime-date",
      name: "Sync FlowTime log for date...",
      callback: () => {
        new DateInputModal(this.app, "同步 FlowTime 日期", getLocalToday(), (date) => {
          void this.syncDay(date);
        }).open();
      },
    });

    this.addCommand({
      id: "force-refresh-flowtime-date",
      name: "Force refresh FlowTime data for date...",
      callback: () => {
        new DateInputModal(this.app, "强制刷新 FlowTime 日期", getLocalToday(), (date) => {
          void this.forceRefreshDay(date);
        }).open();
      },
    });

    this.addSettingTab(new FlowTimeSettingTab(this.app, this));
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_FLOWTIME_CALENDAR);
  }

  async activateCalendarView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_FLOWTIME_CALENDAR);
    if (leaves.length > 0) {
      const existingLeaf = leaves[0];
      if (existingLeaf) {
        this.app.workspace.revealLeaf(existingLeaf);
      }
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice("无法打开 FlowTime 日历视图。");
      return;
    }

    await leaf.setViewState({
      type: VIEW_TYPE_FLOWTIME_CALENDAR,
      active: true,
    });
    this.app.workspace.revealLeaf(leaf);
  }

  async login(email: string, password: string): Promise<void> {
    const normalizedEmail = email.trim();
    if (!normalizedEmail) {
      throw new Error("请输入 FlowTime 登录邮箱。");
    }
    if (!password) {
      throw new Error("请输入 FlowTime 登录密码。");
    }

    const auth = await this.requestJson<FlowTimeAuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: normalizedEmail,
        password,
      }),
    });

    this.settings.email = auth.user.email;
    this.settings.accessToken = auth.access_token;
    this.settings.tokenType = auth.token_type || "Bearer";
    this.settings.tokenExpiresAt = auth.expires_at;
    await this.saveSettings();

    new Notice(`FlowTime 登录成功：${auth.user.display_name || auth.user.email}`);
  }

  async logout(): Promise<void> {
    this.settings.accessToken = "";
    this.settings.tokenType = "Bearer";
    this.settings.tokenExpiresAt = "";
    this.cachedCategoryRecords = [];
    this.cachedTagRecords = [];
    this.cachedEntryRecords = [];
    this.collectionCursors = {};
    await this.saveSettings();
    new Notice("已清除 FlowTime 登录状态。");
  }

  async syncToday(): Promise<void> {
    await this.syncDay(getLocalToday());
  }

  async forceRefreshDay(date: string): Promise<void> {
    this.resetFlowTimeDataCache();
    await this.syncDay(date);
  }

  async syncDay(date: string, options: { quiet?: boolean; force?: boolean } = {}): Promise<void> {
    if (!isValidLocalDate(date)) {
      new Notice(`日期格式无效：${date}`);
      return;
    }
    if (!this.settings.accessToken) {
      new Notice("请先在 FlowTime 插件设置中登录。");
      return;
    }

    const previous = this.getDayState(date);
    if (previous.locked && !options.force) {
      new Notice(`${date} 已锁定，已跳过同步。`);
      return;
    }

    this.updateDayState(date, {
      ...previous,
      status: "syncing",
      errorMessage: "",
    });
    this.setCalendarViewsSyncing(true);

    try {
      if (!options.quiet) {
        new Notice(`正在同步 FlowTime 日志：${date}`);
      }

      const data = await this.loadFlowTimeData();
      const dayEntries = collectDayEntries(date, data.entryRecords);
      await this.writeSyncedDay(date, dayEntries, data, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateDayState(date, {
        ...this.getDayState(date),
        status: "error",
        errorMessage: message,
      });
      new Notice(`FlowTime 同步失败：${message}`);
      console.error("[FlowTime] syncDay failed", error);
    } finally {
      this.setCalendarViewsSyncing(false);
      await this.refreshCalendarViews();
    }
  }

  async syncMonth(year: number, monthIndex: number): Promise<void> {
    if (!this.settings.accessToken) {
      new Notice("请先在 FlowTime 插件设置中登录。");
      return;
    }

    this.setCalendarViewsSyncing(true);
    try {
      new Notice("正在同步 FlowTime 本月数据...");
      const data = await this.loadFlowTimeData();
      const grouped = collectMonthEntries(year, monthIndex, data.entryRecords);
      const datesInMonth = getDatesInMonth(year, monthIndex);
      let syncedCount = 0;

      for (const date of datesInMonth) {
        const previous = this.getDayState(date);
        if (previous.locked) {
          this.updateDayState(date, { ...previous, status: "locked", locked: true });
          continue;
        }

        const dayEntries = grouped.get(date) ?? {
          date,
          entries: [],
          maxServerVersion: 0,
        };
        const result = await this.writeSyncedDay(date, dayEntries, data, { quiet: true });
        if (result.status === "synced") {
          syncedCount += 1;
        }
      }

      new Notice(`FlowTime 本月同步完成：${syncedCount} 天。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`FlowTime 本月同步失败：${message}`);
      console.error("[FlowTime] syncMonth failed", error);
    } finally {
      this.setCalendarViewsSyncing(false);
      await this.refreshCalendarViews();
    }
  }

  async refreshMonthStatus(year: number, monthIndex: number): Promise<void> {
    if (!this.settings.accessToken) {
      new Notice("请先在 FlowTime 插件设置中登录。");
      return;
    }

    try {
      const data = await this.loadFlowTimeData();
      const grouped = collectMonthEntries(year, monthIndex, data.entryRecords);

      for (const date of getDatesInMonth(year, monthIndex)) {
        const previous = this.getDayState(date);
        if (previous.locked) {
          this.updateDayState(date, { ...previous, status: "locked", locked: true });
          continue;
        }

        const dayEntries = grouped.get(date);
        if (!dayEntries || dayEntries.entries.length === 0) {
          this.updateDayState(date, {
            ...previous,
            status: "empty",
            totalMinutes: 0,
            entryCount: 0,
            topCategory: "",
            serverCursor: "0",
          });
          continue;
        }

        const metrics = buildDayMetrics(date, dayEntries.entries, data.categories);
        const serverCursor = String(dayEntries.maxServerVersion);
        const status: DaySyncStatus =
          previous.status === "conflict"
            ? "conflict"
            : previous.serverCursor === serverCursor && previous.managedBlockHash
              ? "synced"
              : "stale";

        this.updateDayState(date, {
          ...previous,
          status,
          serverCursor,
          totalMinutes: metrics.totalMinutes,
          entryCount: dayEntries.entries.length,
          topCategory: metrics.topCategory,
        });
      }

      await this.saveSettings();
      await this.refreshCalendarViews();
      new Notice("FlowTime 本月状态已刷新。");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`FlowTime 刷新失败：${message}`);
      console.error("[FlowTime] refreshMonthStatus failed", error);
    }
  }

  async openFlowTimeDaily(date: string): Promise<void> {
    const state = this.getDayState(date);
    const file = state.obsidianDailyPath
      ? this.app.vault.getAbstractFileByPath(state.obsidianDailyPath)
      : this.findDailyNoteFile(date);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
      return;
    }
    await this.openObsidianDaily(date);
  }

  async openObsidianDaily(date: string): Promise<void> {
    const file = this.findDailyNoteFile(date);
    if (file) {
      await this.app.workspace.getLeaf(false).openFile(file);
      return;
    }

    const configuredPath = this.dailyNotePath(date) ?? `${date}.md`;

    await ensureFolder(this.app, parentFolder(configuredPath));
    const created = await this.createDailyNoteFromTemplate(date, configuredPath);
    await this.app.workspace.getLeaf(false).openFile(created);
  }

  weeklyNotePath(year: number, week: number): string | null {
    const folder = this.settings.weeklyNoteFolder.trim();
    if (!folder) return null;

    const format = this.settings.weeklyNoteFormat.trim() || "YYYY-[W]WW";
    const m = moment().isoWeekYear(year).isoWeek(week).startOf("isoWeek");
    const filename = m.format(format);

    return normalizePath(`${folder}/${filename}.md`);
  }

  async openWeeklyNote(year: number, week: number): Promise<void> {
    const path = this.weeklyNotePath(year, week);
    if (!path) {
      new Notice("未配置周记保存路径。");
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
      return;
    }

    await ensureFolder(this.app, parentFolder(path));
    let content = `# ${year} 年第 ${week} 周总结\n`;

    const templatePath = this.settings.weeklyNoteTemplatePath.trim();
    if (templatePath) {
      const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
      if (templateFile instanceof TFile) {
        content = await this.app.vault.read(templateFile);
      } else {
        new Notice(`未找到配置的模板文件：${templatePath}`);
      }
    }

    const created = await this.app.vault.create(path, content);
    await this.app.workspace.getLeaf(false).openFile(created);
  }

  async syncWeeklyNote(year: number, week: number, mondayDate: string): Promise<void> {
    if (!this.settings.accessToken) {
      new Notice("请先在 FlowTime 插件设置中登录。");
      return;
    }

    this.setCalendarViewsSyncing(true);
    try {
      new Notice(`正在同步 FlowTime 周度数据：${year} 年第 ${week} 周`);

      const data = await this.loadFlowTimeData();
      const range = localWeekDateRange(mondayDate);

      // 过滤出这一周内的所有 entries
      const matchingRecords = data.entryRecords.filter((record) => {
        const entry = parseEntry(record.payload);
        return !record.deleted && entry !== null && isEntryInRange(entry, range.start, range.end);
      });

      const entries = matchingRecords
        .map((record) => parseEntry(record.payload))
        .filter((entry): entry is FlowTimeEntry => entry !== null)
        .sort((a, b) => dateValue(a.start_time) - dateValue(b.start_time));

      // 渲染周总结 Markdown
      const markdown = renderWeeklyLog({
        year,
        week,
        startDate: formatLocalDate(range.start),
        endDate: formatLocalDate(new Date(range.end.getTime() - 86400000)),
        entries,
        categories: data.categories,
        tags: data.tags,
      });

      const path = this.weeklyNotePath(year, week);
      if (!path) {
        new Notice("未配置周记保存路径。");
        return;
      }

      await ensureFolder(this.app, parentFolder(path));

      // 局部托管写入或整体创建
      const existingFile = this.app.vault.getAbstractFileByPath(path);
      if (existingFile instanceof TFile) {
        const content = await this.app.vault.read(existingFile);
        const existingBlock = extractManagedBlock(content);
        if (existingBlock && !isManagedBlockPristine(existingBlock)) {
          new Notice("周总结托管区存在本地修改，已跳过同步。");
          return;
        }

        const block = buildWeeklyManagedBlock(year, week, markdown);
        const next = replaceOrInsertManagedBlock(
          content,
          block,
          "bottom",
        );

        await this.app.vault.modify(existingFile, next.content);
        new Notice(`周总结数据已写入：${path}`);
      } else {
        let content = `# ${year} 年第 ${week} 周总结\n\n`;
        const templatePath = this.settings.weeklyNoteTemplatePath.trim();
        if (templatePath) {
          const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
          if (templateFile instanceof TFile) {
            content = await this.app.vault.read(templateFile);
          }
        }

        const block = buildWeeklyManagedBlock(year, week, markdown);
        const nextContent = replaceOrInsertManagedBlock(content, block, "bottom").content;
        await this.app.vault.create(path, nextContent);
        new Notice(`周总结文件已创建并同步数据：${path}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`FlowTime 周同步失败：${message}`);
      console.error("[FlowTime] syncWeeklyNote failed", error);
    } finally {
      this.setCalendarViewsSyncing(false);
      await this.refreshCalendarViews();
    }
  }

  async toggleDayLock(date: string): Promise<void> {
    const previous = this.getDayState(date);
    const locked = !previous.locked;
    this.updateDayState(date, {
      ...previous,
      status: locked ? "locked" : previous.status === "locked" ? "stale" : previous.status,
      locked,
    });
    await this.saveSettings();
    await this.refreshCalendarViews();
    new Notice(locked ? `${date} 已锁定。` : `${date} 已解除锁定。`);
  }

  getDayState(date: string): DaySyncState {
    return this.settings.dayStates[date] ?? {
      date,
      status: "empty",
      locked: false,
      totalMinutes: 0,
      entryCount: 0,
      topCategory: "",
    };
  }

  getStatesForMonth(year: number, monthIndex: number): DaySyncState[] {
    return getDatesInMonth(year, monthIndex).map((date) => this.getDayState(date));
  }

  getMonthStats(year: number, monthIndex: number) {
    return buildMonthStats(this.getStatesForMonth(year, monthIndex));
  }

  private async writeSyncedDay(
    date: string,
    dayEntries: DayEntries,
    data: FlowTimeDataSet,
    options: { quiet?: boolean; force?: boolean },
  ): Promise<DaySyncState> {
    const previous = this.getDayState(date);
    const metrics = buildDayMetrics(date, dayEntries.entries, data.categories);

    if (dayEntries.entries.length === 0) {
      const cleanup = await this.clearSyncedDayContent(date, previous, options.force);
      if (cleanup.conflict) {
        const state = this.updateDayState(date, {
          ...previous,
          status: "conflict",
          serverCursor: String(dayEntries.maxServerVersion),
          totalMinutes: 0,
          entryCount: 0,
          topCategory: "",
          errorMessage: cleanup.errorMessage,
        });
        await this.saveSettings();
        if (!options.quiet) {
          new Notice(`${date} 的旧 FlowTime 内容存在本地修改，已标记冲突。`);
        }
        return state;
      }

      const state = this.updateDayState(date, {
        ...previous,
        status: "empty",
        flowtimeDailyPath: undefined,
        renderedHash: undefined,
        managedBlockHash: undefined,
        serverCursor: String(dayEntries.maxServerVersion),
        totalMinutes: 0,
        entryCount: 0,
        topCategory: "",
        errorMessage: "",
      });
      await this.saveSettings();
      if (!options.quiet) {
        new Notice(`${date} 没有 FlowTime 时间记录。`);
      }
      return state;
    }

    const managedBody = renderDailyManagedBlockBody({
      date,
      generatedAt: new Date(),
      entries: dayEntries.entries,
      categories: data.categories,
      tags: data.tags,
    });
    const writeResult = await this.writeDailyNoteManagedBlock(date, managedBody, previous, options.force);

    if (writeResult?.conflict) {
      const state = this.updateDayState(date, {
        ...previous,
        status: "conflict",
        flowtimeDailyPath: undefined,
        obsidianDailyPath: writeResult.path ?? previous.obsidianDailyPath,
        serverCursor: String(dayEntries.maxServerVersion),
        totalMinutes: metrics.totalMinutes,
        entryCount: dayEntries.entries.length,
        topCategory: metrics.topCategory,
        errorMessage: writeResult.errorMessage,
      });
      await this.saveSettings();
      if (!options.quiet) {
        new Notice(`${date} 的 Daily Note FlowTime 托管区存在本地修改，已标记冲突。`);
      }
      return state;
    }

    const state = this.updateDayState(date, {
      ...previous,
      status: "synced",
      locked: false,
      flowtimeDailyPath: undefined,
      obsidianDailyPath: writeResult?.path ?? previous.obsidianDailyPath,
      serverCursor: String(dayEntries.maxServerVersion),
      renderedHash: undefined,
      managedBlockHash: writeResult?.managedBlockHash ?? previous.managedBlockHash,
      totalMinutes: metrics.totalMinutes,
      entryCount: dayEntries.entries.length,
      topCategory: metrics.topCategory,
      lastSyncedAt: new Date().toISOString(),
      errorMessage: "",
    });

    this.settings.lastSyncAt = state.lastSyncedAt ?? "";
    this.settings.lastSyncedDailyPath = state.obsidianDailyPath ?? "";
    await this.saveSettings();

    if (!options.quiet) {
      new Notice(`FlowTime 日志已写入日记：${state.obsidianDailyPath ?? date}`);
    }
    return state;
  }

  private async writeDailyNoteManagedBlock(
    date: string,
    managedBody: string,
    previous: DaySyncState,
    force = false,
  ): Promise<BridgeWriteResult> {
    const targetPath = this.dailyNotePath(date);
    const existingFile = this.findDailyNoteFile(date);

    if (!targetPath) {
      const candidates = this.findDailyNoteCandidates(date);
      if (candidates.length > 1) {
        return {
          conflict: true,
          errorMessage: "Multiple daily notes match this date; configure Daily Note folder before sync.",
        };
      }
    }

    const { file, created } = existingFile
      ? { file: existingFile, created: false }
      : {
          file: await this.createDailyNoteFromTemplate(date, targetPath ?? `${date}.md`),
          created: true,
        };
    const content = await this.app.vault.read(file);
    const existingBlock = extractManagedBlock(content);

    if (existingBlock && !force && !created) {
      const expectedBlockUnchanged = previous.managedBlockHash
        ? hashText(existingBlock) === previous.managedBlockHash
        : isManagedBlockPristine(existingBlock);
      if (!expectedBlockUnchanged) {
        this.updateDayState(date, {
          ...previous,
          status: "conflict",
          errorMessage: "Daily Note managed block was modified locally.",
        });
        return {
          path: file.path,
          conflict: true,
          errorMessage: "Daily Note managed block was modified locally.",
        };
      }
    }

    const block = buildManagedBlockFromBody(date, managedBody);
    const next = replaceOrInsertManagedBlock(
      content,
      block,
      this.settings.dailyNoteInsertLocation,
      this.settings.dailyNoteInsertHeading,
    );

    await this.app.vault.modify(file, next.content);
    return {
      path: file.path,
      managedBlockHash: hashText(block),
    };
  }

  private async clearSyncedDayContent(
    date: string,
    previous: DaySyncState,
    force = false,
  ): Promise<EmptyCleanupResult> {
    const flowtimePath = previous.flowtimeDailyPath || flowTimeDailyPath(this.settings.targetFolder, date);
    const generatedFile = this.app.vault.getAbstractFileByPath(flowtimePath);
    if (generatedFile instanceof TFile) {
      const current = await this.app.vault.read(generatedFile);
      const safeToDelete =
        force ||
        (previous.renderedHash ? hashText(current) === previous.renderedHash : isOwnedDailyGeneratedContent(current));

      if (!safeToDelete) {
        return {
          conflict: true,
          errorMessage: "FlowTime generated file was modified locally.",
        };
      }

      await this.app.vault.delete(generatedFile);
    }

    const bridgeFile = previous.obsidianDailyPath
      ? this.app.vault.getAbstractFileByPath(previous.obsidianDailyPath)
      : this.findDailyNoteFile(date);
    if (bridgeFile instanceof TFile) {
      const content = await this.app.vault.read(bridgeFile);
      const existingBlock = extractManagedBlock(content);
      if (existingBlock) {
        const safeToRemove =
          force ||
          (previous.managedBlockHash
            ? hashText(existingBlock) === previous.managedBlockHash
            : isManagedBlockPristine(existingBlock));

        if (!safeToRemove) {
          return {
            conflict: true,
            errorMessage: "Daily Note managed block was modified locally.",
          };
        }

        await this.app.vault.modify(bridgeFile, removeManagedBlock(content));
      }
    }

    return { conflict: false };
  }

  private async createDailyNoteFromTemplate(date: string, path: string): Promise<TFile> {
    await ensureFolder(this.app, parentFolder(path));
    const templatePath = this.settings.dailyNoteTemplatePath.trim();
    if (templatePath) {
      const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
      if (templateFile instanceof TFile) {
        return this.app.vault.create(path, await this.app.vault.read(templateFile));
      }
      new Notice(`未找到配置的每日模板文件：${templatePath}`);
    }
    return this.app.vault.create(path, `# ${date}\n`);
  }

  private findDailyNoteFile(date: string): TFile | null {
    const configured = this.dailyNotePath(date);
    if (configured) {
      const file = this.app.vault.getAbstractFileByPath(configured);
      if (file instanceof TFile) return file;
    }

    const candidates = this.findDailyNoteCandidates(date);
    return candidates.length === 1 ? candidates[0] ?? null : null;
  }

  private findDailyNoteCandidates(date: string): TFile[] {
    const flowtimePath = flowTimeDailyPath(this.settings.targetFolder, date);
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.basename === date && file.path !== flowtimePath);
  }

  private dailyNotePath(date: string): string | null {
    const folder = this.settings.dailyNoteFolder.trim();
    if (!folder) return null;
    return normalizePath(`${folder}/${date}.md`);
  }

  private updateDayState(date: string, next: DaySyncState): DaySyncState {
    const stored = {
      ...next,
      date,
    };
    this.settings.dayStates = {
      ...this.settings.dayStates,
      [date]: stored,
    };
    return stored;
  }

  private resetFlowTimeDataCache(): void {
    this.cachedCategoryRecords = [];
    this.cachedTagRecords = [];
    this.cachedEntryRecords = [];
    this.collectionCursors = {};
  }

  private async loadFlowTimeData(): Promise<FlowTimeDataSet> {
    const [categoryRecords, tagRecords, entryRecords] = await Promise.all([
      this.pullCollection("core.categories", this.cachedCategoryRecords),
      this.pullCollection("core.tags", this.cachedTagRecords),
      this.pullCollection("core.time_entries", this.cachedEntryRecords),
    ]);

    return {
      categories: toCategoryMap(getLatestRecords(categoryRecords)),
      tags: toTagMap(getLatestRecords(tagRecords)),
      entryRecords: getLatestRecords(entryRecords),
    };
  }

  private async pullCollection(collection: string, cache: SyncRecordResponse[]): Promise<SyncRecordResponse[]> {
    let sinceVersion = this.collectionCursors[collection] ?? 0;
    const limit = 1000;
    const newRecords: SyncRecordResponse[] = [];

    while (true) {
      const query = new URLSearchParams({
        since_version: String(sinceVersion),
        collection,
        limit: String(limit),
      });
      const data = await this.requestJson<SyncPullResponse>(
        `/sync/records?${query.toString()}`,
        {
          method: "GET",
          authenticated: true,
        },
      );

      if (data.records.length === 0) {
        break;
      }

      newRecords.push(...data.records);
      const maxVersion = Math.max(...data.records.map((record) => record.server_version));
      if (maxVersion <= sinceVersion) {
        break;
      }
      sinceVersion = maxVersion;

      if (data.records.length < limit) {
        break;
      }
    }

    if (newRecords.length > 0) {
      this.collectionCursors[collection] = sinceVersion;
      for (const record of newRecords) {
        const index = cache.findIndex((r) => r.record_id === record.record_id);
        if (index > -1) {
          if (record.deleted) {
            cache.splice(index, 1);
          } else {
            cache[index] = record;
          }
        } else if (!record.deleted) {
          cache.push(record);
        }
      }
    }

    return cache;
  }

  private async requestJson<T>(
    path: string,
    options: {
      method: "GET" | "POST";
      body?: string;
      authenticated?: boolean;
    },
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (options.authenticated) {
      headers.Authorization = `${this.settings.tokenType || "Bearer"} ${this.settings.accessToken}`;
    }

    const url = this.apiUrl(path);
    if ((options.authenticated || path === "/auth/login") && !isSecureAuthUrl(url)) {
      throw new Error("FlowTime 登录和同步需要 HTTPS；本机 localhost/127.0.0.1/::1 调试地址除外。");
    }

    const response = await requestUrl({
      url,
      method: options.method,
      headers,
      body: options.body,
    });

    const envelope = response.json as FlowTimeApiEnvelope<T>;
    if (response.status < 200 || response.status >= 300) {
      throw new Error(envelope?.message || `HTTP ${response.status}`);
    }
    if (!envelope || envelope.code !== 0) {
      throw new Error(envelope?.message || "FlowTime API 返回错误。");
    }

    return envelope.data;
  }

  private apiUrl(path: string): string {
    const trimmed = this.settings.serverUrl.trim().replace(/\/+$/, "");
    const base = trimmed.endsWith("/api/v1") ? trimmed : `${trimmed}/api/v1`;
    return `${base}${path}`;
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<FlowTimePluginSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...data,
      dayStates: {
        ...DEFAULT_SETTINGS.dayStates,
        ...(data?.dayStates ?? {}),
      },
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async refreshCalendarViews(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_FLOWTIME_CALENDAR)) {
      const view = leaf.view;
      if (view instanceof FlowTimeCalendarView) {
        view.render();
      }
    }
  }

  private setCalendarViewsSyncing(syncing: boolean): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_FLOWTIME_CALENDAR)) {
      const view = leaf.view;
      if (view instanceof FlowTimeCalendarView) {
        view.setIsSyncing(syncing);
      }
    }
  }
}

class FlowTimeCalendarView extends ItemView {
  private plugin: FlowTimePlugin;
  private selectedDate = getLocalToday();
  private selectedWeek: { year: number; week: number; mondayDate: string } | null = null;
  private visibleMonth = startOfLocalMonth(new Date());
  private isSyncing = false;

  constructor(leaf: WorkspaceLeaf, plugin: FlowTimePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  setIsSyncing(val: boolean): void {
    this.isSyncing = val;
    this.render();
  }

  getViewType(): string {
    return VIEW_TYPE_FLOWTIME_CALENDAR;
  }

  getDisplayText(): string {
    return "FlowTime 日历";
  }

  getIcon(): string {
    return "calendar-days";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  render(): void {
    const container = this.containerEl.children[1] as HTMLElement | undefined;
    if (!container) return;
    container.empty();
    container.addClass("flowtime-calendar-view");

    this.renderCalendar(container);
  }

  private renderCalendar(container: Element): void {
    const header = container.createDiv({ cls: "flowtime-calendar-head" });
    header.createDiv({ text: "FlowTime 日历", cls: "flowtime-calendar-title" });
    const syncMonthButton = header.createEl("button", {
      text: this.isSyncing ? "同步中..." : "同步本月",
      cls: "flowtime-small-button",
    });
    if (this.isSyncing) {
      syncMonthButton.disabled = true;
    }
    syncMonthButton.addEventListener("click", () => {
      void this.plugin.syncMonth(this.visibleMonth.getFullYear(), this.visibleMonth.getMonth());
    });

    const nav = container.createDiv({ cls: "flowtime-month-nav" });
    const previous = nav.createEl("button", { text: "‹", cls: "flowtime-icon-button" });
    previous.ariaLabel = "上一月";
    previous.addEventListener("click", () => this.shiftMonth(-1));

    nav.createDiv({
      text: `${this.visibleMonth.getFullYear()} 年 ${this.visibleMonth.getMonth() + 1} 月`,
      cls: "flowtime-month-label",
    });

    const next = nav.createEl("button", { text: "›", cls: "flowtime-icon-button" });
    next.ariaLabel = "下一月";
    next.addEventListener("click", () => this.shiftMonth(1));

    const grid = container.createDiv({ cls: "flowtime-calendar-grid" });
    // 增加最左侧空白占位头
    grid.createDiv({ text: "", cls: "flowtime-calendar-dow" });
    for (const label of ["一", "二", "三", "四", "五", "六", "日"]) {
      grid.createDiv({ text: label, cls: "flowtime-calendar-dow" });
    }

    const days = buildCalendarCells(this.visibleMonth.getFullYear(), this.visibleMonth.getMonth());
    for (let i = 0; i < days.length; i += 1) {
      const day = days[i];
      if (!day) continue;

      // 渲染这行的周数格子
      if (i % 7 === 0) {
        const { year, week } = getYearAndWeek(day.date);
        const isWeekSelected = this.selectedWeek && this.selectedWeek.year === year && this.selectedWeek.week === week;
        const weekCell = grid.createEl("button", {
          cls: isWeekSelected ? "flowtime-calendar-week is-selected" : "flowtime-calendar-week",
        });
        weekCell.type = "button";
        weekCell.createSpan({ text: String(week), cls: "flowtime-week-number" });
        weekCell.ariaLabel = `第 ${week} 周`;
        weekCell.addEventListener("click", () => {
          this.selectedWeek = { year, week, mondayDate: day.date };
          this.selectedDate = ""; // 清空日期选中
          this.render();

          if (this.plugin.settings.clickToOpenDailyNote) {
            void this.plugin.openWeeklyNote(year, week);
          }
        });
      }

      const state = this.plugin.getDayState(day.date);
      const cell = grid.createEl("button", {
        cls: [
          "flowtime-calendar-day",
          day.inMonth ? "is-current-month" : "is-other-month",
          state.status ? `is-${state.status}` : "",
          day.date === this.selectedDate ? "is-selected" : "",
          day.date === getLocalToday() ? "is-today" : "",
        ].join(" "),
      });
      cell.type = "button";
      cell.createSpan({ text: String(day.day), cls: "flowtime-day-number" });
      cell.createSpan({ cls: "flowtime-day-marker" });
      cell.ariaLabel = `${day.date} ${statusLabel(state.status)}`;
      cell.addEventListener("click", () => {
        const isAlreadySelected = this.selectedDate === day.date;
        this.selectedDate = day.date;
        this.selectedWeek = null; // 清空周选中状态
        this.render();

        if (this.plugin.settings.clickToOpenDailyNote || isAlreadySelected) {
          void this.plugin.openObsidianDaily(day.date);
        }
      });
      cell.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.selectedDate = day.date;
        this.openDayMenu(event, day.date);
      });
    }

    this.renderLegend(container);
    this.renderStats(container);
    if (this.selectedWeek) {
      this.renderSelectedWeek(container);
    } else {
      this.renderSelectedDay(container);
    }
  }

  private renderSelectedWeek(container: Element): void {
    if (!this.selectedWeek) return;
    const { year, week, mondayDate } = this.selectedWeek;
    const range = localWeekDateRange(mondayDate);
    
    let totalMinutes = 0;
    let totalEntries = 0;
    const categoryMinutes = new Map<string, number>();

    const cursor = new Date(range.start.getTime());
    while (cursor.getTime() < range.end.getTime()) {
      const dateStr = formatLocalDate(cursor);
      const state = this.plugin.getDayState(dateStr);
      totalMinutes += state.totalMinutes ?? 0;
      totalEntries += state.entryCount ?? 0;
      if (state.topCategory) {
        categoryMinutes.set(state.topCategory, (categoryMinutes.get(state.topCategory) ?? 0) + (state.totalMinutes ?? 0));
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    let topCategory = "无";
    let maxMin = 0;
    for (const [cat, min] of categoryMinutes.entries()) {
      if (min > maxMin) {
        maxMin = min;
        topCategory = cat;
      }
    }

    const panel = container.createDiv({ cls: "flowtime-day-panel" });
    const title = panel.createDiv({ cls: "flowtime-day-panel-title" });
    const startStr = formatLocalDate(range.start).slice(5);
    const endStr = formatLocalDate(new Date(range.end.getTime() - 86400000)).slice(5);

    title.createSpan({ text: `${year}年第 ${week} 周 (${startStr} 至 ${endStr})` });
    title.createSpan({ text: "周总结", cls: "flowtime-status-badge is-synced" });

    const rows = panel.createDiv({ cls: "flowtime-day-meta" });
    rows.createDiv({ text: `本周总时长：${formatDuration(totalMinutes)}` });
    rows.createDiv({ text: `主要分类：${topCategory}` });
    rows.createDiv({ text: `总记录数：${totalEntries}` });

    const actions = panel.createDiv({ cls: "flowtime-day-actions" });
    
    const syncBtn = actions.createEl("button", { text: "同步此周数据", cls: "flowtime-small-button" });
    if (this.isSyncing) syncBtn.disabled = true;
    syncBtn.addEventListener("click", async () => {
      await this.plugin.syncWeeklyNote(year, week, mondayDate);
    });

    const openBtn = actions.createEl("button", { text: "打开周总结文件", cls: "flowtime-small-button" });
    if (this.isSyncing) openBtn.disabled = true;
    openBtn.addEventListener("click", async () => {
      await this.plugin.openWeeklyNote(year, week);
    });
  }

  private renderLegend(container: Element): void {
    const legend = container.createDiv({ cls: "flowtime-legend" });
    for (const item of [
      ["synced", "已同步"],
      ["stale", "服务端有更新"],
      ["conflict", "内容冲突"],
      ["locked", "已锁定"],
      ["empty", "无记录"],
    ] as Array<[DaySyncStatus, string]>) {
      const row = legend.createDiv({ cls: "flowtime-legend-item" });
      row.createSpan({ cls: `flowtime-legend-pip is-${item[0]}` });
      row.createSpan({ text: item[1] });
    }
  }

  private renderStats(container: Element): void {
    const stats = this.plugin.getMonthStats(this.visibleMonth.getFullYear(), this.visibleMonth.getMonth());
    const statsEl = container.createDiv({ cls: "flowtime-stats" });
    this.createStat(statsEl, String(stats.syncedDays), "已同步天");
    this.createStat(statsEl, String(stats.staleDays), "有更新");
    this.createStat(statsEl, String(stats.conflictDays), "冲突");
    this.createStat(statsEl, formatCompactDuration(stats.totalMinutes), "本月总计");
  }

  private createStat(parent: HTMLElement, value: string, label: string): void {
    const stat = parent.createDiv({ cls: "flowtime-stat" });
    stat.createDiv({ text: value, cls: "flowtime-stat-value" });
    stat.createDiv({ text: label, cls: "flowtime-stat-label" });
  }

  private renderSelectedDay(container: Element): void {
    const state = this.plugin.getDayState(this.selectedDate);
    const panel = container.createDiv({ cls: "flowtime-day-panel" });
    const title = panel.createDiv({ cls: "flowtime-day-panel-title" });
    title.createSpan({ text: this.selectedDate });
    title.createSpan({ text: statusLabel(state.status), cls: `flowtime-status-badge is-${state.status}` });

    const rows = panel.createDiv({ cls: "flowtime-day-meta" });
    rows.createDiv({ text: `总时长：${formatDuration(state.totalMinutes ?? 0)}` });
    rows.createDiv({ text: `主要分类：${state.topCategory || "无"}` });
    rows.createDiv({ text: `记录数：${state.entryCount ?? 0}` });
    if (state.errorMessage) {
      rows.createDiv({ text: `提示：${state.errorMessage}`, cls: "flowtime-day-error" });
    }

    const actions = panel.createDiv({ cls: "flowtime-day-actions" });
    this.createAction(actions, "同步此日数据", () => this.plugin.syncDay(this.selectedDate));
    this.createAction(actions, "强制刷新数据", () => this.plugin.forceRefreshDay(this.selectedDate));
    if (state.status === "conflict") {
      this.createAction(actions, "覆盖托管区并同步", () => this.plugin.syncDay(this.selectedDate, { force: true }));
    }
    this.createAction(actions, "打开时间日志", () => this.plugin.openFlowTimeDaily(this.selectedDate));
    this.createAction(actions, "打开日记文件", () => this.plugin.openObsidianDaily(this.selectedDate));
  }

  private createAction(parent: HTMLElement, label: string, action: () => Promise<void>): void {
    const button = parent.createEl("button", { text: label, cls: "flowtime-small-button" });
    if (this.isSyncing) {
      button.disabled = true;
    }
    button.addEventListener("click", () => {
      void action();
    });
  }



  private openDayMenu(event: MouseEvent, date: string): void {
    const state = this.plugin.getDayState(date);
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle("同步此日数据").setIcon("refresh-cw").onClick(() => {
        void this.plugin.syncDay(date);
      }),
    );
    menu.addItem((item) =>
      item.setTitle("强制刷新数据").setIcon("refresh-cw").onClick(() => {
        void this.plugin.forceRefreshDay(date);
      }),
    );
    if (state.status === "conflict") {
      menu.addItem((item) =>
        item.setTitle("覆盖托管区并同步").setIcon("replace").onClick(() => {
          void this.plugin.syncDay(date, { force: true });
        }),
      );
    }
    menu.addItem((item) =>
      item.setTitle("打开时间日志").setIcon("file-text").onClick(() => {
        void this.plugin.openFlowTimeDaily(date);
      }),
    );
    menu.addItem((item) =>
      item.setTitle("打开日记文件").setIcon("file").onClick(() => {
        void this.plugin.openObsidianDaily(date);
      }),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(state.locked ? "解除锁定" : "锁定此文件（不自动同步）")
        .setIcon("lock")
        .onClick(() => {
          void this.plugin.toggleDayLock(date);
        }),
    );
    menu.showAtMouseEvent(event);
  }

  private shiftMonth(delta: number): void {
    this.visibleMonth = new Date(this.visibleMonth.getFullYear(), this.visibleMonth.getMonth() + delta, 1);
    this.render();
  }
}

class DateInputModal extends Modal {
  private title: string;
  private initialDate: string;
  private onSubmit: (date: string) => void;

  constructor(app: App, title: string, initialDate: string, onSubmit: (date: string) => void) {
    super(app);
    this.title = title;
    this.initialDate = initialDate;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.title });
    const input = contentEl.createEl("input", {
      type: "date",
      value: this.initialDate,
    });
    input.addClass("flowtime-date-input");
    const button = contentEl.createEl("button", {
      text: "同步",
      cls: "mod-cta flowtime-modal-button",
    });
    button.addEventListener("click", () => {
      const date = input.value.trim();
      if (!isValidLocalDate(date)) {
        new Notice("请输入有效日期。");
        return;
      }
      this.close();
      this.onSubmit(date);
    });
  }
}

class FlowTimeSettingTab extends PluginSettingTab {
  plugin: FlowTimePlugin;
  private password = "";

  constructor(app: App, plugin: FlowTimePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "FlowTime" });

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("FlowTime 后端地址，例如 http://localhost:8080。")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:8080")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Email")
      .setDesc("FlowTime 登录邮箱。")
      .addText((text) =>
        text
          .setPlaceholder("you@example.com")
          .setValue(this.plugin.settings.email)
          .onChange(async (value) => {
            this.plugin.settings.email = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Password")
      .setDesc("仅用于本次登录，不会保存到 Obsidian 插件配置。")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("FlowTime password")
          .setValue(this.password)
          .onChange((value) => {
            this.password = value;
          });
      });

    new Setting(containerEl)
      .setName("Login status")
      .setDesc(this.loginStatusText())
      .addButton((button) =>
        button.setButtonText("Log in").setCta().onClick(async () => {
          try {
            await this.plugin.login(this.plugin.settings.email, this.password);
            this.password = "";
            this.display();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`FlowTime 登录失败：${message}`);
          }
        }),
      )
      .addButton((button) =>
        button.setButtonText("Log out").onClick(async () => {
          await this.plugin.logout();
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName("旧版独立日志文件夹")
      .setDesc("仅用于兼容旧版 FlowTime/Daily 独立日志文件；新的每日同步会直接写入 Daily Note 托管区。")
      .addText((text) =>
        text
          .setPlaceholder("FlowTime/Daily")
          .setValue(this.plugin.settings.targetFolder)
          .onChange(async (value) => {
            this.plugin.settings.targetFolder = normalizePath(value || DEFAULT_SETTINGS.targetFolder);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Daily Note folder")
      .setDesc("用于打开或创建 Obsidian Daily Note，例如 Journals。留空时会查找同名日期笔记，找不到则在根目录创建。")
      .addText((text) =>
        text
          .setPlaceholder("Journals")
          .setValue(this.plugin.settings.dailyNoteFolder)
          .onChange(async (value) => {
            this.plugin.settings.dailyNoteFolder = normalizePath(value.trim());
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("每日模板文件路径")
      .setDesc("可选。新建 Daily Note 时使用的模板文件，例如 Templates/Daily.md；FlowTime 托管区会插入在模板内容中。")
      .addText((text) =>
        text
          .setPlaceholder("Templates/Daily.md")
          .setValue(this.plugin.settings.dailyNoteTemplatePath)
          .onChange(async (value) => {
            this.plugin.settings.dailyNoteTemplatePath = normalizePath(value.trim());
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("注入位置偏好")
      .setDesc("Daily Note 没有 managed 区块时，bridge 首次注入的位置。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("bottom", "底部")
          .addOption("top", "顶部")
          .addOption("after-heading", "指定 H2 标题之后")
          .setValue(this.plugin.settings.dailyNoteInsertLocation)
          .onChange(async (value) => {
            this.plugin.settings.dailyNoteInsertLocation = value as ManagedBlockInsertLocation;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("指定 H2 标题")
      .setDesc("当注入位置选择指定标题之后时使用，例如 学习成长。")
      .addText((text) =>
        text
          .setPlaceholder("学习成长")
          .setValue(this.plugin.settings.dailyNoteInsertHeading)
          .onChange(async (value) => {
            this.plugin.settings.dailyNoteInsertHeading = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("点击日期自动打开日记")
      .setDesc("开启后，在日历面板中单击任意日期将自动打开（或创建）当天的 Obsidian 每日日记。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.clickToOpenDailyNote).onChange(async (value) => {
          this.plugin.settings.clickToOpenDailyNote = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("周总结保存文件夹")
      .setDesc("存放每周时间日志总结周记的目录。")
      .addText((text) =>
        text
          .setPlaceholder("FlowTime/Weekly")
          .setValue(this.plugin.settings.weeklyNoteFolder)
          .onChange(async (value) => {
            this.plugin.settings.weeklyNoteFolder = normalizePath(value || "FlowTime/Weekly");
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("周记命名格式")
      .setDesc("例如 YYYY-[W]WW 将渲染出 2026-W22。支持 YYYY, WW, ww, W, w。")
      .addText((text) =>
        text
          .setPlaceholder("YYYY-[W]WW")
          .setValue(this.plugin.settings.weeklyNoteFormat)
          .onChange(async (value) => {
            this.plugin.settings.weeklyNoteFormat = value.trim() || "YYYY-[W]WW";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("周记模板文件路径")
      .setDesc("可选。新建周总结文件时使用的模板文件，例如 Templates/WeeklyTemplate.md。")
      .addText((text) =>
        text
          .setPlaceholder("Templates/WeeklyTemplate.md")
          .setValue(this.plugin.settings.weeklyNoteTemplatePath)
          .onChange(async (value) => {
            this.plugin.settings.weeklyNoteTemplatePath = normalizePath(value.trim());
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Open calendar")
      .setDesc("打开 FlowTime 日历面板。")
      .addButton((button) =>
        button.setButtonText("Open").setCta().onClick(() => {
          void this.plugin.activateCalendarView();
        }),
      );

    new Setting(containerEl)
      .setName("Sync today")
      .setDesc("拉取服务端今日时间记录，并写入今天 Daily Note 的 FlowTime 托管区。")
      .addButton((button) =>
        button.setButtonText("Sync now").setCta().onClick(() => {
          void this.plugin.syncToday();
        }),
      );

    const status = containerEl.createDiv({ cls: "flowtime-settings-status" });
    if (this.plugin.settings.lastSyncAt) {
      status.setText(
        `Last sync: ${this.plugin.settings.lastSyncAt} -> ${this.plugin.settings.lastSyncedDailyPath}`,
      );
    } else {
      status.setText("No sync has run yet.");
    }
  }

  private loginStatusText(): string {
    if (!this.plugin.settings.accessToken) {
      return "当前未登录。";
    }
    const expires = this.plugin.settings.tokenExpiresAt || "unknown expiry";
    return `已登录为 ${this.plugin.settings.email}，token 过期时间：${expires}`;
  }
}

function toCategoryMap(records: SyncRecordResponse[]): Map<string, FlowTimeCategory> {
  const result = new Map<string, FlowTimeCategory>();
  for (const record of records) {
    if (record.deleted) continue;
    const category = parseCategory(record.payload);
    if (category && !category.is_deleted) {
      result.set(category.id, category);
    }
  }
  return result;
}

function toTagMap(records: SyncRecordResponse[]): Map<string, FlowTimeTag> {
  const result = new Map<string, FlowTimeTag>();
  for (const record of records) {
    if (record.deleted) continue;
    const tag = parseTag(record.payload);
    if (tag && !tag.is_archived) {
      result.set(tag.id, tag);
    }
  }
  return result;
}

function parseCategory(payload: Record<string, unknown>): FlowTimeCategory | null {
  const id = stringValue(payload.id);
  const name = stringValue(payload.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    is_deleted: booleanValue(payload.is_deleted) ?? false,
  };
}

function parseTag(payload: Record<string, unknown>): FlowTimeTag | null {
  const id = stringValue(payload.id);
  const name = stringValue(payload.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    is_archived: booleanValue(payload.is_archived) ?? false,
  };
}

function parseEntry(payload: Record<string, unknown>): FlowTimeEntry | null {
  const id = stringValue(payload.id);
  const categoryId = stringValue(payload.category_id);
  const startTime = stringValue(payload.start_time);
  if (!id || !categoryId || !startTime) return null;

  return {
    id,
    category_id: categoryId,
    start_time: startTime,
    end_time: stringValue(payload.end_time),
    note: stringValue(payload.note),
    tags: stringArrayValue(payload.tags),
    focus_rating: numberValue(payload.focus_rating),
    is_focus_mode: booleanValue(payload.is_focus_mode) ?? false,
    pleasure_score: numberValue(payload.pleasure_score),
    meaning_score: numberValue(payload.meaning_score),
  };
}

function collectDayEntries(date: string, records: SyncRecordResponse[]): DayEntries {
  const range = localDateRange(date);
  const matchingRecords = records.filter((record) => {
    const entry = parseEntry(record.payload);
    return !record.deleted && entry !== null && isEntryInRange(entry, range.start, range.end);
  });

  const entries = matchingRecords
    .map((record) => parseEntry(record.payload))
    .filter((entry): entry is FlowTimeEntry => entry !== null)
    .sort((a, b) => dateValue(a.start_time) - dateValue(b.start_time));

  return {
    date,
    entries,
    maxServerVersion: maxServerVersion(matchingRecords),
  };
}

function collectMonthEntries(
  year: number,
  monthIndex: number,
  records: SyncRecordResponse[],
): Map<string, DayEntries> {
  const result = new Map<string, DayEntries>();
  for (const date of getDatesInMonth(year, monthIndex)) {
    result.set(date, collectDayEntries(date, records));
  }
  return result;
}

function maxServerVersion(records: SyncRecordResponse[]): number {
  if (records.length === 0) return 0;
  return Math.max(...records.map((record) => record.server_version));
}

function renderDailyLog(input: {
  date: string;
  generatedAt: Date;
  entries: FlowTimeEntry[];
  categories: Map<string, FlowTimeCategory>;
  tags: Map<string, FlowTimeTag>;
}): string {
  const range = localDateRange(input.date);
  const totalMinutes = input.entries.reduce((sum, entry) => sum + entryDurationInDay(entry, range.start, range.end), 0);
  const categoryTotals = buildCategoryTotals(input.entries, input.categories, range.start, range.end);
  const topCategory = categoryTotals[0]?.name ?? "";
  const avgHappiness = averageScore(input.entries, (entry) => entry.pleasure_score);
  const avgMeaning = averageScore(input.entries, (entry) => entry.meaning_score);
  const lines: string[] = [];

  lines.push("---");
  lines.push(`date: ${input.date}`);
  lines.push(`total_hours: ${formatHours(totalMinutes)}`);
  lines.push(`top_category: ${yamlString(topCategory)}`);
  lines.push(`avg_happiness: ${avgHappiness === null ? "null" : avgHappiness.toFixed(1)}`);
  lines.push(`avg_meaning: ${avgMeaning === null ? "null" : avgMeaning.toFixed(1)}`);
  lines.push("tags: [flowtime, daily-log]");
  lines.push("source: flowtime");
  lines.push("type: daily-log");
  lines.push(`entry_count: ${input.entries.length}`);
  lines.push(`total_minutes: ${totalMinutes}`);
  lines.push(`generated_at: ${input.generatedAt.toISOString()}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${input.date} FlowTime 日志`);
  lines.push("");
  lines.push("## 时间分配");
  lines.push("");
  if (categoryTotals.length === 0) {
    lines.push("暂无时间分配。");
  } else {
    lines.push("| 分类 | 时长 | 占比 |");
    lines.push("| --- | --- | --- |");
    for (const item of categoryTotals) {
      const percent = totalMinutes > 0 ? `${Math.round((item.minutes / totalMinutes) * 100)}%` : "0%";
      lines.push(`| ${tableCell(item.name)} | ${formatCompactDuration(item.minutes)} | ${percent} |`);
    }
  }
  lines.push("");

  lines.push("## 时间条目");
  lines.push("");
  if (input.entries.length === 0) {
    lines.push("今天暂无 FlowTime 时间记录。");
  } else {
    for (const entry of input.entries) {
      appendTimelineEntry(lines, entry, input.categories, input.tags);
    }
  }
  lines.push("");

  lines.push("## 分类统计");
  lines.push("");
  if (categoryTotals.length === 0) {
    lines.push("暂无分类统计。");
  } else {
    lines.push(`- 总时长：${formatDuration(totalMinutes)}`);
    lines.push(`- 记录数：${input.entries.length}`);
    lines.push(`- 最高分类：${topCategory || "无"}`);
  }
  lines.push("");

  lines.push("## 今日笔记");
  lines.push("");
  lines.push("暂无独立 Memo。");
  lines.push("");

  return lines.join("\n");
}

function renderDailyManagedBlockBody(input: {
  date: string;
  generatedAt: Date;
  entries: FlowTimeEntry[];
  categories: Map<string, FlowTimeCategory>;
  tags: Map<string, FlowTimeTag>;
}): string {
  const range = localDateRange(input.date);
  const totalMinutes = input.entries.reduce((sum, entry) => sum + entryDurationInDay(entry, range.start, range.end), 0);
  const categoryTotals = buildCategoryTotals(input.entries, input.categories, range.start, range.end);
  const topCategory = categoryTotals[0]?.name ?? "";
  const avgHappiness = averageScore(input.entries, (entry) => entry.pleasure_score);
  const avgMeaning = averageScore(input.entries, (entry) => entry.meaning_score);
  const lines: string[] = [];

  lines.push("## FlowTime 时间日志");
  lines.push("");
  lines.push(`- 同步时间：${input.generatedAt.toLocaleString()}`);
  lines.push(`- 总时长：${formatDuration(totalMinutes)}`);
  lines.push(`- 记录数：${input.entries.length}`);
  lines.push(`- 最高分类：${topCategory || "无"}`);
  lines.push(`- 快乐均分：${avgHappiness === null ? "无" : avgHappiness.toFixed(1)}`);
  lines.push(`- 意义均分：${avgMeaning === null ? "无" : avgMeaning.toFixed(1)}`);
  lines.push("");

  lines.push("### 时间分配");
  lines.push("");
  if (categoryTotals.length === 0) {
    lines.push("暂无时间分配。");
  } else {
    lines.push("| 分类 | 时长 | 占比 |");
    lines.push("| --- | --- | --- |");
    for (const item of categoryTotals) {
      const percent = totalMinutes > 0 ? `${Math.round((item.minutes / totalMinutes) * 100)}%` : "0%";
      lines.push(`| ${tableCell(item.name)} | ${formatCompactDuration(item.minutes)} | ${percent} |`);
    }
  }
  lines.push("");

  lines.push("### 时间条目");
  lines.push("");
  if (input.entries.length === 0) {
    lines.push("今天暂无 FlowTime 时间记录。");
  } else {
    for (const entry of input.entries) {
      appendTimelineEntry(lines, entry, input.categories, input.tags);
    }
  }
  lines.push("");

  lines.push("### 分类统计");
  lines.push("");
  if (categoryTotals.length === 0) {
    lines.push("暂无分类统计。");
  } else {
    lines.push(`- 总时长：${formatDuration(totalMinutes)}`);
    lines.push(`- 记录数：${input.entries.length}`);
    lines.push(`- 最高分类：${topCategory || "无"}`);
  }
  lines.push("");

  return lines.join("\n");
}

function buildDayMetrics(
  date: string,
  entries: FlowTimeEntry[],
  categories: Map<string, FlowTimeCategory>,
): { totalMinutes: number; topCategory: string } {
  const range = localDateRange(date);
  const totalMinutes = entries.reduce((sum, entry) => sum + entryDurationInDay(entry, range.start, range.end), 0);
  const categoryTotals = buildCategoryTotals(entries, categories, range.start, range.end);
  return {
    totalMinutes,
    topCategory: categoryTotals[0]?.name ?? "",
  };
}

function buildCategoryTotals(
  entries: FlowTimeEntry[],
  categories: Map<string, FlowTimeCategory>,
  rangeStart?: Date,
  rangeEnd?: Date
): Array<{ name: string; minutes: number }> {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    const name = categoryLabel(entry.category_id, categories);
    const minutes = rangeStart && rangeEnd
      ? entryDurationInDay(entry, rangeStart, rangeEnd)
      : durationMinutes(entry);
    if (minutes > 0) {
      totals.set(name, (totals.get(name) ?? 0) + minutes);
    }
  }
  return Array.from(totals.entries())
    .map(([name, minutes]) => ({ name, minutes }))
    .sort((a, b) => b.minutes - a.minutes);
}

function appendTimelineEntry(
  lines: string[],
  entry: FlowTimeEntry,
  categories: Map<string, FlowTimeCategory>,
  tags: Map<string, FlowTimeTag>,
): void {
  const categoryName = categoryLabel(entry.category_id, categories);
  const tagText = entry.tags
    .map((tagId) => tagLabel(tagId, tags))
    .filter((tag) => tag.length > 0)
    .join(", ");
  const score = compactScoreText(entry);
  const metaParts = [
    tagText || null,
    score,
    formatDuration(durationMinutes(entry)),
  ].filter((part): part is string => part !== null && part.length > 0);

  lines.push(`- ${timeRangeLabel(entry)} **${categoryName}** · ${metaParts.join(" · ")}`);
  appendIndentedNote(lines, entry.note);
}

function compactScoreText(entry: FlowTimeEntry): string | null {
  const parts: string[] = [];
  if (entry.focus_rating !== null) {
    parts.push(`🎯${entry.focus_rating}`);
  }
  if (entry.pleasure_score !== null) {
    parts.push(`😊${entry.pleasure_score}`);
  }
  if (entry.meaning_score !== null) {
    parts.push(`✨${entry.meaning_score}`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function appendIndentedNote(lines: string[], note: string | null): void {
  const trimmed = note?.trim();
  if (!trimmed) return;

  for (const noteLine of trimmed.split(/\r?\n/)) {
    lines.push(noteLine.trim() ? `    - ${noteLine}` : "    - ");
  }
}

function averageScore(
  entries: FlowTimeEntry[],
  selector: (entry: FlowTimeEntry) => number | null,
): number | null {
  const scores = entries
    .map(selector)
    .filter((score): score is number => score !== null);
  if (scores.length === 0) return null;
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

function timeRangeLabel(entry: FlowTimeEntry): string {
  const start = new Date(entry.start_time);
  const end = entry.end_time ? new Date(entry.end_time) : null;
  return `${formatTime(start)}-${end ? formatTime(end) : "进行中"}`;
}

function durationMinutes(entry: FlowTimeEntry): number {
  const start = new Date(entry.start_time);
  let end: Date;
  if (entry.end_time) {
    end = new Date(entry.end_time);
  } else {
    end = new Date();
  }
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
}

function dateValue(value: string): number {
  return new Date(value).getTime();
}

function categoryLabel(categoryId: string, categories: Map<string, FlowTimeCategory>): string {
  return categories.get(categoryId)?.name ?? categoryId;
}

function tagLabel(tagId: string, tags: Map<string, FlowTimeTag>): string {
  return tags.get(tagId)?.name ?? tagId;
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getLocalToday(): string {
  return formatLocalDate(new Date());
}

function startOfLocalMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function localDateRange(date: string): { start: Date; end: Date } {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid local date: ${date}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const start = new Date(year, month - 1, day);
  const end = new Date(year, month - 1, day + 1);
  return { start, end };
}

function isEntryInRange(entry: FlowTimeEntry, start: Date, end: Date): boolean {
  const entryStart = new Date(entry.start_time);
  const entryEnd = entry.end_time ? new Date(entry.end_time) : new Date();
  return entryStart < end && entryEnd > start;
}

function getDatesInMonth(year: number, monthIndex: number): string[] {
  const dates: string[] = [];
  const cursor = new Date(year, monthIndex, 1);
  while (cursor.getMonth() === monthIndex) {
    dates.push(formatLocalDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function buildCalendarCells(
  year: number,
  monthIndex: number,
): Array<{ date: string; day: number; inMonth: boolean }> {
  const first = new Date(year, monthIndex, 1);
  const startOffset = (first.getDay() + 6) % 7;
  const cursor = new Date(year, monthIndex, 1 - startOffset);
  const cells: Array<{ date: string; day: number; inMonth: boolean }> = [];
  for (let i = 0; i < 42; i += 1) {
    cells.push({
      date: formatLocalDate(cursor),
      day: cursor.getDate(),
      inMonth: cursor.getMonth() === monthIndex,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return cells;
}

function isValidLocalDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const range = localDateRange(date);
  return formatLocalDate(range.start) === date;
}

function formatTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function formatDuration(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}分钟`;
  if (minutes === 0) return `${hours}小时`;
  return `${hours}小时${minutes}分钟`;
}

function formatCompactDuration(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h${minutes}m`;
}

function formatHours(totalMinutes: number): string {
  return (totalMinutes / 60).toFixed(2);
}

function yamlString(value: string): string {
  if (!value) return '""';
  return JSON.stringify(value);
}

function tableCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "｜").trim() || "-";
}

function statusLabel(status: DaySyncStatus): string {
  const labels: Record<DaySyncStatus, string> = {
    empty: "无记录",
    synced: "已同步",
    stale: "服务端有更新",
    conflict: "内容冲突",
    locked: "已锁定",
    syncing: "同步中",
    error: "同步失败",
  };
  return labels[status];
}

function parentFolder(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

async function ensureFolder(app: App, folderPath: string): Promise<void> {
  const parts = folderPath.split("/").filter((part) => part.length > 0);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const existing = app.vault.getAbstractFileByPath(current);
    if (existing === null) {
      await app.vault.createFolder(current);
    } else if (!(existing instanceof TFolder)) {
      throw new Error(`${current} 已存在但不是文件夹。`);
    }
  }
}

function getYearAndWeek(dateStr: string): { year: number; week: number } {
  const m = moment(dateStr, "YYYY-MM-DD");
  return {
    year: m.isoWeekYear(),
    week: m.isoWeek(),
  };
}

function entryDurationInDay(entry: FlowTimeEntry, dayStart: Date, dayEnd: Date): number {
  const entryStart = new Date(entry.start_time);
  let entryEnd: Date;
  if (entry.end_time) {
    entryEnd = new Date(entry.end_time);
  } else {
    entryEnd = new Date();
  }

  const start = entryStart > dayStart ? entryStart : dayStart;
  const end = entryEnd < dayEnd ? entryEnd : dayEnd;

  if (start >= end) return 0;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
}

function localWeekDateRange(mondayDateStr: string): { start: Date; end: Date } {
  const match = mondayDateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid local date: ${mondayDateStr}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const start = new Date(year, month - 1, day);
  const end = new Date(year, month - 1, day + 7);
  return { start, end };
}

function buildWeeklyManagedBlock(year: number, week: number, body: string): string {
  return [
    `<!-- flowtime:managed-start year=${year} week=${week} hash=${hashText(body)} -->`,
    body,
    "<!-- flowtime:managed-end -->",
  ].join("\n");
}

function renderWeeklyLog(input: {
  year: number;
  week: number;
  startDate: string;
  endDate: string;
  entries: FlowTimeEntry[];
  categories: Map<string, FlowTimeCategory>;
  tags: Map<string, FlowTimeTag>;
}): string {
  const range = localWeekDateRange(input.startDate);
  const totalMinutes = input.entries.reduce((sum, entry) => sum + entryDurationInDay(entry, range.start, range.end), 0);
  const categoryTotals = buildCategoryTotals(input.entries, input.categories, range.start, range.end);
  const topCategory = categoryTotals[0]?.name ?? "无";

  const lines: string[] = [];
  lines.push("### 周数据面板");
  lines.push("");
  lines.push(`- **本周起止**：${input.startDate} 至 ${input.endDate}`);
  lines.push(`- **专注总时长**：${formatDuration(totalMinutes)} (${formatHours(totalMinutes)} 小时)`);
  lines.push(`- **核心分类**：${topCategory}`);
  lines.push(`- **本周记录数**：${input.entries.length} 条`);
  lines.push("");

  lines.push("### 时间分配占比");
  lines.push("");
  if (categoryTotals.length === 0) {
    lines.push("本周暂无时间分配记录。");
  } else {
    lines.push("| 分类 | 时长 | 占比 |");
    lines.push("| --- | --- | --- |");
    for (const item of categoryTotals) {
      const percent = totalMinutes > 0 ? `${Math.round((item.minutes / totalMinutes) * 100)}%` : "0%";
      lines.push(`| ${tableCell(item.name)} | ${formatCompactDuration(item.minutes)} | ${percent} |`);
    }
  }
  lines.push("");

  lines.push("### 每日专注时长趋势");
  lines.push("");

  const dayMinutes = new Map<string, { minutes: number; count: number }>();
  const cursor = new Date(range.start.getTime());
  const dates: string[] = [];
  while (cursor.getTime() < range.end.getTime()) {
    const dStr = formatLocalDate(cursor);
    dates.push(dStr);
    dayMinutes.set(dStr, { minutes: 0, count: 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  for (const entry of input.entries) {
    for (const dStr of dates) {
      const dayRange = localDateRange(dStr);
      const overlap = entryDurationInDay(entry, dayRange.start, dayRange.end);
      if (overlap > 0) {
        const current = dayMinutes.get(dStr);
        if (current) {
          current.minutes += overlap;
          current.count += 1;
        }
      }
    }
  }

  let maxDayMinutes = 0;
  for (const val of dayMinutes.values()) {
    if (val.minutes > maxDayMinutes) {
      maxDayMinutes = val.minutes;
    }
  }
  const barMax = Math.max(maxDayMinutes, 360);

  const dayOfWeekLabels = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  for (let i = 0; i < dates.length; i += 1) {
    const dStr = dates[i];
    if (!dStr) continue;
    const val = dayMinutes.get(dStr) ?? { minutes: 0, count: 0 };
    const barCount = Math.round((val.minutes / barMax) * 10);
    const bar = "█".repeat(barCount) + "░".repeat(10 - barCount);
    lines.push(`- **${dStr.slice(5)} (${dayOfWeekLabels[i]})**：${bar} ${formatCompactDuration(val.minutes)} (${val.count}条)`);
  }
  lines.push("");

  lines.push("### 本周专注备注精选");
  lines.push("");

  const memoEntries = input.entries.filter((entry) => entry.note?.trim());
  if (memoEntries.length === 0) {
    lines.push("本周暂无专注备注。");
  } else {
    for (const entry of memoEntries) {
      const entryDateStr = formatLocalDate(new Date(entry.start_time));
      const categoryName = input.categories.get(entry.category_id)?.name ?? entry.category_id;
      const score = compactScoreText(entry) ? ` · ${compactScoreText(entry)}` : "";
      lines.push(`- **${entryDateStr.slice(5)}** [${formatTime(new Date(entry.start_time))}] **${categoryName}** · ${formatCompactDuration(durationMinutes(entry))}${score}`);
      lines.push(`  - *“ ${entry.note?.trim()} ”*`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

function getLatestRecords(records: SyncRecordResponse[]): SyncRecordResponse[] {
  const latestMap = new Map<string, SyncRecordResponse>();
  for (const record of records) {
    const existing = latestMap.get(record.record_id);
    if (!existing || record.server_version > existing.server_version) {
      latestMap.set(record.record_id, record);
    }
  }
  return Array.from(latestMap.values()).filter((record) => !record.deleted);
}
