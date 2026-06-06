import { randomUUID } from "node:crypto";

import type { SystemModelConfig, SystemModelPurpose, SystemSettings } from "../types.js";
import { readJsonFile, writeJsonFile } from "../utils/json-file.js";

type SystemSettingsUpdateInput = Partial<Omit<SystemSettings, "models">> & {
  models?: Array<Partial<SystemModelConfig> & { apiKey?: unknown }>;
};

export class SystemSettingsStore {
  private cached?: SystemSettings;

  constructor(
    private readonly filePath: string,
    private readonly defaultModels: Array<Partial<SystemModelConfig> & { apiKey?: string }> = [],
  ) {}

  async get(): Promise<SystemSettings> {
    return sanitizeSettings(await this.read());
  }

  async getInternal(): Promise<SystemSettings> {
    return cloneSettings(await this.read());
  }

  async update(input: SystemSettingsUpdateInput): Promise<SystemSettings> {
    const current = await this.read();
    const models = input.models === undefined
      ? current.models
      : normalizeModels(mergeModelApiKeys(current.models, input.models), this.defaultModels);
    const next: SystemSettings = normalizeSettings({
      ...current,
      ...input,
      models,
      selectedModelIds: input.selectedModelIds === undefined
        ? current.selectedModelIds
        : normalizeSelectedModelIds(input.selectedModelIds, models),
      updatedAt: new Date().toISOString(),
    }, this.defaultModels);
    await this.write(next);
    return sanitizeSettings(next);
  }

  async getSelectedModel(purpose: SystemModelPurpose): Promise<SystemModelConfig | undefined> {
    const settings = await this.read();
    const selectedId = settings.selectedModelIds[purpose];
    const selected = selectedId ? settings.models.find((model) => model.id === selectedId) : undefined;
    return selected?.enabled && selected.hasApiKey ? selected : settings.models.find((model) => model.purpose === purpose && model.enabled && model.hasApiKey);
  }

  private async read(): Promise<SystemSettings> {
    if (this.cached) return this.cached;
    try {
      this.cached = normalizeSettings(await readJsonFile<Partial<SystemSettings>>(this.filePath), this.defaultModels);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.cached = defaultSettings(this.defaultModels);
    }
    return this.cached;
  }

  private async write(data: SystemSettings): Promise<void> {
    this.cached = data;
    await writeJsonFile(this.filePath, data);
  }
}

