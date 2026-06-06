import { createHmac, randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";

import type { BotApplication } from "./bot.js";
import type { AdminOperationLogEntry, AdminOperationLogService } from "./services/admin-operation-log-service.js";
import type { PersonalKnowledgeStore } from "./services/personal-knowledge-store.js";
import type { PersonalMemoryCandidateService } from "./services/personal-memory-candidate-service.js";
import type { PersonalMemoryStore } from "./services/personal-memory-store.js";
import type { PersonalReminderService, ReminderCreateRequest } from "./services/personal-reminder-service.js";
import type { SkillService } from "./services/skill-service.js";
import type { SystemSettingsStore } from "./services/system-settings-store.js";
import type { UserConfigService } from "./services/user-config-service.js";
import type {
  PersonalKnowledgeEntry,
  PersonalMemory,
  PersonalMemoryCandidate,
  PersonalReminderTask,
  PrivateBotConfig,
  SystemCommandConfig,
  SystemHealthStatus,
  SystemModelConfig,
  SystemModelPurpose,
  SystemSettings,
} from "./types.js";

interface AdminHttpServerOptions {
  host: string;
  port: number;
  publicBaseUrl: string;
  username: string;
  password: string;
  sessionSecret: string;
  userConfigService: UserConfigService;
  skillService: SkillService;
  personalMemoryStore: PersonalMemoryStore;
  personalMemoryCandidateService: PersonalMemoryCandidateService;
  personalKnowledgeStore: PersonalKnowledgeStore;
  personalReminderService: PersonalReminderService;
  adminOperationLogService: AdminOperationLogService;
  systemSettingsStore: SystemSettingsStore;
  app: BotApplication;
}

type Pagination = { page: number; pageSize: number; total: number; totalPages: number };
type MemoryType = "member_profile" | "group_fact";
type ProfileRecordType = "overall" | "yesterday";
type AdminTaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
type AdminTaskType = "memory-dedup" | "profile-generate" | "model-check" | "bulk-review";

interface ProfileRecord {
  id: string;
  groupId: string;
  userId: string;
  type: ProfileRecordType;
  summary: string;
  shareToken?: string;
  shareUrl?: string;
  publicEnabled?: boolean;
  expiresAt?: string;
  accessCount?: number;
  revokedAt?: string;
  sourceMemoryCount: number;
  generatedAt: string;
  createdAt: string;
  createdBy: string;
}

interface ProfileRecordsFile {
  records: ProfileRecord[];
}

interface AdminTaskRecord {
  id: string;
  type: AdminTaskType;
  status: AdminTaskStatus;
  title: string;
  groupId?: string;
  subjectUserId?: string;
  operatorUserId: string;
  progress: number;
  detail?: string;
  error?: string;
  result?: unknown;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}

const profileRecordsPath = () => path.join(process.cwd(), "data", "profile-records.json");
const adminTasksPath = () => path.join(process.cwd(), "data", "admin-tasks.json");

export class AdminHttpServer {
  private readonly sessions = new Map<string, { username: string; expiresAt: number }>();

  private readonly server = createServer((req, res) => {
    void this.handle(req, res).catch((error) => {
      this.sendJson(res, { error: (error as Error).message }, 500);
    });
  });

  constructor(private readonly options: AdminHttpServerOptions) {}

  start(): void {
    this.server.listen(this.options.port, this.options.host, () => {
      console.log(JSON.stringify({
        level: "info",
        message: "XBot admin HTTP server listening.",
        details: { host: this.options.host, port: this.options.port, publicBaseUrl: this.options.publicBaseUrl },
      }));
    });
  }

  close(): void {
    this.server.close();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = trimTrailingSlash(url.pathname);
    if (pathname.startsWith("/api/")) {
      if (pathname === "/api/login" || pathname === "/api/logout" || pathname === "/api/session") {
        await this.handleAuthApi(req, res, pathname);
        return;
      }
      if (!this.isAuthorized(req).ok) {
        this.sendJson(res, { error: "unauthorized" }, 401);
        return;
      }
      await this.handleApi(req, res, pathname, url);
      return;
    }
    if (req.method === "GET" && pathname.startsWith("/profile/")) {
      await this.handlePublicProfile(res, pathname.slice("/profile/".length));
      return;
    }
    await this.serveStatic(res, pathname);
  }

  private async handleAuthApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const method = req.method ?? "GET";
    if (method === "POST" && pathname === "/api/login") {
      const body = await readBody(req);
      const username = typeof body.username === "string" ? body.username.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (username !== this.options.username || password !== this.options.password) {
        this.sendJson(res, { error: "invalid_credentials" }, 401);
        return;
      }
      const token = this.createSession(username);
      res.setHeader("Set-Cookie", buildSessionCookie(token, req, 7 * 24 * 60 * 60));
      this.sendJson(res, { ok: true, username, role: "super_admin", allowedGroupIds: [], publicBaseUrl: this.options.publicBaseUrl });
      return;
    }
    if (method === "POST" && pathname === "/api/logout") {
      const token = this.getSessionToken(req);
      if (token) this.sessions.delete(hashToken(token, this.options.sessionSecret));
      res.setHeader("Set-Cookie", buildSessionCookie("", req, 0));
      this.sendJson(res, { ok: true });
      return;
    }
    if (method === "GET" && pathname === "/api/session") {
      const auth = this.isAuthorized(req);
      if (!auth.ok) {
        this.sendJson(res, { authenticated: false, role: "super_admin", username: "", allowedGroupIds: [], publicBaseUrl: this.options.publicBaseUrl });
        return;
      }
      this.sendJson(res, { authenticated: true, role: "super_admin", username: auth.username, allowedGroupIds: [], publicBaseUrl: this.options.publicBaseUrl });
      return;
    }
    this.sendJson(res, { error: "not_found" }, 404);
  }

  private async handleApi(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
    const method = req.method ?? "GET";

    if (method === "GET" && pathname === "/api/overview") {
      await this.handleOverview(res, url);
      return;
    }
    if (method === "GET" && pathname === "/api/notifications") {
      const candidates = await this.options.personalMemoryCandidateService.list({ status: "pending" });
      this.sendJson(res, { pendingCandidateCount: candidates.length, latestCandidates: candidates.slice(-5).reverse().map(mapCandidate) });
      return;
    }
    if (method === "GET" && pathname === "/api/search") {
      await this.handleSearch(res, url);
      return;
    }

    if (pathname === "/api/users" || pathname.startsWith("/api/users/")) {
      await this.handleUsers(req, res, pathname);
      return;
    }
    if (pathname === "/api/groups" || pathname === "/api/groups/sync" || pathname.startsWith("/api/groups/")) {
      await this.handleGroupCompat(req, res, pathname, url);
      return;
    }
    if (pathname === "/api/memories" || pathname.startsWith("/api/memories/")) {
      await this.handleMemories(req, res, pathname, url);
      return;
    }
    if (pathname === "/api/memory-candidates" || pathname.startsWith("/api/memory-candidates/")) {
      await this.handleMemoryCandidates(req, res, pathname, url);
      return;
    }
    if (pathname === "/api/knowledge" || pathname.startsWith("/api/knowledge/")) {
      await this.handleKnowledge(req, res, pathname, url);
      return;
    }
    if (pathname === "/api/profile-records" || pathname.startsWith("/api/profile-records/")) {
      await this.handleProfileRecords(req, res, pathname, url);
      return;
    }
    if (pathname === "/api/tasks" || pathname.startsWith("/api/tasks/")) {
      await this.handleTasks(req, res, pathname, url);
      return;
    }
    if (pathname === "/api/skills" || pathname.startsWith("/api/skills/")) {
      await this.handleSkills(req, res, pathname, url);
      return;
    }
    if (pathname === "/api/system-settings" || pathname.startsWith("/api/system-settings/")) {
      await this.handleSystemSettings(req, res, pathname);
      return;
    }
    if (pathname === "/api/commands") {
      await this.handleCommands(req, res);
      return;
    }
    if (pathname === "/api/model-options") {
      const settings = await this.options.systemSettingsStore.get();
      this.sendJson(res, { replyModels: settings.models.map(mapModelOption) });
      return;
    }
    if (pathname === "/api/skill-options") {
      const skills = await this.options.skillService.getAllSkills();
      this.sendJson(res, { skills: skills.map((skill) => ({ id: skill.id, name: skill.name })) });
      return;
    }
    if (pathname === "/api/health") {
      await this.handleHealth(res, url.searchParams.get("refresh") === "1");
      return;
    }
    if (pathname === "/api/model-health-history") {
      const health = await this.getModelStatuses(false);
      this.sendJson(res, { models: health.map((model) => ({ ...model, source: "runtime" })) });
      return;
    }
    if (pathname === "/api/logs") {
      const logs = await this.options.adminOperationLogService.list(200);
      const mapped = logs.map(mapOperationLog);
      this.sendJson(res, pageItems(filterByQuery(mapped, url.searchParams.get("q"), (item) => `${item.action} ${item.operatorUserId} ${item.target ?? ""}`), url, "entries"));
      return;
    }
    const modelTest = pathname.match(/^\/api\/models\/([^/]+)\/test$/);
    if (modelTest && method === "POST") {
      const status = (await this.getModelStatuses(true)).find((model) => model.id === decodeURIComponent(modelTest[1]!));
      this.sendJson(res, status ? { ok: status.ok, detail: status.detail, latencyMs: status.latencyMs } : { ok: false, detail: "model_not_found" }, status ? 200 : 404);
      return;
    }

    this.sendJson(res, { error: "not_found" }, 404);
  }

  private async handleOverview(res: ServerResponse, url: URL): Promise<void> {
    const groupId = url.searchParams.get("groupId") ?? undefined;
    const users = await this.options.userConfigService.listUsers();
    const userIds = new Set(users.map((user) => user.userId));
    const memories = (await this.options.personalMemoryStore.list(groupId)).filter((item) => !groupId || item.userId === groupId);
    const candidates = (await this.options.personalMemoryCandidateService.list({ userId: groupId, status: "pending" }));
    const knowledge = await this.options.personalKnowledgeStore.list(groupId);
    const health = await this.options.app.getSystemHealthStatus();
    const modelStatuses = await this.getModelStatuses(false);
    this.sendJson(res, {
      groups: users.map(mapUserToGroup),
      groupId,
      stats: {
        groupCount: users.length,
        memoryCount: groupId ? memories.length : memories.filter((item) => userIds.has(item.userId)).length,
        pendingCandidateCount: candidates.length,
        knowledgeCount: knowledge.length,
      },
      recent: {
        candidates: candidates.slice(-10).reverse().map(mapCandidate),
        memories: memories.slice(-10).reverse().map(mapMemory),
        knowledge: knowledge.slice(-10).reverse().map(mapKnowledge),
      },
      transportHealth: health.transport,
      profileAiHealth: modelStatuses.find((item) => item.purpose === "memory") ?? firstModelHealth(health),
      modelStatuses,
      abnormalModelStatuses: modelStatuses.filter((item) => !item.ok),
      modelStatusSummary: {
        total: modelStatuses.length,
        abnormal: modelStatuses.filter((item) => !item.ok).length,
        checkedAt: new Date().toISOString(),
      },
    });
  }

  private async handleUsers(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const method = req.method ?? "GET";
    if (method === "GET" && pathname === "/api/users") {
      this.sendJson(res, { users: await this.options.userConfigService.listUsers() });
      return;
    }
    if (method === "POST" && pathname === "/api/users") {
      const body = await readBody(req);
      const user = await this.options.userConfigService.inviteUser(requiredString(body.userId), body);
      await this.options.adminOperationLogService.record({ actorUserId: "admin-http", action: "user_invite", targetUserId: user.userId });
      this.sendJson(res, { user });
      return;
    }
    const route = pathname.match(/^\/api\/users\/([^/]+)$/);
    if (route && (method === "PATCH" || method === "PUT")) {
      const user = await this.options.userConfigService.updateUser(decodeURIComponent(route[1]!), await readBody(req));
      if (!user) this.sendJson(res, { error: "not_found" }, 404);
      else this.sendJson(res, { user });
      return;
    }
    if (route && method === "DELETE") {
      this.sendJson(res, { removed: await this.options.userConfigService.removeUser(decodeURIComponent(route[1]!)) });
      return;
    }
    this.sendJson(res, { error: "not_found" }, 404);
  }

  private async handleGroupCompat(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    if (method === "GET" && pathname === "/api/groups") {
      const users = await this.options.userConfigService.listUsers();
      const groups = users.map(mapUserToGroup).filter((group) => url.searchParams.get("includeDisabled") === "1" || group.enabled !== false);
      this.sendJson(res, { groups });
      return;
    }
    if (method === "POST" && pathname === "/api/groups/sync") {
      const groups = (await this.options.userConfigService.listUsers()).map(mapUserToGroup);
      this.sendJson(res, { syncedCount: groups.length, groups });
      return;
    }
    const configRoute = pathname.match(/^\/api\/groups\/([^/]+)\/config$/);
    if (configRoute) {
      const userId = decodeURIComponent(configRoute[1]!);
      if (method === "GET") {
        const user = await this.options.userConfigService.getUser(userId);
        if (!user) this.sendJson(res, { error: "not_found" }, 404);
        else this.sendJson(res, mapUserToGroup(user));
        return;
      }
      if (method === "PUT" || method === "PATCH") {
        const body = await readBody(req);
        const user = await this.options.userConfigService.updateUser(userId, mapGroupPatchToUserPatch(body));
        if (!user) this.sendJson(res, { error: "not_found" }, 404);
        else this.sendJson(res, mapUserToGroup(user));
        return;
      }
    }
    const membersRoute = pathname.match(/^\/api\/groups\/([^/]+)\/members$/);
    if (membersRoute && method === "GET") {
      const userId = decodeURIComponent(membersRoute[1]!);
      const member = await this.buildMemberProfile(userId);
      const items = member ? [member] : [];
      this.sendJson(res, pageArray(items, url, "members"));
      return;
    }
    const identityRoute = pathname.match(/^\/api\/groups\/([^/]+)\/members\/([^/]+)\/identity$/);
    if (identityRoute && (method === "PUT" || method === "PATCH")) {
      const targetUserId = decodeURIComponent(identityRoute[2]!);
      const body = await readBody(req);
      const names = Array.isArray(body.names) ? body.names.map(String).filter(Boolean) : [];
      const user = await this.options.userConfigService.updateUser(targetUserId, { displayName: names[0] || targetUserId });
      this.sendJson(res, { member: user ? await this.buildMemberProfile(targetUserId) : undefined });
      return;
    }
    const summaryRoute = pathname.match(/^\/api\/groups\/([^/]+)\/members\/([^/]+)\/profile-summary$/);
    if (summaryRoute && method === "GET") {
      const userId = decodeURIComponent(summaryRoute[2]!);
      const type = normalizeProfileType(url.searchParams.get("type"));
      this.sendJson(res, await this.getOrCreateProfileSummary(userId, type, false));
      return;
    }
    const remindersRoute = pathname.match(/^\/api\/groups\/([^/]+)\/reminders(?:\/([^/]+))?$/);
    if (remindersRoute) {
      await this.handleGroupReminders(req, res, decodeURIComponent(remindersRoute[1]!), remindersRoute[2] ? decodeURIComponent(remindersRoute[2]) : undefined);
      return;
    }
    const scheduleRoute = pathname.match(/^\/api\/groups\/([^/]+)\/schedule-preview$/);
    if (scheduleRoute && method === "GET") {
      const userId = decodeURIComponent(scheduleRoute[1]!);
      const days = Math.max(1, Math.min(31, Number(url.searchParams.get("days") ?? 7)));
      const tasks = await this.options.personalReminderService.listUserTasks(userId);
      this.sendJson(res, { previews: buildSchedulePreview(tasks, days) });
      return;
    }
    this.sendJson(res, { error: "not_found" }, 404);
  }

  private async handleGroupReminders(req: IncomingMessage, res: ServerResponse, userId: string, taskId?: string): Promise<void> {
    const method = req.method ?? "GET";
    if (method === "GET" && !taskId) {
      this.sendJson(res, { reminders: (await this.options.personalReminderService.listUserTasks(userId)).map(mapReminder) });
      return;
    }
    if (method === "POST" && !taskId) {
      const body = await readBody(req);
      const task = await this.options.personalReminderService.createTask({
        userId,
        creatorUserId: "admin-http",
        request: mapReminderRequest(body),
      });
      await this.recordTask("profile-generate", "创建个人定时任务", userId, task.id, { topic: task.topic });
      this.sendJson(res, mapReminder(task));
      return;
    }
    if ((method === "PUT" || method === "PATCH") && taskId) {
      const task = await this.options.personalReminderService.updateUserTask(userId, taskId, await readBody(req) as Partial<PersonalReminderTask>);
      if (!task) this.sendJson(res, { error: "not_found" }, 404);
      else this.sendJson(res, mapReminder(task));
      return;
    }
    if (method === "DELETE" && taskId) {
      this.sendJson(res, { removed: await this.options.personalReminderService.removeUserTask(userId, taskId) });
      return;
    }
    this.sendJson(res, { error: "not_found" }, 404);
  }

  private async handleMemories(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    if (pathname === "/api/memories" && method === "GET") {
      const groupId = url.searchParams.get("groupId") ?? undefined;
      const subjectUserId = url.searchParams.get("subjectUserId") ?? url.searchParams.get("userId") ?? undefined;
      let memories = (await this.options.personalMemoryStore.list(subjectUserId || groupId)).map(mapMemory);
      memories = filterMemories(memories, url);
      this.sendJson(res, pageArray(memories, url, "memories"));
      return;
    }
    if (pathname === "/api/memories" && method === "POST") {
      const memory = await this.options.personalMemoryStore.create(mapMemoryInput(await readBody(req)));
      this.sendJson(res, mapMemory(memory));
      return;
    }
    if (pathname === "/api/memories/bulk" && method === "POST") {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      let processedCount = 0;
      for (const id of ids) {
        if (body.action === "delete") {
          if (await this.options.personalMemoryStore.remove(id)) processedCount += 1;
        } else {
          if (await this.options.personalMemoryStore.update(id, { enabled: false })) processedCount += 1;
        }
      }
      this.sendJson(res, { processedCount, skippedCount: ids.length - processedCount });
      return;
    }
    if (pathname === "/api/memories/deduplicate/preview" && method === "POST") {
      const body = await readBody(req);
      const userId = typeof body.subjectUserId === "string" ? body.subjectUserId : undefined;
      const memories = await this.options.personalMemoryStore.list(userId);
      this.sendJson(res, { decisions: findDuplicateMemoryDecisions(memories) });
      return;
    }
    if (pathname === "/api/memories/deduplicate/apply" && method === "POST") {
      const body = await readBody(req);
      const decisions = Array.isArray(body.decisions) ? body.decisions as Array<{ duplicateId?: string }> : [];
      let appliedCount = 0;
      for (const decision of decisions) {
        if (decision.duplicateId && await this.options.personalMemoryStore.update(decision.duplicateId, { enabled: false })) {
          appliedCount += 1;
        }
      }
      this.sendJson(res, { appliedCount, skippedCount: decisions.length - appliedCount });
      return;
    }
    const route = pathname.match(/^\/api\/memories\/([^/]+)$/);
    if (route && method === "GET") {
      const memory = (await this.options.personalMemoryStore.list()).find((item) => item.id === decodeURIComponent(route[1]!));
      if (!memory) this.sendJson(res, { error: "not_found" }, 404);
      else this.sendJson(res, mapMemory(memory));
      return;
    }
    if (route && (method === "PUT" || method === "PATCH")) {
      const memory = await this.options.personalMemoryStore.update(decodeURIComponent(route[1]!), mapMemoryPatch(await readBody(req)));
      if (!memory) this.sendJson(res, { error: "not_found" }, 404);
      else this.sendJson(res, mapMemory(memory));
      return;
    }
    if (route && method === "DELETE") {
      this.sendJson(res, { removed: await this.options.personalMemoryStore.remove(decodeURIComponent(route[1]!)) });
      return;
    }
    this.sendJson(res, { error: "not_found" }, 404);
  }

  private async handleMemoryCandidates(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    if (pathname === "/api/memory-candidates" && method === "GET") {
      const userId = url.searchParams.get("subjectUserId") ?? url.searchParams.get("userId") ?? url.searchParams.get("groupId") ?? undefined;
      const status = normalizeCandidateStatus(url.searchParams.get("status"));
      let candidates = (await this.options.personalMemoryCandidateService.list({ userId, status })).map(mapCandidate);
      candidates = filterCandidates(candidates, url);
      const allForCounts = (await this.options.personalMemoryCandidateService.list({ userId })).map(mapCandidate);
      this.sendJson(res, {
        ...pageArray(candidates, url, "candidates"),
        statusCounts: {
          pending: allForCounts.filter((item) => item.status === "pending").length,
          approved: allForCounts.filter((item) => item.status === "approved").length,
          rejected: allForCounts.filter((item) => item.status === "rejected").length,
        },
      });
      return;
    }
    if (pathname === "/api/memory-candidates/bulk-approve" && method === "POST") {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const approved: Array<{ candidate: unknown; memory: unknown }> = [];
      const skipped: Array<{ id: string; error: string }> = [];
      for (const id of ids) {
        const candidate = await this.options.personalMemoryCandidateService.get(id);
        const result = await this.options.personalMemoryCandidateService.approve(id);
        if (candidate && result) approved.push({ candidate: mapCandidate(result), memory: { id: result.id } });
        else skipped.push({ id, error: "not_found" });
      }
      await this.recordTask("bulk-review", "批量审核个人记忆", undefined, undefined, { approvedCount: approved.length, skippedCount: skipped.length });
      this.sendJson(res, {
        approved,
        alreadyApproved: [],
        skipped,
        errors: [],
        approvedCount: approved.length,
        alreadyApprovedCount: 0,
        skippedCount: skipped.length,
        errorCount: 0,
      });
      return;
    }
    const action = pathname.match(/^\/api\/memory-candidates\/([^/]+)\/(approve|reject)$/);
    if (action && method === "POST") {
      const id = decodeURIComponent(action[1]!);
      const result = action[2] === "approve"
        ? await this.options.personalMemoryCandidateService.approve(id, mapCandidatePatch(await readBody(req)))
        : await this.options.personalMemoryCandidateService.reject(id);
      if (!result) this.sendJson(res, { error: "not_found" }, 404);
      else this.sendJson(res, mapCandidate(result));
      return;
    }
    const route = pathname.match(/^\/api\/memory-candidates\/([^/]+)$/);
    if (route && method === "GET") {
      const candidate = await this.options.personalMemoryCandidateService.get(decodeURIComponent(route[1]!));
      if (!candidate) this.sendJson(res, { error: "not_found" }, 404);
      else this.sendJson(res, mapCandidate(candidate));
      return;
    }
    if (route && (method === "PUT" || method === "PATCH")) {
      const candidate = await this.options.personalMemoryCandidateService.update(decodeURIComponent(route[1]!), mapCandidatePatch(await readBody(req)));
      if (!candidate) this.sendJson(res, { error: "not_found" }, 404);
      else this.sendJson(res, mapCandidate(candidate));
      return;
    }
    if (route && method === "DELETE") {
      this.sendJson(res, { removed: await this.options.personalMemoryCandidateService.remove(decodeURIComponent(route[1]!)) });
      return;
    }
    this.sendJson(res, { error: "not_found" }, 404);
  }

  private async handleKnowledge(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    if (pathname === "/api/knowledge/import/preview" && method === "POST") {
      const body = await readBody(req);
      const raw = typeof body.raw === "string" ? body.raw : typeof body.text === "string" ? body.text : "";
      this.sendJson(res, { candidates: parseKnowledgeImport(raw) });
      return;
    }
    if (pathname === "/api/knowledge/import/apply" && method === "POST") {
      const body = await readBody(req);
      const userId = typeof body.groupId === "string" ? body.groupId : typeof body.userId === "string" ? body.userId : "";
      const candidates = Array.isArray(body.candidates) ? body.candidates as Array<Partial<PersonalKnowledgeEntry>> : [];
      let createdCount = 0;
      for (const item of candidates) {
        if (!userId || !item.question || !item.answer) continue;
        await this.options.personalKnowledgeStore.create({
          userId,
          title: String(item.title || item.question).slice(0, 120),
          question: String(item.question),
          answer: String(item.answer),
          keywords: Array.isArray(item.keywords) ? item.keywords.map(String) : [],
          enabled: item.enabled !== false,
        });
        createdCount += 1;
      }
      this.sendJson(res, { createdCount, skippedCount: candidates.length - createdCount });
      return;
    }
    if (pathname === "/api/knowledge" && method === "GET") {
      const userId = url.searchParams.get("groupId") ?? url.searchParams.get("userId") ?? undefined;
      let entries = (await this.options.personalKnowledgeStore.list(userId)).map(mapKnowledge);
      entries = filterByQuery(entries, url.searchParams.get("q"), (item) => `${String(item.title ?? "")} ${String(item.question ?? "")} ${String(item.answer ?? "")} ${Array.isArray(item.keywords) ? item.keywords.join(" ") : ""}`);
      this.sendJson(res, pageArray(entries, url, "entries"));
      return;
    }
    if (pathname === "/api/knowledge" && method === "POST") {
      const entry = await this.options.personalKnowledgeStore.create(mapKnowledgeInput(await readBody(req)));
      this.sendJson(res, mapKnowledge(entry));
      return;
    }
    const route = pathname.match(/^\/api\/knowledge\/([^/]+)$/);
    if (route && (method === "PUT" || method === "PATCH")) {
      const entry = await this.options.personalKnowledgeStore.update(decodeURIComponent(route[1]!), mapKnowledgePatch(await readBody(req)));
      if (!entry) this.sendJson(res, { error: "not_found" }, 404);
      else this.sendJson(res, mapKnowledge(entry));
      return;
    }
    if (route && method === "DELETE") {
      this.sendJson(res, { removed: await this.options.personalKnowledgeStore.remove(decodeURIComponent(route[1]!)) });
      return;
    }
    this.sendJson(res, { error: "not_found" }, 404);
  }

  private async handleProfileRecords(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    if (pathname === "/api/profile-records" && method === "GET") {
      const data = await readProfileRecords();
      let records = data.records;
      records = filterByExact(records, "groupId", url.searchParams.get("groupId"));
      records = filterByExact(records, "userId", url.searchParams.get("userId"));
      records = filterByExact(records, "type", url.searchParams.get("type"));
      records = filterByQuery(records, url.searchParams.get("q"), (item) => `${item.userId} ${item.summary} ${item.createdBy}`);
      this.sendJson(res, pageArray(records.slice().reverse(), url, "records"));
      return;
    }
    if (pathname === "/api/profile-records" && method === "POST") {
      const body = await readBody(req);
      const userId = requiredString(body.userId);
      const type = normalizeProfileType(typeof body.type === "string" ? body.type : undefined);
      this.sendJson(res, await this.getOrCreateProfileSummary(userId, type, true));
      return;
    }
    const shareRoute = pathname.match(/^\/api\/profile-records\/([^/]+)\/share$/);
    if (shareRoute && (method === "PUT" || method === "PATCH")) {
      const data = await readProfileRecords();
      const id = decodeURIComponent(shareRoute[1]!);
      const index = data.records.findIndex((record) => record.id === id);
      if (index < 0) {
        this.sendJson(res, { error: "not_found" }, 404);
        return;
      }
      const body = await readBody(req);
      const current = data.records[index]!;
      data.records[index] = withShareUrl({
        ...current,
        publicEnabled: body.publicEnabled !== false,
        revokedAt: typeof body.revokedAt === "string" ? body.revokedAt : body.revokedAt === null ? undefined : current.revokedAt,
      }, this.options.publicBaseUrl);
      await writeProfileRecords(data);
      this.sendJson(res, data.records[index]);
      return;
    }
    const route = pathname.match(/^\/api\/profile-records\/([^/]+)$/);
    if (route && method === "GET") {
      const record = (await readProfileRecords()).records.find((item) => item.id === decodeURIComponent(route[1]!));
      if (!record) this.sendJson(res, { error: "not_found" }, 404);
      else this.sendJson(res, withShareUrl(record, this.options.publicBaseUrl));
      return;
    }
    if (route && method === "DELETE") {
      const data = await readProfileRecords();
      const id = decodeURIComponent(route[1]!);
      const before = data.records.length;
      data.records = data.records.filter((record) => record.id !== id);
      await writeProfileRecords(data);
      this.sendJson(res, { removed: data.records.length !== before });
      return;
    }
    this.sendJson(res, { error: "not_found" }, 404);
  }

  private async handleTasks(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    if (pathname === "/api/tasks" && method === "GET") {
      let tasks = await readTasks();
      tasks = filterByExact(tasks, "groupId", url.searchParams.get("groupId"));
      tasks = filterByExact(tasks, "type", url.searchParams.get("type"));
      tasks = filterByExact(tasks, "status", url.searchParams.get("status"));
      tasks = filterByQuery(tasks, url.searchParams.get("q"), (item) => `${item.title} ${item.detail ?? ""} ${item.id}`);
      this.sendJson(res, pageArray(tasks.slice().reverse(), url, "tasks"));
      return;
    }
    const route = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (route && method === "GET") {
      const task = (await readTasks()).find((item) => item.id === decodeURIComponent(route[1]!));
      if (!task) this.sendJson(res, { error: "not_found" }, 404);
      else this.sendJson(res, task);
      return;
    }
    this.sendJson(res, { error: "not_found" }, 404);
  }

  private async handleSkills(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    if (pathname === "/api/skills" && method === "GET") {
      this.sendJson(res, { skills: await this.options.skillService.getAllSkills() });
      return;
    }
    if (pathname === "/api/skills" && method === "POST") {
      this.sendJson(res, await this.options.skillService.upsertSkill(await readBody(req)));
      return;
    }
    if (pathname === "/api/skills/import" && method === "POST") {
      const body = await readBody(req);
      const raw = typeof body.raw === "string" ? JSON.parse(body.raw) as Record<string, unknown> : body;
      this.sendJson(res, await this.options.skillService.upsertSkill(raw));
      return;
    }
    if (pathname === "/api/skills/export" && method === "GET") {
      const id = url.searchParams.get("id") ?? "";
      const skill = await this.options.skillService.getSkill(id);
      if (!skill) this.sendJson(res, { error: "not_found" }, 404);
      else this.sendJson(res, { raw: JSON.stringify(skill, null, 2) });
      return;
    }
    if (pathname === "/api/skills/backup" && method === "POST") {
      const skills = await this.options.skillService.getAllSkills();
      this.sendJson(res, { backupDir: "runtime", files: skills.map((skill) => `${skill.id}.json`) });
      return;
    }
    if (pathname === "/api/skills/backups" && method === "GET") {
      this.sendJson(res, { backups: [] });
      return;
    }
    const restore = pathname.match(/^\/api\/skills\/backups\/([^/]+)\/restore$/);
    if (restore && method === "POST") {
      this.sendJson(res, { restoredCount: 0 });
      return;
    }
    const route = pathname.match(/^\/api\/skills\/([^/]+)$/);
    if (route && (method === "PUT" || method === "PATCH")) {
      this.sendJson(res, await this.options.skillService.upsertSkill({ ...await readBody(req), id: decodeURIComponent(route[1]!) }));
      return;
    }
    if (route && method === "DELETE") {
      this.sendJson(res, { removed: await this.options.skillService.removeSkill(decodeURIComponent(route[1]!)) });
      return;
    }
    this.sendJson(res, { error: "not_found" }, 404);
  }

  private async handleSystemSettings(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const method = req.method ?? "GET";
    if (pathname === "/api/system-settings" && method === "GET") {
      this.sendJson(res, await this.options.systemSettingsStore.get());
      return;
    }
    if (pathname === "/api/system-settings" && (method === "PUT" || method === "PATCH")) {
      this.sendJson(res, await this.options.systemSettingsStore.update(await readBody(req)));
      return;
    }
    if ((pathname === "/api/system-settings/admin-secret" || pathname === "/api/system-settings/group-admin-secret") && method === "POST") {
      const current = await this.options.systemSettingsStore.get();
      this.sendJson(res, { ...current, adminSecretConfigured: true, groupAdminSecretConfigured: true, updatedAt: new Date().toISOString() });
      return;
    }
    this.sendJson(res, { error: "not_found" }, 404);
  }

  private async handleCommands(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const settings = await this.options.systemSettingsStore.get();
    if (method === "GET") {
      this.sendJson(res, { commands: settings.commands ?? [] });
      return;
    }
    if (method === "PUT" || method === "PATCH") {
      const body = await readBody(req);
      const commands = Array.isArray(body.commands) ? body.commands as SystemCommandConfig[] : [];
      const next = await this.options.systemSettingsStore.update({ commands });
      this.sendJson(res, { commands: next.commands ?? [] });
      return;
    }
    this.sendJson(res, { error: "not_found" }, 404);
  }

  private async handleHealth(res: ServerResponse, refresh: boolean): Promise<void> {
    const health = await this.options.app.getSystemHealthStatus({ refreshModels: refresh });
    const modelStatuses = await this.getModelStatuses(refresh);
    this.sendJson(res, {
      transportHealth: health.transport,
      profileAiHealth: modelStatuses.find((model) => model.purpose === "memory") ?? firstModelHealth(health),
      modelStatuses,
      abnormalModelStatuses: modelStatuses.filter((model) => !model.ok),
      modelStatusSummary: {
        total: modelStatuses.length,
        abnormal: modelStatuses.filter((model) => !model.ok).length,
        checkedAt: new Date().toISOString(),
      },
      uptimeSeconds: health.runtime.uptimeSeconds,
      nodeVersion: health.runtime.nodeVersion,
      pid: health.runtime.pid,
      memory: {
        rss: health.runtime.rssMb * 1024 * 1024,
        heapUsed: health.runtime.heapUsedMb * 1024 * 1024,
      },
    });
  }

  private async handleSearch(res: ServerResponse, url: URL): Promise<void> {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    if (!q) {
      this.sendJson(res, { results: [] });
      return;
    }
    const [users, memories, candidates, knowledge] = await Promise.all([
      this.options.userConfigService.listUsers(),
      this.options.personalMemoryStore.list(),
      this.options.personalMemoryCandidateService.list(),
      this.options.personalKnowledgeStore.list(),
    ]);
    const results = [
      ...users.filter((user) => `${user.userId} ${user.displayName ?? ""}`.toLowerCase().includes(q)).map((user) => ({
        type: "group",
        title: user.displayName || user.userId,
        subtitle: `私聊用户 ${user.userId}`,
        path: "/groups",
        groupId: user.userId,
      })),
      ...memories.filter((item) => `${item.title} ${item.content}`.toLowerCase().includes(q)).slice(0, 8).map((item) => ({
        type: "memory",
        title: item.title,
        subtitle: item.content.slice(0, 80),
        path: `/memories?userId=${encodeURIComponent(item.userId)}`,
        groupId: item.userId,
      })),
      ...candidates.filter((item) => `${item.title} ${item.content}`.toLowerCase().includes(q)).slice(0, 8).map((item) => ({
        type: "candidate",
        title: item.title,
        subtitle: item.content.slice(0, 80),
        path: "/candidates",
        groupId: item.userId,
      })),
      ...knowledge.filter((item) => `${item.title} ${item.question} ${item.answer}`.toLowerCase().includes(q)).slice(0, 8).map((item) => ({
        type: "knowledge",
        title: item.title,
        subtitle: item.question,
        path: "/knowledge",
        groupId: item.userId,
      })),
    ];
    this.sendJson(res, { results: results.slice(0, 20) });
  }

  private async buildMemberProfile(userId: string): Promise<unknown | undefined> {
    const user = await this.options.userConfigService.getUser(userId);
    if (!user) return undefined;
    const [memories, candidates] = await Promise.all([
      this.options.personalMemoryStore.list(userId),
      this.options.personalMemoryCandidateService.list({ userId, status: "pending" }),
    ]);
    return {
      userId,
      displayName: user.displayName || userId,
      role: "private",
      aliases: user.displayName ? [user.displayName] : [],
      note: user.enabled === false ? "已禁用" : undefined,
      hasManualIdentity: Boolean(user.displayName),
      memoryCount: memories.length,
      pendingCandidateCount: candidates.length,
      memoryDisabled: user.memoryEnabled === false,
    };
  }

  private async getOrCreateProfileSummary(userId: string, type: ProfileRecordType, refresh: boolean): Promise<unknown> {
    const data = await readProfileRecords();
    const existing = refresh ? undefined : data.records.find((record) => record.userId === userId && record.type === type);
    const memories = await this.options.personalMemoryStore.list(userId);
    const user = await this.options.userConfigService.getUser(userId);
    const summary = memories.length
      ? memories.filter((memory) => memory.enabled).map((memory) => `- ${memory.title}: ${memory.content}`).join("\n").slice(0, 2400)
      : `${user?.displayName || userId} 暂无长期记忆，画像会在私聊积累后更完整。`;
    const record = existing ?? withShareUrl({
      id: `prof-${Date.now()}-${randomBytes(4).toString("hex")}`,
      groupId: userId,
      userId,
      type,
      summary,
      shareToken: randomBytes(18).toString("base64url"),
      publicEnabled: true,
      sourceMemoryCount: memories.length,
      generatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      createdBy: "admin-http",
    }, this.options.publicBaseUrl);
    if (!existing) {
      data.records.push(record);
      await writeProfileRecords(data);
      await this.recordTask("profile-generate", "生成个人画像", userId, userId, { type, sourceMemoryCount: memories.length });
    }
    return {
      groupId: userId,
      userId,
      type,
      subjectLabel: { label: user?.displayName || userId, kind: "私聊用户" },
      summary: record.summary,
      generatedAt: record.generatedAt,
      memoryCount: memories.length,
      sourceMemoryCount: record.sourceMemoryCount,
      cached: Boolean(existing),
      record,
    };
  }

  private async handlePublicProfile(res: ServerResponse, token: string): Promise<void> {
    const data = await readProfileRecords();
    const record = data.records.find((item) => item.shareToken === token && item.publicEnabled !== false && !item.revokedAt);
    if (!record) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end("<!doctype html><title>Not found</title><p>Profile not found.</p>");
      return;
    }
    record.accessCount = (record.accessCount ?? 0) + 1;
    await writeProfileRecords(data);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>XBot Profile</title><style>body{font-family:system-ui,sans-serif;max-width:760px;margin:48px auto;padding:0 24px;line-height:1.7;color:#16352d;background:#f4fbf8}main{background:white;border:1px solid #d6eee3;border-radius:16px;padding:28px;box-shadow:0 20px 48px #0b3b2f14}pre{white-space:pre-wrap}</style></head><body><main><h1>个人画像</h1><p>${escapeHtml(record.userId)} · ${escapeHtml(record.type)}</p><pre>${escapeHtml(record.summary)}</pre></main></body></html>`);
  }

  private async getModelStatuses(refresh: boolean): Promise<Array<ReturnType<typeof mapModelStatus>>> {
    const [settings, health] = await Promise.all([
      this.options.systemSettingsStore.get(),
      this.options.app.getSystemHealthStatus({ refreshModels: refresh }),
    ]);
    const healthByPurpose = new Map<SystemModelPurpose, SystemHealthStatus["models"][number]>();
    for (const item of health.models) {
      if (!healthByPurpose.has("reply")) healthByPurpose.set("reply", item);
      if (!healthByPurpose.has("memory")) healthByPurpose.set("memory", item);
    }
    return settings.models.map((model) => mapModelStatus(model, settings, healthByPurpose.get(model.purpose)));
  }

  private async recordTask(type: AdminTaskType, title: string, groupId?: string, subjectUserId?: string, result?: unknown): Promise<void> {
    const now = new Date().toISOString();
    const task: AdminTaskRecord = {
      id: `task-${Date.now()}-${randomBytes(3).toString("hex")}`,
      type,
      status: "succeeded",
      title,
      groupId,
      subjectUserId,
      operatorUserId: "admin-http",
      progress: 100,
      result,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
    };
    const tasks = await readTasks();
    tasks.push(task);
    await writeTasks(tasks.slice(-500));
  }

  private isAuthorized(req: IncomingMessage): { ok: boolean; username?: string } {
    const token = this.getSessionToken(req);
    if (token) {
      const key = hashToken(token, this.options.sessionSecret);
      const session = this.sessions.get(key);
      if (session && session.expiresAt > Date.now()) {
        return { ok: true, username: session.username };
      }
      this.sessions.delete(key);
    }
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Basic ")) return { ok: false };
    const decoded = Buffer.from(auth.slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    return username === this.options.username && password === this.options.password
      ? { ok: true, username }
      : { ok: false };
  }

  private createSession(username: string): string {
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(hashToken(token, this.options.sessionSecret), {
      username,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    return token;
  }

  private getSessionToken(req: IncomingMessage): string | undefined {
    const cookies = parseCookies(req.headers.cookie);
    return cookies.xbot_admin_session;
  }

  private async serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    const distDir = path.join(process.cwd(), "dist", "admin");
    const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = path.join(distDir, requested);
    const safePath = filePath.startsWith(distDir) && existsSync(filePath) ? filePath : path.join(distDir, "index.html");
    if (!existsSync(safePath)) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end("<!doctype html><title>XBot Admin</title><div id=\"app\">Admin UI has not been built. Run npm run build:admin.</div>");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", contentType(safePath));
    createReadStream(safePath).pipe(res);
  }

  private sendJson(res: ServerResponse, body: unknown, statusCode = 200): void {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  }
}

function mapUserToGroup(user: PrivateBotConfig): Record<string, unknown> {
  return {
    groupId: user.userId,
    groupName: user.displayName || `QQ ${user.userId}`,
    enabled: user.enabled !== false,
    currentSkillId: user.currentSkillId,
    replyModelMode: user.replyModelMode ?? "default",
    allowedSkillIds: user.allowedSkillIds,
    switcherUserIds: user.adminUserIds ?? [],
    liveChatUserIds: [],
    manualIdentities: user.displayName ? [{ userIds: [user.userId], names: [user.displayName] }] : [],
    liveChatDelaySeconds: 30,
    dailyReportEnabled: user.dailyDigestEnabled ?? false,
    dailyReportTime: "22:00",
    dailyReportDateRule: "all",
    dailyReportWeekdays: [],
    dailyReportTopUserCount: 1,
    holidayCountdownEnabled: user.holidayCountdownEnabled ?? false,
    holidayCountdownTime: "09:00",
    holidayCountdownDateRule: "all",
    holidayCountdownWeekdays: [],
    botMuted: user.autoReplyEnabled === false,
    scheduledRemindersEnabled: user.scheduledRemindersEnabled !== false,
    blacklistedUserIds: [],
    opsAlertsEnabled: true,
    triggerKeywords: [{ keyword: "XBot", enabled: true }],
    voiceReplyEnabled: user.voiceReplyEnabled !== false,
    memoryDisabledUserIds: user.memoryEnabled === false ? [user.userId] : [],
  };
}

function mapGroupPatchToUserPatch(body: Record<string, unknown>): Partial<PrivateBotConfig> {
  const patch: Partial<PrivateBotConfig> = {};
  if (typeof body.groupName === "string") patch.displayName = body.groupName;
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.currentSkillId === "string") patch.currentSkillId = body.currentSkillId;
  if (typeof body.replyModelMode === "string") patch.replyModelMode = body.replyModelMode;
  if (Array.isArray(body.allowedSkillIds)) patch.allowedSkillIds = body.allowedSkillIds.map(String).filter(Boolean);
  if (Array.isArray(body.switcherUserIds)) patch.adminUserIds = body.switcherUserIds.map(String).filter(Boolean);
  if (typeof body.voiceReplyEnabled === "boolean") patch.voiceReplyEnabled = body.voiceReplyEnabled;
  if (typeof body.botMuted === "boolean") patch.autoReplyEnabled = !body.botMuted;
  if (typeof body.scheduledRemindersEnabled === "boolean") patch.scheduledRemindersEnabled = body.scheduledRemindersEnabled;
  if (typeof body.dailyReportEnabled === "boolean") patch.dailyDigestEnabled = body.dailyReportEnabled;
  if (typeof body.holidayCountdownEnabled === "boolean") patch.holidayCountdownEnabled = body.holidayCountdownEnabled;
  if (Array.isArray(body.memoryDisabledUserIds)) patch.memoryEnabled = body.memoryDisabledUserIds.length === 0;
  return patch;
}

function mapMemory(memory: PersonalMemory): Record<string, unknown> {
  return {
    ...memory,
    groupId: memory.userId,
    type: memory.type === "personal_profile" ? "member_profile" : "group_fact",
    subjectUserId: memory.userId,
    subjectLabel: { label: memory.userId, kind: "私聊用户" },
    evidence: mapEvidence(memory.evidence),
  };
}

function mapCandidate(candidate: PersonalMemoryCandidate): Record<string, unknown> {
  return {
    ...candidate,
    groupId: candidate.userId,
    type: candidate.type === "personal_profile" ? "member_profile" : "group_fact",
    subjectUserId: candidate.userId,
    subjectLabel: { label: candidate.userId, kind: "私聊用户" },
    evidence: mapEvidence(candidate.evidence),
  };
}

function mapKnowledge(entry: PersonalKnowledgeEntry): Record<string, unknown> {
  return { ...entry, groupId: entry.userId };
}

function mapEvidence(evidence: PersonalMemory["evidence"]): unknown {
  if (!evidence) return undefined;
  return {
    ...evidence,
    speakerCount: 1,
    summaryPreview: evidence.summary.slice(0, 240),
    hasFullEvidence: true,
    speakers: [{ userId: "private", userName: "私聊用户" }],
  };
}

function mapMemoryInput(body: Record<string, unknown>): Parameters<PersonalMemoryStore["create"]>[0] {
  const userId = requiredString(body.userId ?? body.groupId ?? body.subjectUserId);
  return {
    userId,
    type: body.type === "group_fact" ? "personal_fact" : "personal_profile",
    title: requiredString(body.title),
    content: requiredString(body.content),
    confidence: normalizeNumber(body.confidence, 0.8),
    source: typeof body.source === "string" ? body.source : "admin",
    enabled: body.enabled !== false,
  };
}

function mapMemoryPatch(body: Record<string, unknown>): Partial<PersonalMemory> {
  const patch: Partial<PersonalMemory> = {};
  if (typeof body.title === "string") patch.title = body.title;
  if (typeof body.content === "string") patch.content = body.content;
  if (body.type === "member_profile" || body.type === "personal_profile") patch.type = "personal_profile";
  if (body.type === "group_fact" || body.type === "personal_fact") patch.type = "personal_fact";
  if (typeof body.subjectUserId === "string" && body.subjectUserId) patch.userId = body.subjectUserId;
  if (typeof body.userId === "string" && body.userId) patch.userId = body.userId;
  if (typeof body.confidence === "number") patch.confidence = body.confidence;
  if (typeof body.source === "string") patch.source = body.source;
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  return patch;
}

function mapCandidatePatch(body: Record<string, unknown>): Partial<PersonalMemoryCandidate> {
  const patch: Partial<PersonalMemoryCandidate> = {};
  if (typeof body.title === "string") patch.title = body.title;
  if (typeof body.content === "string") patch.content = body.content;
  if (body.type === "member_profile" || body.type === "personal_profile") patch.type = "personal_profile";
  if (body.type === "group_fact" || body.type === "personal_fact") patch.type = "personal_fact";
  if (typeof body.subjectUserId === "string" && body.subjectUserId) patch.userId = body.subjectUserId;
  if (typeof body.userId === "string" && body.userId) patch.userId = body.userId;
  if (typeof body.confidence === "number") patch.confidence = body.confidence;
  return patch;
}

function mapKnowledgeInput(body: Record<string, unknown>): Parameters<PersonalKnowledgeStore["create"]>[0] {
  return {
    userId: requiredString(body.userId ?? body.groupId),
    title: requiredString(body.title),
    question: requiredString(body.question),
    answer: requiredString(body.answer),
    keywords: Array.isArray(body.keywords) ? body.keywords.map(String) : [],
    enabled: body.enabled !== false,
  };
}

function mapKnowledgePatch(body: Record<string, unknown>): Partial<PersonalKnowledgeEntry> {
  const patch: Partial<PersonalKnowledgeEntry> = {};
  if (typeof body.title === "string") patch.title = body.title;
  if (typeof body.question === "string") patch.question = body.question;
  if (typeof body.answer === "string") patch.answer = body.answer;
  if (Array.isArray(body.keywords)) patch.keywords = body.keywords.map(String);
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.userId === "string") patch.userId = body.userId;
  if (typeof body.groupId === "string") patch.userId = body.groupId;
  return patch;
}

