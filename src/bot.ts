import os from "node:os";

import { logError, logInfo } from "./logger.js";
import type { AiService } from "./services/ai-service.js";
import type { AdminOperationLogService } from "./services/admin-operation-log-service.js";
import type { ConversationStore } from "./services/conversation-store.js";
import type { PersonalKnowledgeStore } from "./services/personal-knowledge-store.js";
import type { PersonalMemoryCandidateService } from "./services/personal-memory-candidate-service.js";
import type { PersonalMemoryStore } from "./services/personal-memory-store.js";
import { formatIntervalLabel, type PersonalReminderService } from "./services/personal-reminder-service.js";
import type { SkillService } from "./services/skill-service.js";
import type { TtsService } from "./services/tts-service.js";
import type { UserConfigService } from "./services/user-config-service.js";
import type {
  MessageImageInput,
  NapcatPrivateMessageEvent,
  PrivateBotConfig,
  SystemHealthStatus,
  TransportHealthStatus,
} from "./types.js";
import { buildHolidayCountdownMessage } from "./utils/holiday-countdown.js";
import { extractCommandText, parsePrivateMessage } from "./utils/message-parser.js";

const HELP_PREFIXES = ["#帮助", "#功能", "#命令"];
const SKILL_PREFIX = "#技能";
const MODEL_PREFIX = "#模型";
const VOICE_PREFIX = "#语音";
const CONVERSATION_PREFIX = "#对话";
const MEMORY_PREFIX = "#记忆";
const PROFILE_PREFIX = "#画像";
const REMINDER_PREFIX = "#定时任务";
const DIGEST_PREFIXES = ["#日记", "#日报", "#摘要"];
const HOLIDAY_PREFIXES = ["#节假日", "#假期"];
const USER_PREFIX = "#用户";
const STATUS_PREFIX = "#状态";
const HEALTH_PREFIX = "#健康";
const SERVER_PREFIX = "#服务器";
const REMINDER_TICK_MS = 30 * 1000;
const MEMORY_FLUSH_TICK_MS = 2 * 60 * 1000;

export interface MessageTransport {
  sendPrivateMessage(userId: string, text: string): Promise<void>;
  sendPrivateRecord(userId: string, recordFile: string): Promise<void>;
  getHealthStatus?(): Promise<TransportHealthStatus>;
}

type ReplyAiService = Pick<AiService, "generateReply"> & Partial<Pick<AiService, "checkHealth">>;
type MemoryAiService = Pick<AiService, "summarizePersonalProfile"> & Partial<Pick<AiService, "generateReply" | "checkHealth">>;
type PrivateTtsService = Pick<TtsService, "synthesize">;

export class BotApplication {
  private reminderTimer?: NodeJS.Timeout;
  private memoryFlushTimer?: NodeJS.Timeout;
  private reminderTickRunning = false;
  private memoryFlushTickRunning = false;

  constructor(
    private readonly transport: MessageTransport,
    private readonly userConfigService: UserConfigService,
    private readonly skillService: SkillService,
    private readonly conversationStore: ConversationStore,
    private readonly aiService: ReplyAiService,
    private readonly memoryAiService: MemoryAiService,
    private readonly personalMemoryStore: PersonalMemoryStore,
    private readonly personalMemoryCandidateService: PersonalMemoryCandidateService,
    private readonly personalKnowledgeStore: PersonalKnowledgeStore,
    private readonly personalReminderService: PersonalReminderService,
    private readonly ttsService: PrivateTtsService,
    private readonly adminOperationLogService: AdminOperationLogService,
    private readonly botQq: string,
  ) {}

  start(): void {
    this.reminderTimer = setInterval(() => void this.runReminderTick(), REMINDER_TICK_MS);
    this.memoryFlushTimer = setInterval(() => void this.runMemoryFlushTick(), MEMORY_FLUSH_TICK_MS);
    void this.runReminderTick();
  }

  stop(): void {
    if (this.reminderTimer) clearInterval(this.reminderTimer);
    if (this.memoryFlushTimer) clearInterval(this.memoryFlushTimer);
  }

