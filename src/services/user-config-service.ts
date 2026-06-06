import type { PrivateBotConfig, UsersConfigFile } from "../types.js";
import { readJsonFile, writeJsonFile } from "../utils/json-file.js";

export class UserConfigService {
  private cached?: UsersConfigFile;

  constructor(private readonly filePath: string, private readonly defaultSkillId = "itexpert") {}

  async getConfig(): Promise<UsersConfigFile> {
    if (this.cached) return this.cached;
    try {
      this.cached = normalizeUsersConfigFile(await readJsonFile<UsersConfigFile>(this.filePath), this.defaultSkillId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.cached = { superAdminUserIds: [], users: [] };
    }
    return this.cached;
  }

  async saveConfig(config: UsersConfigFile): Promise<void> {
    this.cached = normalizeUsersConfigFile(config, this.defaultSkillId);
    await writeJsonFile(this.filePath, this.cached);
  }

  async listUsers(): Promise<PrivateBotConfig[]> {
    return (await this.getConfig()).users;
  }

  async getUser(userId: string): Promise<PrivateBotConfig | undefined> {
    return (await this.getConfig()).users.find((user) => user.userId === userId);
  }

  async inviteUser(userId: string, patch: Partial<PrivateBotConfig> = {}): Promise<PrivateBotConfig> {
    const config = await this.getConfig();
    const existing = config.users.find((user) => user.userId === userId);
    if (existing) {
      Object.assign(existing, normalizeUser({ ...existing, ...patch, userId, enabled: true }, this.defaultSkillId));
      await this.saveConfig(config);
      return existing;
    }
    const user = normalizeUser({ ...patch, userId, enabled: true }, this.defaultSkillId);
    config.users.push(user);
    await this.saveConfig(config);
    return user;
  }

  async updateUser(userId: string, patch: Partial<PrivateBotConfig>): Promise<PrivateBotConfig | undefined> {
    const config = await this.getConfig();
    const index = config.users.findIndex((user) => user.userId === userId);
    if (index < 0) return undefined;
    config.users[index] = normalizeUser({ ...config.users[index], ...patch, userId }, this.defaultSkillId);
    await this.saveConfig(config);
    return config.users[index];
  }

  async removeUser(userId: string): Promise<boolean> {
    const config = await this.getConfig();
    const before = config.users.length;
    config.users = config.users.filter((user) => user.userId !== userId);
    await this.saveConfig(config);
    return config.users.length !== before;
  }

  async isSuperAdmin(userId: string): Promise<boolean> {
    return (await this.getConfig()).superAdminUserIds?.includes(userId) ?? false;
  }
}

export function normalizeUsersConfigFile(input: Partial<UsersConfigFile>, defaultSkillId: string): UsersConfigFile {
  return {
    superAdminUserIds: Array.isArray(input.superAdminUserIds) ? [...new Set(input.superAdminUserIds.map(String).filter(Boolean))] : [],
    users: Array.isArray(input.users) ? input.users.map((user) => normalizeUser(user, defaultSkillId)) : [],
  };
}

export function normalizeUser(input: Partial<PrivateBotConfig> & { userId?: string }, defaultSkillId: string): PrivateBotConfig {
  const userId = input.userId?.trim();
  if (!userId) throw new Error("invalid_user_id");
  const currentSkillId = input.currentSkillId?.trim() || defaultSkillId;
  const allowedSkillIds = Array.isArray(input.allowedSkillIds) && input.allowedSkillIds.length
    ? [...new Set(input.allowedSkillIds.map(String).filter(Boolean))]
    : [currentSkillId];
  return {
    userId,
    displayName: input.displayName?.trim() || undefined,
    enabled: input.enabled !== false,
    currentSkillId,
    allowedSkillIds: allowedSkillIds.includes(currentSkillId) ? allowedSkillIds : [currentSkillId, ...allowedSkillIds],
    adminUserIds: Array.isArray(input.adminUserIds) ? [...new Set(input.adminUserIds.map(String).filter(Boolean))] : [],
    replyModelMode: input.replyModelMode?.trim() || "default",
    voiceReplyEnabled: input.voiceReplyEnabled !== false,
    autoReplyEnabled: input.autoReplyEnabled !== false,
    scheduledRemindersEnabled: input.scheduledRemindersEnabled !== false,
    dailyDigestEnabled: input.dailyDigestEnabled ?? false,
    holidayCountdownEnabled: input.holidayCountdownEnabled ?? false,
    memoryEnabled: input.memoryEnabled !== false,
    knowledgeEnabled: input.knowledgeEnabled !== false,
  };
}