function mapReminder(task: PersonalReminderTask): Record<string, unknown> {
  return { ...task, groupId: task.userId, scheduledTime: task.executionStartTime };
}

function mapReminderRequest(body: Record<string, unknown>): ReminderCreateRequest {
  return {
    intervalMinutes: normalizeNumber(body.intervalMinutes, normalizeNumber(body.executionIntervalMinutes, 60)),
    topic: requiredString(body.topic),
    executionStartTime: typeof body.executionStartTime === "string" ? body.executionStartTime : undefined,
    executionEndTime: typeof body.executionEndTime === "string" ? body.executionEndTime : undefined,
    executionIntervalMinutes: typeof body.executionIntervalMinutes === "number" ? body.executionIntervalMinutes : undefined,
    dateRule: normalizeDateRule(body.dateRule),
    weekdays: Array.isArray(body.weekdays) ? body.weekdays.map(Number).filter((item) => Number.isInteger(item)) : [],
  };
}

function mapModelOption(model: SystemModelConfig): Record<string, unknown> {
  return {
    id: model.id,
    label: `${model.name} / ${model.model}`,
    name: model.name,
    shortName: model.shortName,
    purpose: model.purpose,
    enabled: model.enabled,
    hasApiKey: model.hasApiKey,
    baseUrl: model.baseUrl,
    model: model.model,
  };
}