  async handlePrivateMessage(event: NapcatPrivateMessageEvent): Promise<void> {
    const userId = String(event.user_id);
    if (userId === this.botQq || event.user_id === event.self_id) return;
    const commandText = extractCommandText(event.message);
    const isSuperAdmin = await this.userConfigService.isSuperAdmin(userId);

    if (commandText.startsWith(USER_PREFIX) && isSuperAdmin) {
      await this.handleUserCommand(userId, commandText);
      return;
    }

    const userConfig = await this.userConfigService.getUser(userId);
    if (!userConfig || userConfig.enabled === false) {
      await this.transport.sendPrivateMessage(userId, "你还没有被邀请使用 XBot。请联系管理员先用 #用户 邀请 <QQ号> 开通。");
      return;
    }

    if (HELP_PREFIXES.some((prefix) => commandText === prefix || commandText.startsWith(`${prefix} `))) {
      await this.sendHelp(userId, isSuperAdmin);
      return;
    }
    if (commandText.startsWith(SKILL_PREFIX)) {
      await this.handleSkillCommand(userConfig, commandText);
      return;
    }
    if (commandText.startsWith(MODEL_PREFIX)) {
      await this.handleModelCommand(userConfig, commandText);
      return;
    }
    if (commandText.startsWith(CONVERSATION_PREFIX)) {
      await this.handleConversationCommand(userConfig, commandText, isSuperAdmin);
      return;
    }
    if (commandText.startsWith(MEMORY_PREFIX)) {
      await this.handleMemoryCommand(userConfig);
      return;
    }
    if (commandText.startsWith(PROFILE_PREFIX)) {
      await this.handleProfileCommand(userConfig);
      return;
    }
    if (commandText.startsWith(REMINDER_PREFIX)) {
      await this.handleReminderCommand(userConfig, commandText);
      return;
    }
    if (DIGEST_PREFIXES.some((prefix) => commandText === prefix || commandText.startsWith(`${prefix} `))) {
      await this.handleDigestCommand(userConfig);
      return;
    }
    if (HOLIDAY_PREFIXES.some((prefix) => commandText === prefix || commandText.startsWith(`${prefix} `))) {
      await this.handleHolidayCommand(userConfig);
      return;
    }
    if (commandText.startsWith(VOICE_PREFIX)) {
      await this.handleVoiceCommand(userConfig, commandText.slice(VOICE_PREFIX.length).trim(), []);
      return;
    }
    if (isSuperAdmin && commandText.startsWith(STATUS_PREFIX)) {
      await this.handleStatusCommand(userId);
      return;
    }
    if (isSuperAdmin && commandText.startsWith(HEALTH_PREFIX)) {
      await this.handleHealthCommand(userId);
      return;
    }
    if (isSuperAdmin && commandText.startsWith(SERVER_PREFIX)) {
      await this.handleServerCommand(userId);
      return;
    }

    const parsed = parsePrivateMessage(event.message);
    if (!parsed.text && parsed.images.length === 0) return;
    if (userConfig.autoReplyEnabled === false) {
      logInfo("Ignored private message because auto reply is disabled.", { userId });
      return;
    }
    await this.handleConversation(userConfig, parsed.text, parsed.images);
  }

  async getPublicTransportHealthStatus(): Promise<TransportHealthStatus> {
    return this.transport.getHealthStatus?.() ?? { ok: true, detail: "transport health is not available" };
  }

  async getSystemHealthStatus(options: { refreshModels?: boolean } = {}): Promise<SystemHealthStatus> {
    const replyModelHealth = this.aiService.checkHealth
      ? [await this.aiService.checkHealth({ refresh: options.refreshModels })]
      : [];
    const memoryModelHealth = this.memoryAiService.checkHealth
      ? [await this.memoryAiService.checkHealth({ refresh: options.refreshModels })]
      : [];
    return {
      transport: await this.getPublicTransportHealthStatus(),
      models: [
        ...replyModelHealth,
        ...memoryModelHealth,
      ],
      runtime: buildRuntimeHealth(),
    };
  }