function defaultSettings(defaultModels: Array<Partial<SystemModelConfig> & { apiKey?: string }>): SystemSettings {
  const models = normalizeModels([], defaultModels);
  return {
    models,
    selectedModelIds: normalizeSelectedModelIds({}, models),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeSettings(
  value: Partial<SystemSettings>,
  defaultModels: Array<Partial<SystemModelConfig> & { apiKey?: string }>,
): SystemSettings {
  const models = normalizeModels(value.models, defaultModels);
  return {
    models,
    selectedModelIds: normalizeSelectedModelIds(value.selectedModelIds, models),
    profileSummaryMaxChars: typeof value.profileSummaryMaxChars === "number" ? value.profileSummaryMaxChars : 1800,
    profileShortSummaryMaxChars: typeof value.profileShortSummaryMaxChars === "number" ? value.profileShortSummaryMaxChars : 140,
    dailyProfileReviewEnabled: value.dailyProfileReviewEnabled !== false,
    dailyProfileReviewTime: typeof value.dailyProfileReviewTime === "string" ? value.dailyProfileReviewTime : "00:00",
    memoryDedupEnabled: value.memoryDedupEnabled !== false,
    memoryDedupTime: typeof value.memoryDedupTime === "string" ? value.memoryDedupTime : "23:00",
    adminSecretConfigured: value.adminSecretConfigured === true,
    groupAdminSecretConfigured: value.groupAdminSecretConfigured === true,
    defaultTriggerKeywords: Array.isArray(value.defaultTriggerKeywords) ? value.defaultTriggerKeywords : [{ keyword: "XBot", enabled: true }],
    commands: Array.isArray(value.commands) ? value.commands : defaultCommands(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
  };
}

function normalizeModels(value: unknown, defaultModels: Array<Partial<SystemModelConfig> & { apiKey?: string }>): SystemModelConfig[] {
  const raw = [...(Array.isArray(value) ? value : []), ...defaultModels];
  const byId = new Map<string, SystemModelConfig>();
  for (const item of raw) {
    const model = normalizeModel(item as Partial<SystemModelConfig> & { apiKey?: string });
    if (model && !byId.has(model.id)) byId.set(model.id, model);
  }
  return [...byId.values()];
}

function normalizeModel(value: Partial<SystemModelConfig> & { apiKey?: string }): SystemModelConfig | undefined {
  const now = new Date().toISOString();
  const id = normalizeModelId(typeof value.id === "string" && value.id.trim() ? value.id : randomUUID());
  const name = String(value.name ?? "").trim().slice(0, 80);
  const shortName = String(value.shortName ?? name).trim().slice(0, 32);
  const baseUrl = String(value.baseUrl ?? "").trim().slice(0, 240);
  const model = String(value.model ?? "").trim().slice(0, 120);
  if (!id || !name || !shortName || !baseUrl || !model) return undefined;
  const apiKey = typeof value.apiKey === "string" && value.apiKey.trim() ? value.apiKey.trim() : undefined;
  return {
    id,
    name,
    shortName,
    baseUrl,
    model,
    purpose: normalizePurpose(value.purpose),
    ...(apiKey ? { apiKey } : {}),
    hasApiKey: value.hasApiKey === true || Boolean(apiKey),
    enabled: value.enabled !== false,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
  };
}

function normalizeSelectedModelIds(value: unknown, models: SystemModelConfig[]): SystemSettings["selectedModelIds"] {
  const selected: SystemSettings["selectedModelIds"] = {};
  const byId = new Map(models.map((model) => [model.id, model]));
  if (value && typeof value === "object") {
    for (const [purposeValue, idValue] of Object.entries(value as Record<string, unknown>)) {
      const purpose = normalizePurpose(purposeValue);
      const id = typeof idValue === "string" ? normalizeModelId(idValue) : "";
      const model = id ? byId.get(id) : undefined;
      if (model?.purpose === purpose) selected[purpose] = model.id;
    }
  }
  for (const model of models) {
    if (!selected[model.purpose] && model.enabled && model.hasApiKey) selected[model.purpose] = model.id;
  }
  return selected;
}

function mergeModelApiKeys(current: SystemModelConfig[], incoming: unknown): Array<Partial<SystemModelConfig> & { apiKey?: unknown }> {
  if (!Array.isArray(incoming)) return [];
  const byId = new Map(current.map((model) => [model.id, model]));
  return incoming.map((item) => {
    const record = item as Partial<SystemModelConfig> & { apiKey?: unknown };
    const currentModel = record.id ? byId.get(record.id) : undefined;
    const nextApiKey = typeof record.apiKey === "string" && record.apiKey.trim()
      ? record.apiKey.trim()
      : currentModel?.apiKey;
    return {
      ...record,
      ...(nextApiKey ? { apiKey: nextApiKey } : {}),
      hasApiKey: Boolean(nextApiKey) || record.hasApiKey === true,
    };
  });
}

function sanitizeSettings(settings: SystemSettings): SystemSettings {
  const cloned = cloneSettings(settings);
  cloned.models = cloned.models.map((model) => {
    const { apiKey: _apiKey, ...safeModel } = model;
    return { ...safeModel, hasApiKey: model.hasApiKey === true || Boolean(model.apiKey) };
  });
  return cloned;
}

function cloneSettings(settings: SystemSettings): SystemSettings {
  return JSON.parse(JSON.stringify(settings)) as SystemSettings;
}

function normalizePurpose(value: unknown): SystemModelPurpose {
  return value === "reply" ||
    value === "profile" ||
    value === "memory" ||
    value === "dedup" ||
    value === "summary" ||
    value === "knowledge" ||
    value === "tts" ||
    value === "custom"
    ? value
    : "custom";
}

function normalizeModelId(value: string): string {
  const text = value.trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(text) ? text : "";
}

function defaultCommands(): NonNullable<SystemSettings["commands"]> {
  const now = new Date().toISOString();
  return [
    { id: "help", title: "帮助", primary: "#帮助", aliases: ["#功能", "#命令"], permission: "member", enabled: true, help: "查看私聊 Agent 可用命令。", updatedAt: now },
    { id: "skill", title: "技能", primary: "#技能", aliases: [], permission: "member", enabled: true, help: "查看或切换当前私聊技能。", updatedAt: now },
    { id: "conversation", title: "上下文", primary: "#对话", aliases: [], permission: "member", enabled: true, help: "清空个人私聊上下文。", updatedAt: now },
    { id: "memory", title: "记忆", primary: "#记忆", aliases: [], permission: "member", enabled: true, help: "查看个人记忆状态。", updatedAt: now },
    { id: "profile", title: "画像", primary: "#画像", aliases: [], permission: "member", enabled: true, help: "生成个人画像总结。", updatedAt: now },
    { id: "reminder", title: "定时任务", primary: "#定时任务", aliases: ["#提醒"], permission: "member", enabled: true, help: "管理个人私聊提醒。", updatedAt: now },
    { id: "user", title: "用户开通", primary: "#用户", aliases: [], permission: "super_admin", enabled: true, help: "超级管理员开通私聊用户。", updatedAt: now },
  ];
}