function mapModelStatus(model: SystemModelConfig, settings: SystemSettings, health?: SystemHealthStatus["models"][number]): Record<string, unknown> {
  return {
    id: model.id,
    purpose: model.purpose,
    name: model.name,
    shortName: model.shortName,
    selected: settings.selectedModelIds[model.purpose] === model.id,
    ok: model.enabled && model.hasApiKey ? (health?.ok ?? true) : false,
    detail: model.enabled ? (model.hasApiKey ? (health?.detail ?? "configured") : "missing api key") : "disabled",
    model: model.model,
    baseUrl: model.baseUrl,
    checkedAt: health?.checkedAt ?? new Date().toISOString(),
    latencyMs: health?.latencyMs ?? 0,
    cached: health?.cached ?? true,
  };
}

function mapOperationLog(entry: AdminOperationLogEntry): Record<string, unknown> {
  return {
    timestamp: entry.time,
    groupId: entry.targetUserId ?? "system",
    operatorUserId: entry.actorUserId,
    action: entry.action,
    target: entry.targetUserId,
    detail: entry.detail,
  };
}

function filterMemories(items: Array<Record<string, unknown>>, url: URL): Array<Record<string, unknown>> {
  let result = items;
  result = filterByQuery(result, url.searchParams.get("q"), (item) => `${item.title ?? ""} ${item.content ?? ""} ${item.subjectUserId ?? ""}`);
  result = filterByExact(result, "subjectUserId", url.searchParams.get("subjectUserId"));
  result = filterByExact(result, "type", url.searchParams.get("type"));
  const enabled = url.searchParams.get("enabled");
  if (enabled === "true" || enabled === "false") result = result.filter((item) => String(item.enabled) === enabled);
  return result;
}

