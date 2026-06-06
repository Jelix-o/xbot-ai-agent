import { randomUUID } from "node:crypto";

import type { PersonalReminderTask, PersonalRemindersFile } from "../types.js";
import { readJsonFile, writeJsonFile } from "../utils/json-file.js";
import { isScheduleDateRuleMatched, normalizeWeekdays } from "../utils/schedule-date-rule.js";

export interface ReminderCreateRequest {
  intervalMinutes: number;
  topic: string;
  executionStartTime?: string;
  executionEndTime?: string;
  executionIntervalMinutes?: number;
  dateRule?: PersonalReminderTask["dateRule"];
  weekdays?: number[];
}

export class PersonalReminderService {
  private cached?: PersonalRemindersFile;

  constructor(private readonly filePath: string) {}

  parseCreateRequest(input: string): ReminderCreateRequest | undefined {
    const text = input.trim();
    if (!/(?:定时任务|提醒)/.test(text)) return undefined;
    const minutes = parseIntervalMinutes(text);
    if (!minutes) return undefined;
    const topic = extractTopic(text);
    if (!topic) return undefined;
    return {
      intervalMinutes: minutes,
      topic,
      ...parseTimeWindow(text),
      ...parseDateRule(text),
    };
  }

  async createTask(args: { userId: string; creatorUserId: string; request: ReminderCreateRequest; now?: Date }): Promise<PersonalReminderTask> {
    const data = await this.read();
    const now = args.now ?? new Date();
    const task: PersonalReminderTask = {
      id: `rem-${formatCompactDate(now)}-${randomUUID().slice(0, 8)}`,
      userId: args.userId,
      creatorUserId: args.creatorUserId,
      intervalMinutes: args.request.executionIntervalMinutes ?? args.request.intervalMinutes,
      topic: args.request.topic,
      ...(args.request.executionStartTime ? { executionStartTime: args.request.executionStartTime } : {}),
      ...(args.request.executionEndTime ? { executionEndTime: args.request.executionEndTime } : {}),
      ...(args.request.executionIntervalMinutes ? { executionIntervalMinutes: args.request.executionIntervalMinutes } : {}),
      ...(args.request.dateRule ? { dateRule: args.request.dateRule } : {}),
      ...(args.request.weekdays?.length ? { weekdays: args.request.weekdays } : {}),
      createdAt: now.toISOString(),
      nextRunAt: calculateNextRunAt({
        now,
        intervalMinutes: args.request.intervalMinutes,
        executionStartTime: args.request.executionStartTime,
        executionEndTime: args.request.executionEndTime,
        executionIntervalMinutes: args.request.executionIntervalMinutes,
        dateRule: args.request.dateRule,
        weekdays: args.request.weekdays,
      }).toISOString(),
      enabled: true,
      recentMessages: [],
    };
    data.tasks[task.id] = task;
    await this.write(data);
    return task;
  }

  async listUserTasks(userId: string): Promise<PersonalReminderTask[]> {
    return Object.values((await this.read()).tasks).filter((task) => task.userId === userId);
  }

  async removeUserTask(userId: string, taskId: string): Promise<boolean> {
    const data = await this.read();
    const task = data.tasks[taskId];
    if (!task || task.userId !== userId) return false;
    delete data.tasks[taskId];
    await this.write(data);
    return true;
  }

  async setUserTaskEnabled(userId: string, taskId: string, enabled: boolean): Promise<PersonalReminderTask | undefined> {
    const data = await this.read();
    const task = data.tasks[taskId];
    if (!task || task.userId !== userId) return undefined;
    task.enabled = enabled;
    if (enabled) {
      task.nextRunAt = calculateNextRunAt({ now: new Date(), ...task }).toISOString();
    }
    await this.write(data);
    return task;
  }

  async getDueTasks(now = new Date()): Promise<PersonalReminderTask[]> {
    return Object.values((await this.read()).tasks)
      .filter((task) => task.enabled)
      .filter((task) => new Date(task.nextRunAt).getTime() <= now.getTime());
  }