  private async handleConversation(userConfig: PrivateBotConfig, userInput: string, images: MessageImageInput[]): Promise<void> {
    const skill = await this.resolveSkill(userConfig);
    const [history, memories, knowledgeHits] = await Promise.all([
      this.conversationStore.getTurns(userConfig.userId),
      userConfig.memoryEnabled === false ? Promise.resolve([]) : this.personalMemoryStore.list(userConfig.userId),
      userConfig.knowledgeEnabled === false ? Promise.resolve([]) : this.personalKnowledgeStore.search(userConfig.userId, userInput),
    ]);
    const reply = await this.selectReplyAiService(userConfig).generateReply({
      userId: userConfig.userId,
      skill,
      history,
      userInput,
      images,
      memories,
      knowledgeHits,
    });
    await this.transport.sendPrivateMessage(userConfig.userId, reply.text);
    await this.conversationStore.appendDialogue(userConfig.userId, [
      { userId: userConfig.userId, role: "user", content: userInput || "[image]", timestamp: new Date().toISOString() },
      { userId: userConfig.userId, role: "assistant", content: reply.text, timestamp: new Date().toISOString() },
    ], skill.maxContextTurns * 2);
    if (userConfig.memoryEnabled !== false && userInput.trim()) {
      this.personalMemoryCandidateService.queueMessage({
        userId: userConfig.userId,
        text: userInput,
        timestamp: new Date().toISOString(),
      });
    }
    logInfo("Sent private AI reply.", { userId: userConfig.userId, skillId: skill.id, model: reply.model });
  }

  private async handleSkillCommand(userConfig: PrivateBotConfig, text: string): Promise<void> {
    const suffix = text.slice(SKILL_PREFIX.length).trim();
    const allowedSkills = (await this.skillService.getAllSkills()).filter((skill) => userConfig.allowedSkillIds.includes(skill.id));
    if (!suffix || suffix === "列表" || suffix === "状态") {
      const lines = allowedSkills.map((skill) => `${skill.id}${skill.id === userConfig.currentSkillId ? " (当前)" : ""} - ${skill.name}`);
      await this.transport.sendPrivateMessage(userConfig.userId, lines.length ? `可用技能：\n${lines.join("\n")}` : "当前没有可用技能。");
      return;
    }
    const match = suffix.match(/^(?:切换|使用)\s+(\S+)/);
    const skillId = match?.[1]?.trim();
    if (!skillId || !userConfig.allowedSkillIds.includes(skillId)) {
      await this.transport.sendPrivateMessage(userConfig.userId, "格式：#技能 切换 <skillId>。只能切换到允许列表里的技能。");
      return;
    }
    const skill = await this.skillService.getSkill(skillId);
    if (!skill) {
      await this.transport.sendPrivateMessage(userConfig.userId, `没有找到技能：${skillId}`);
      return;
    }
    await this.userConfigService.updateUser(userConfig.userId, { currentSkillId: skillId });
    await this.conversationStore.clearUser(userConfig.userId);
    await this.transport.sendPrivateMessage(userConfig.userId, `已切换技能：${skill.name}，并清空当前上下文。`);
  }

  private async handleModelCommand(userConfig: PrivateBotConfig, text: string): Promise<void> {
    const suffix = text.slice(MODEL_PREFIX.length).trim();
    if (!suffix || suffix === "状态") {
      const health = await this.getSystemHealthStatus();
      await this.transport.sendPrivateMessage(userConfig.userId, [
        `当前模型模式：${userConfig.replyModelMode ?? "default"}`,
        ...health.models.map((model) => `${model.model}：${model.ok ? "正常" : "异常"}${model.cached ? "（缓存）" : ""}`),
      ].join("\n"));
      return;
    }
    const match = suffix.match(/^(?:切换|使用)\s+(\S+)/);
    if (!match?.[1]) {
      await this.transport.sendPrivateMessage(userConfig.userId, "格式：#模型 切换 <mode>");
      return;
    }
    await this.userConfigService.updateUser(userConfig.userId, { replyModelMode: match[1] });
    await this.transport.sendPrivateMessage(userConfig.userId, `已切换模型模式：${match[1]}`);
  }