function filterCandidates(items: Array<Record<string, unknown>>, url: URL): Array<Record<string, unknown>> {
  let result = items;
  result = filterByQuery(result, url.searchParams.get("q"), (item) => `${item.title ?? ""} ${item.content ?? ""} ${item.subjectUserId ?? ""}`);
  result = filterByExact(result, "subjectUserId", url.searchParams.get("subjectUserId"));
  result = filterByExact(result, "type", url.searchParams.get("type"));
  return result;
}

function pageArray<T>(items: T[], url: URL, key: string): Record<string, unknown> {
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const pageSize = Math.max(1, Math.min(1000, Number(url.searchParams.get("pageSize") ?? 20)));
  const pagination: Pagination = {
    page,
    pageSize,
    total: items.length,
    totalPages: Math.max(1, Math.ceil(items.length / pageSize)),
  };
  return {
    [key]: items.slice((page - 1) * pageSize, page * pageSize),
    pagination,
  };
}

function pageItems<T>(items: T[], url: URL, key: string): Record<string, unknown> {
  return pageArray(items, url, key);
}

function filterByQuery<T>(items: T[], q: string | null, getText: (item: T) => string): T[] {
  const text = q?.trim().toLowerCase();
  return text ? items.filter((item) => getText(item).toLowerCase().includes(text)) : items;
}