  async markSent(taskId: string, message: string, now = new Date()): Promise<void> {
    const data = await this.read();
    const task = data.tasks[taskId];
    if (!task) return;
    task.recentMessages = [message, ...(task.recentMessages ?? [])].slice(0, 5);
    task.nextRunAt = calculateNextRunAt({ now: new Date(now.getTime() + 60 * 1000), ...task }).toISOString();
    await this.write(data);
  }

  buildReminderMessage(task: PersonalReminderTask): string {
    return `提醒：${task.topic}`;
  }

  formatTask(task: PersonalReminderTask): string {
    const rule = formatDateRule(task);
    const window = task.executionStartTime
      ? `${task.executionStartTime}-${task.executionEndTime ?? task.executionStartTime} 每 ${formatIntervalLabel(task.executionIntervalMinutes ?? task.intervalMinutes)}`
      : `每 ${formatIntervalLabel(task.intervalMinutes)}`;
    return `${task.id} - ${task.enabled ? "启用" : "暂停"} · ${rule} · ${window}：${task.topic}，下次 ${task.nextRunAt}`;
  }

  private async read(): Promise<PersonalRemindersFile> {
    if (this.cached) return this.cached;
    try {
      const data = await readJsonFile<Partial<PersonalRemindersFile>>(this.filePath);
      this.cached = normalizeFile(data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.cached = { tasks: {} };
    }
    return this.cached;
  }

  private async write(data: PersonalRemindersFile): Promise<void> {
    this.cached = data;
    await writeJsonFile(this.filePath, data);
  }
}

export function formatIntervalLabel(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60}小时`;
  return `${minutes}分钟`;
}

function parseIntervalMinutes(text: string): number | undefined {
  const hour = text.match(/每?\s*(\d+)\s*(?:小时|hour|hours|h)/i);
  if (hour) return clampMinutes(Number(hour[1]) * 60);
  const minute = text.match(/每?\s*(\d+)\s*(?:分钟|分|minute|minutes|min|m)/i);
  if (minute) return clampMinutes(Number(minute[1]));
  return undefined;
}

function parseTimeWindow(text: string): Pick<ReminderCreateRequest, "executionStartTime" | "executionEndTime" | "executionIntervalMinutes"> {
  const windowMatch = text.match(/(\d{1,2}:\d{2})\s*(?:-|~|到|至)\s*(\d{1,2}:\d{2})/);
  const start = normalizeTime(windowMatch?.[1]);
  const end = normalizeTime(windowMatch?.[2]);
  if (!start || !end) return {};
  return {
    executionStartTime: start,
    executionEndTime: end,
    executionIntervalMinutes: parseIntervalMinutes(text),
  };
}

function parseDateRule(text: string): Pick<ReminderCreateRequest, "dateRule" | "weekdays"> {
  if (/工作日|上班日/.test(text)) return { dateRule: "workday" };
  if (/休息日|节假日|假日|周末/.test(text)) return { dateRule: "holiday" };
  const weekdays = parseWeekdays(text);
  return weekdays.length ? { dateRule: "custom", weekdays } : { dateRule: "all" };
}

function parseWeekdays(text: string): number[] {
  const map = new Map([
    ["日", 0], ["天", 0], ["一", 1], ["二", 2], ["三", 3], ["四", 4], ["五", 5], ["六", 6],
  ]);
  const match = text.match(/周([一二三四五六日天、,，\s]+)/);
  if (!match?.[1]) return [];
  return normalizeWeekdays([...match[1]].flatMap((char) => map.has(char) ? [map.get(char)] : []));
}

function clampMinutes(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 1 || value > 24 * 60) return undefined;
  return Math.floor(value);
}

function extractTopic(text: string): string {
  return text
    .replace(/^#?定时任务\s*(添加|设置|创建|新建)?/u, "")
    .replace(/每?\s*\d+\s*(小时|hour|hours|h|分钟|分|minute|minutes|min|m)/iu, "")
    .replace(/\d{1,2}:\d{2}\s*(?:-|~|到|至)\s*\d{1,2}:\d{2}/u, "")
    .replace(/工作日|上班日|休息日|节假日|假日|周末|周[一二三四五六日天、,，\s]+/u, "")
    .replace(/^提醒我?/, "")
    .trim()
    .slice(0, 120);
}

function formatCompactDate(date: Date): string {
  return date.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}

function calculateNextRunAt(args: {
  now: Date;
  intervalMinutes: number;
  executionStartTime?: string;
  executionEndTime?: string;
  executionIntervalMinutes?: number;
  dateRule?: PersonalReminderTask["dateRule"];
  weekdays?: number[];
}): Date {
  const interval = clampMinutes(args.executionIntervalMinutes ?? args.intervalMinutes) ?? 60;
  if (!args.executionStartTime) {
    return new Date(args.now.getTime() + interval * 60 * 1000);
  }
  const startMinutes = timeToMinutes(args.executionStartTime);
  const endMinutes = Math.max(startMinutes, timeToMinutes(args.executionEndTime ?? args.executionStartTime));
  for (let offset = 0; offset < 370; offset += 1) {
    const day = new Date(args.now);
    day.setDate(day.getDate() + offset);
    day.setHours(0, 0, 0, 0);
    if (!isScheduleDateRuleMatched(args.dateRule, args.weekdays, day)) continue;
    for (let slot = startMinutes; slot <= endMinutes; slot += interval) {
      const candidate = new Date(day);
      candidate.setHours(Math.floor(slot / 60), slot % 60, 0, 0);
      if (candidate > args.now) return candidate;
    }
  }
  return new Date(args.now.getTime() + interval * 60 * 1000);
}

function normalizeFile(data: Partial<PersonalRemindersFile>): PersonalRemindersFile {
  const tasks: PersonalRemindersFile["tasks"] = {};
  if (!data.tasks || typeof data.tasks !== "object") return { tasks };
  for (const [id, task] of Object.entries(data.tasks)) {
    if (!task || typeof task !== "object") continue;
    const normalized = task as PersonalReminderTask;
    if (!normalized.userId || !normalized.creatorUserId || !normalized.topic || !normalized.createdAt || !normalized.nextRunAt) continue;
    tasks[id] = {
      ...normalized,
      id: normalized.id || id,
      intervalMinutes: clampMinutes(normalized.intervalMinutes) ?? 60,
      executionStartTime: normalizeTime(normalized.executionStartTime),
      executionEndTime: normalizeTime(normalized.executionEndTime),
      executionIntervalMinutes: normalized.executionIntervalMinutes ? clampMinutes(normalized.executionIntervalMinutes) : undefined,
      dateRule: normalizeDateRule(normalized.dateRule),
      weekdays: normalizeWeekdays(normalized.weekdays),
      enabled: normalized.enabled !== false,
      recentMessages: Array.isArray(normalized.recentMessages) ? normalized.recentMessages : [],
    };
  }
  return { tasks };
}

function normalizeTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeDateRule(value: unknown): PersonalReminderTask["dateRule"] {
  return value === "workday" || value === "holiday" || value === "custom" ? value : "all";
}

function timeToMinutes(value: string): number {
  const [hour = "0", minute = "0"] = value.split(":");
  return Number(hour) * 60 + Number(minute);
}

function formatDateRule(task: PersonalReminderTask): string {
  if (task.dateRule === "workday") return "工作日";
  if (task.dateRule === "holiday") return "休息日/节假日";
  if (task.dateRule === "custom") return `周${(task.weekdays ?? []).map(formatWeekday).join("") || "自定义"}`;
  return "每天";
}

function formatWeekday(day: number): string {
  return ["日", "一", "二", "三", "四", "五", "六"][day] ?? "";
}