  private async handleConversationCommand(userConfig: PrivateBotConfig, text: string, isSuperAdmin: boolean): Promise<void> {
    const target = text.match(/^#对话\s+清空\s+(\d+)$/)?.[1];
    if (target && isSuperAdmin) {
      await this.conversationStore.clearUser(target);
      await this.transport.sendPrivateMessage(userConfig.userId, `已清空 ${target} 的上下文。`);
      return;
    }
    await this.conversationStore.clearUser(userConfig.userId);
    await this.transport.sendPrivateMessage(userConfig.userId, "已清空你的私聊上下文。");
  }

  private async handleMemoryCommand(userConfig: PrivateBotConfig): Promise<void> {
    const [memories, candidates] = await Promise.all([
      this.personalMemoryStore.list(userConfig.userId),
      this.personalMemoryCandidateService.list({ userId: userConfig.userId, status: "pending" }),
    ]);
    await this.transport.sendPrivateMessage(
      userConfig.userId,
      `个人记忆状态：已入库 ${memories.filter((item) => item.enabled).length} 条，待审核 ${candidates.length} 条。`,
    );
  }

  private async handleProfileCommand(userConfig: PrivateBotConfig): Promise<void> {
    const memories = await this.personalMemoryStore.list(userConfig.userId);
    const profile = await this.memoryAiService.summarizePersonalProfile({ userId: userConfig.userId, memories });
    await this.transport.sendPrivateMessage(userConfig.userId, profile);
  }

  private async handleDigestCommand(userConfig: PrivateBotConfig): Promise<void> {
    const todayKey = toLocalDateKey(new Date());
    const turns = (await this.conversationStore.getTurns(userConfig.userId))
      .filter((turn) => toLocalDateKey(new Date(turn.timestamp)) === todayKey);
    if (!turns.length) {
      await this.transport.sendPrivateMessage(userConfig.userId, "今天还没有可总结的私聊记录。");
      return;
    }
    const userTurns = turns.filter((turn) => turn.role === "user");
    const assistantTurns = turns.filter((turn) => turn.role === "assistant");
    const highlights = userTurns.slice(-5).map((turn) => `- ${turn.content}`).join("\n");
    await this.transport.sendPrivateMessage(userConfig.userId, [
      `今天的个人日记摘要：你发了 ${userTurns.length} 条消息，我回复了 ${assistantTurns.length} 次。`,
      highlights ? `最近重点：\n${highlights}` : "",
    ].filter(Boolean).join("\n"));
  }

  private async handleHolidayCommand(userConfig: PrivateBotConfig): Promise<void> {
    await this.transport.sendPrivateMessage(userConfig.userId, buildHolidayCountdownMessage());
  }

  private async handleVoiceCommand(userConfig: PrivateBotConfig, input: string, images: MessageImageInput[]): Promise<void> {
    if (!input) {
      await this.transport.sendPrivateMessage(userConfig.userId, "格式：#语音 <内容>");
      return;
    }
    try {
      const skill = await this.resolveSkill(userConfig);
      const reply = await this.selectReplyAiService(userConfig).generateReply({
        userId: userConfig.userId,
        skill,
        history: await this.conversationStore.getTurns(userConfig.userId),
        userInput: input,
        images,
        memories: await this.personalMemoryStore.list(userConfig.userId),
      });
      const file = await this.ttsService.synthesize(reply.text);
      await this.transport.sendPrivateRecord(userConfig.userId, file);
    } catch (error) {
      logError("Private voice reply failed.", { userId: userConfig.userId, error: (error as Error).message });
      await this.transport.sendPrivateMessage(userConfig.userId, "语音发送失败，我先用文字回复你。");
      await this.handleConversation(userConfig, input, images);
    }
  }

  private async handleReminderCommand(userConfig: PrivateBotConfig, text: string): Promise<void> {
    const suffix = text.slice(REMINDER_PREFIX.length).trim();
    if (!suffix || suffix === "列表" || suffix === "状态") {
      const tasks = await this.personalReminderService.listUserTasks(userConfig.userId);
      const lines = tasks.map((task) => this.personalReminderService.formatTask(task));
      await this.transport.sendPrivateMessage(userConfig.userId, lines.length ? `你的定时任务：\n${lines.join("\n")}` : "你还没有定时任务。");
      return;
    }
    const deleteMatch = suffix.match(/^删除\s+(\S+)/);
    if (deleteMatch?.[1]) {
      const removed = await this.personalReminderService.removeUserTask(userConfig.userId, deleteMatch[1]);
      await this.transport.sendPrivateMessage(userConfig.userId, removed ? "已删除定时任务。" : "没有找到这个定时任务。");
      return;
    }
    const enableMatch = suffix.match(/^(开启|启用|关闭|暂停)\s+(\S+)/);
    if (enableMatch?.[1] && enableMatch[2]) {
      const task = await this.personalReminderService.setUserTaskEnabled(userConfig.userId, enableMatch[2], ["开启", "启用"].includes(enableMatch[1]));
      await this.transport.sendPrivateMessage(userConfig.userId, task ? `已${task.enabled ? "启用" : "暂停"}定时任务。` : "没有找到这个定时任务。");
      return;
    }
    const request = this.personalReminderService.parseCreateRequest(text);
    if (!request) {
      await this.transport.sendPrivateMessage(userConfig.userId, "格式：#定时任务 添加 每30分钟提醒我喝水");
      return;
    }
    const task = await this.personalReminderService.createTask({
      userId: userConfig.userId,
      creatorUserId: userConfig.userId,
      request,
    });
    await this.transport.sendPrivateMessage(userConfig.userId, `已创建定时任务 ${task.id}：${this.personalReminderService.formatTask(task)}`);
  }

  private async handleUserCommand(actorUserId: string, text: string): Promise<void> {
    const suffix = text.slice(USER_PREFIX.length).trim();
    const match = suffix.match(/^(邀请|禁用|启用|移除)\s+(\d+)$/);
    if (suffix === "列表") {
      const users = await this.userConfigService.listUsers();
      await this.transport.sendPrivateMessage(actorUserId, users.length ? users.map((user) => `${user.userId} ${user.enabled === false ? "禁用" : "启用"} ${user.displayName ?? ""}`).join("\n") : "暂无用户。");
      return;
    }
    if (!match) {
      await this.transport.sendPrivateMessage(actorUserId, "格式：#用户 邀请|禁用|启用|移除 <QQ号>，或 #用户 列表");
      return;
    }
    const [, action, targetUserId] = match;
    if (!targetUserId) return;
    if (action === "邀请") {
      await this.userConfigService.inviteUser(targetUserId);
    } else if (action === "禁用") {
      await this.userConfigService.updateUser(targetUserId, { enabled: false });
    } else if (action === "启用") {
      await this.userConfigService.updateUser(targetUserId, { enabled: true });
    } else if (action === "移除") {
      await this.userConfigService.removeUser(targetUserId);
    }
    await this.adminOperationLogService.record({ actorUserId, action: `user_${action}`, targetUserId });
    await this.transport.sendPrivateMessage(actorUserId, `已执行：${action} ${targetUserId}`);
  }

  private async handleStatusCommand(userId: string): Promise<void> {
    const [users, memories, candidates] = await Promise.all([
      this.userConfigService.listUsers(),
      this.personalMemoryStore.list(),
      this.personalMemoryCandidateService.list({ status: "pending" }),
    ]);
    await this.transport.sendPrivateMessage(userId, [
      "XBot 状态",
      `用户：${users.length}`,
      `长期记忆：${memories.length}`,
      `待审核记忆：${candidates.length}`,
    ].join("\n"));
  }

  private async handleHealthCommand(userId: string): Promise<void> {
    const health = await this.getSystemHealthStatus({ refreshModels: true });
    await this.transport.sendPrivateMessage(userId, [
      `NapCat：${health.transport.ok ? "正常" : "异常"}，${health.transport.detail}`,
      ...health.models.map((model) => `模型 ${model.model}：${model.ok ? "正常" : "异常"}，${model.latencyMs}ms，${model.detail}`),
    ].join("\n"));
  }

  private async handleServerCommand(userId: string): Promise<void> {
    const runtime = buildRuntimeHealth();
    await this.transport.sendPrivateMessage(userId, [
      "服务器状态：",
      `Hostname: ${runtime.hostname}`,
      `Node: ${runtime.nodeVersion}`,
      `PID: ${runtime.pid}`,
      `Uptime: ${runtime.uptimeSeconds}s`,
      `RSS: ${runtime.rssMb} MB`,
      `Heap: ${runtime.heapUsedMb} MB`,
      `CWD: ${runtime.cwd}`,
    ].join("\n"));
  }

  private async sendHelp(userId: string, isSuperAdmin: boolean): Promise<void> {
    const lines = [
      "#技能 列表 / #技能 切换 <skillId>",
      "#模型 状态 / #模型 切换 <mode>",
      "#对话 清空",
      "#记忆 状态",
      "#画像",
      "#日记",
      "#节假日",
      "#语音 <内容>",
      "#定时任务 添加 每30分钟提醒我喝水",
      "#定时任务 列表 / #定时任务 删除 <taskId>",
    ];
    if (isSuperAdmin) {
      lines.push("#用户 邀请 <QQ号>", "#用户 禁用 <QQ号>", "#用户 列表", "#状态", "#健康", "#服务器");
    }
    await this.transport.sendPrivateMessage(userId, `XBot 私聊命令：\n${lines.join("\n")}`);
  }

  private async runReminderTick(): Promise<void> {
    if (this.reminderTickRunning) return;
    this.reminderTickRunning = true;
    try {
      const dueTasks = await this.personalReminderService.getDueTasks(new Date());
      for (const task of dueTasks) {
        const userConfig = await this.userConfigService.getUser(task.userId);
        if (!userConfig || userConfig.enabled === false || userConfig.scheduledRemindersEnabled === false) continue;
        const message = this.personalReminderService.buildReminderMessage(task);
        await this.transport.sendPrivateMessage(task.userId, message);
        await this.personalReminderService.markSent(task.id, message);
      }
    } catch (error) {
      logError("Reminder tick failed.", { error: (error as Error).message });
    } finally {
      this.reminderTickRunning = false;
    }
  }

  private async runMemoryFlushTick(): Promise<void> {
    if (this.memoryFlushTickRunning) return;
    this.memoryFlushTickRunning = true;
    try {
      await this.personalMemoryCandidateService.flushAll();
    } catch (error) {
      logError("Memory flush tick failed.", { error: (error as Error).message });
    } finally {
      this.memoryFlushTickRunning = false;
    }
  }

  private async resolveSkill(userConfig: PrivateBotConfig) {
    const skill = await this.skillService.getSkill(userConfig.currentSkillId);
    if (skill) return skill;
    const fallback = (await this.skillService.getAllSkills())[0];
    if (!fallback) throw new Error("No skills configured.");
    return fallback;
  }

  private selectReplyAiService(userConfig: PrivateBotConfig): ReplyAiService {
    const mode = (userConfig.replyModelMode ?? "default").toLowerCase();
    if (["memory", "mimo", "profile"].includes(mode) && this.memoryAiService.generateReply) {
      return this.memoryAiService as ReplyAiService;
    }
    return this.aiService;
  }
}

function buildRuntimeHealth() {
  return {
    hostname: os.hostname(),
    nodeVersion: process.version,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    cwd: process.cwd(),
  };
}

function toLocalDateKey(date: Date): string {
  return [
    date.getFullYear(),
    `${date.getMonth() + 1}`.padStart(2, "0"),
    `${date.getDate()}`.padStart(2, "0"),
  ].join("-");
}