function filterByExact<T>(items: T[], key: keyof T, value: string | null): T[] {
  return value ? items.filter((item) => String(item[key] ?? "") === value) : items;
}

function findDuplicateMemoryDecisions(memories: PersonalMemory[]): Array<{ action: string; targetId?: string; duplicateId: string; reason: string; similarity: number }> {
  const seen = new Map<string, string>();
  const decisions: Array<{ action: string; targetId?: string; duplicateId: string; reason: string; similarity: number }> = [];
  for (const memory of memories) {
    const key = memory.content.toLowerCase().replace(/\s+/g, "");
    const targetId = seen.get(key);
    if (targetId) decisions.push({ action: "disable", targetId, duplicateId: memory.id, reason: "内容完全重复", similarity: 1 });
    else seen.set(key, memory.id);
  }
  return decisions;
}

function buildSchedulePreview(tasks: PersonalReminderTask[], days: number): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  const today = new Date();
  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(today);
    date.setDate(today.getDate() + offset);
    const dateKey = date.toISOString().slice(0, 10);
    result.push({
      date: dateKey,
      items: tasks
        .filter((task) => task.enabled)
        .filter((task) => task.nextRunAt.startsWith(dateKey) || offset === 0)
        .map((task) => ({
          type: "scheduled_reminder",
          title: task.topic,
          time: task.executionStartTime ?? task.nextRunAt.slice(11, 16),
          enabled: task.enabled,
          taskId: task.id,
        })),
    });
  }
  return result;
}

function parseKnowledgeImport(raw: string): Array<{ title: string; question: string; answer: string; keywords: string[]; enabled: boolean }> {
  return raw.split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block, index) => {
      const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      return {
        title: lines[0]?.replace(/^#+\s*/, "") || `FAQ ${index + 1}`,
        question: lines[0] || `Question ${index + 1}`,
        answer: lines.slice(1).join("\n") || block,
        keywords: [],
        enabled: true,
      };
    });
}

function normalizeCandidateStatus(value: string | null): PersonalMemoryCandidate["status"] | undefined {
  return value === "pending" || value === "approved" || value === "rejected" ? value : undefined;
}

function normalizeProfileType(value: unknown): ProfileRecordType {
  return value === "yesterday" ? "yesterday" : "overall";
}

function normalizeDateRule(value: unknown): PersonalReminderTask["dateRule"] {
  return value === "workday" || value === "holiday" || value === "custom" ? value : "all";
}

function normalizeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function firstModelHealth(health: SystemHealthStatus): unknown {
  const first = health.models[0];
  return first ?? { ok: true, detail: "no model health available", checkedAt: new Date().toISOString(), latencyMs: 0 };
}

async function readProfileRecords(): Promise<ProfileRecordsFile> {
  try {
    const data = JSON.parse(await readFile(profileRecordsPath(), "utf8")) as Partial<ProfileRecordsFile>;
    return { records: Array.isArray(data.records) ? data.records.map((record) => withShareUrl(record, "")) : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { records: [] };
  }
}

async function writeProfileRecords(data: ProfileRecordsFile): Promise<void> {
  await mkdir(path.dirname(profileRecordsPath()), { recursive: true });
  await writeFile(profileRecordsPath(), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function withShareUrl(record: ProfileRecord, publicBaseUrl: string): ProfileRecord {
  return {
    ...record,
    shareUrl: record.shareToken && publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, "")}/profile/${record.shareToken}` : record.shareUrl,
  };
}

async function readTasks(): Promise<AdminTaskRecord[]> {
  try {
    const data = JSON.parse(await readFile(adminTasksPath(), "utf8")) as { tasks?: AdminTaskRecord[] };
    return Array.isArray(data.tasks) ? data.tasks : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
}

async function writeTasks(tasks: AdminTaskRecord[]): Promise<void> {
  await mkdir(path.dirname(adminTasksPath()), { recursive: true });
  await writeFile(adminTasksPath(), `${JSON.stringify({ tasks }, null, 2)}\n`, "utf8");
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of (header ?? "").split(";")) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (name) result[name] = decodeURIComponent(value);
  }
  return result;
}

function buildSessionCookie(token: string, req: IncomingMessage, maxAgeSeconds: number): string {
  const secure = (req.headers["x-forwarded-proto"] ?? "").toString().includes("https");
  return [
    `xbot_admin_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

function hashToken(token: string, secret: string): string {
  return createHmac("sha256", secret).update(token).digest("base64url");
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("required_string");
  return value.trim();
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function trimTrailingSlash(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char] ?? char));
}
