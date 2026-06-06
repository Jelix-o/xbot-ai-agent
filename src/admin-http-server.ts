import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import type { BotApplication } from "./bot.js";
import type { AdminOperationLogService } from "./services/admin-operation-log-service.js";
import type { PersonalKnowledgeStore } from "./services/personal-knowledge-store.js";
import type { PersonalMemoryCandidateService } from "./services/personal-memory-candidate-service.js";
import type { PersonalMemoryStore } from "./services/personal-memory-store.js";
import type { PersonalReminderService } from "./services/personal-reminder-service.js";
import type { SkillService } from "./services/skill-service.js";
import type { SystemSettingsStore } from "./services/system-settings-store.js";
import type { UserConfigService } from "./services/user-config-service.js";

interface AdminHttpServerOptions {
  host: string;
  port: number;
  username: string;
  password: string;
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

export class AdminHttpServer {
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
        details: { host: this.options.host, port: this.options.port },
      }));
    });
  }

  close(): void {
    this.server.close();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      if (!this.isAuthorized(req)) {
        this.sendJson(res, { error: "unauthorized" }, 401);
        return;
      }
      await this.handleApi(req, res, url);
      return;
    }
    await this.serveStatic(res, url.pathname);
  }

  private async handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    if (method === "GET" && url.pathname === "/api/overview") {
      const [users, memories, candidates, skills, logs, health] = await Promise.all([
        this.options.userConfigService.listUsers(),
        this.options.personalMemoryStore.list(),
        this.options.personalMemoryCandidateService.list(),
        this.options.skillService.getAllSkills(),
        this.options.adminOperationLogService.list(10),
        this.options.app.getSystemHealthStatus(),
      ]);
      this.sendJson(res, {
        users: users.length,
        enabledUsers: users.filter((user) => user.enabled !== false).length,
        memories: memories.length,
        pendingCandidates: candidates.filter((candidate) => candidate.status === "pending").length,
        skills: skills.length,
        health,
        logs,
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/users") {
      this.sendJson(res, { users: await this.options.userConfigService.listUsers() });
      return;
    }
    if (method === "POST" && url.pathname === "/api/users") {
      const body = await readBody(req);
      const user = await this.options.userConfigService.inviteUser(requiredString(body.userId), body);
      await this.options.adminOperationLogService.record({ actorUserId: "admin-http", action: "user_invite", targetUserId: user.userId });
      this.sendJson(res, { user });
      return;
    }
    const userRoute = url.pathname.match(/^\/api\/users\/([^/]+)$/);
    if (userRoute && method === "PATCH") {
      const user = await this.options.userConfigService.updateUser(decodeURIComponent(userRoute[1]!), await readBody(req));
      if (!user) {
        this.sendJson(res, { error: "not_found" }, 404);
        return;
      }
      await this.options.adminOperationLogService.record({ actorUserId: "admin-http", action: "user_update", targetUserId: user.userId });
      this.sendJson(res, { user });
      return;
    }
    if (userRoute && method === "DELETE") {
      const targetUserId = decodeURIComponent(userRoute[1]!);
      const removed = await this.options.userConfigService.removeUser(targetUserId);
      if (removed) await this.options.adminOperationLogService.record({ actorUserId: "admin-http", action: "user_remove", targetUserId });
      this.sendJson(res, { removed });
      return;
    }

    if (method === "GET" && url.pathname === "/api/skills") {
      this.sendJson(res, { skills: await this.options.skillService.getAllSkills() });
      return;
    }

    if (method === "GET" && url.pathname === "/api/memories") {
      this.sendJson(res, { memories: await this.options.personalMemoryStore.list(url.searchParams.get("userId") ?? undefined) });
      return;
    }
    if (method === "POST" && url.pathname === "/api/memories") {
      const memory = await this.options.personalMemoryStore.create(await readBody(req) as never);
      await this.options.adminOperationLogService.record({ actorUserId: "admin-http", action: "memory_create", targetUserId: memory.userId, detail: memory.id });
      this.sendJson(res, { memory });
      return;
    }
    const memoryRoute = url.pathname.match(/^\/api\/memories\/([^/]+)$/);
    if (memoryRoute && method === "PATCH") {
      const memory = await this.options.personalMemoryStore.update(decodeURIComponent(memoryRoute[1]!), await readBody(req));
      if (memory) await this.options.adminOperationLogService.record({ actorUserId: "admin-http", action: "memory_update", targetUserId: memory.userId, detail: memory.id });
      this.sendJson(res, { memory });
      return;
    }
    if (memoryRoute && method === "DELETE") {
      const id = decodeURIComponent(memoryRoute[1]!);
      const removed = await this.options.personalMemoryStore.remove(id);
      if (removed) await this.options.adminOperationLogService.record({ actorUserId: "admin-http", action: "memory_remove", detail: id });
      this.sendJson(res, { removed });
      return;
    }

    if (method === "GET" && url.pathname === "/api/memory-candidates") {
      const status = url.searchParams.get("status") as "pending" | "approved" | "rejected" | null;
      this.sendJson(res, {
        candidates: await this.options.personalMemoryCandidateService.list({
          userId: url.searchParams.get("userId") ?? undefined,
          status: status ?? undefined,
        }),
      });
      return;
    }
    const candidateAction = url.pathname.match(/^\/api\/memory-candidates\/([^/]+)\/(approve|reject)$/);
    if (candidateAction && method === "POST") {
      const id = decodeURIComponent(candidateAction[1]!);
      const result = candidateAction[2] === "approve"
        ? await this.options.personalMemoryCandidateService.approve(id, await readBody(req))
        : await this.options.personalMemoryCandidateService.reject(id);
      if (!result) {
        this.sendJson(res, { error: "not_found" }, 404);
        return;
      }
      await this.options.adminOperationLogService.record({ actorUserId: "admin-http", action: `memory_candidate_${candidateAction[2]}`, targetUserId: result.userId, detail: id });
      this.sendJson(res, { candidate: result });
      return;
    }
    const candidateRoute = url.pathname.match(/^\/api\/memory-candidates\/([^/]+)$/);
    if (candidateRoute && method === "PATCH") {
      this.sendJson(res, { candidate: await this.options.personalMemoryCandidateService.update(decodeURIComponent(candidateRoute[1]!), await readBody(req)) });
      return;
    }
    if (candidateRoute && method === "DELETE") {
      this.sendJson(res, { removed: await this.options.personalMemoryCandidateService.remove(decodeURIComponent(candidateRoute[1]!)) });
      return;
    }

    if (method === "GET" && url.pathname === "/api/knowledge") {
      this.sendJson(res, { entries: await this.options.personalKnowledgeStore.list(url.searchParams.get("userId") ?? undefined) });
      return;
    }
    if (method === "POST" && url.pathname === "/api/knowledge") {
      const entry = await this.options.personalKnowledgeStore.create(await readBody(req) as never);
      await this.options.adminOperationLogService.record({ actorUserId: "admin-http", action: "knowledge_create", targetUserId: entry.userId, detail: entry.id });
      this.sendJson(res, { entry });
      return;
    }
    const knowledgeRoute = url.pathname.match(/^\/api\/knowledge\/([^/]+)$/);
    if (knowledgeRoute && method === "PATCH") {
      const entry = await this.options.personalKnowledgeStore.update(decodeURIComponent(knowledgeRoute[1]!), await readBody(req));
      if (entry) await this.options.adminOperationLogService.record({ actorUserId: "admin-http", action: "knowledge_update", targetUserId: entry.userId, detail: entry.id });
      this.sendJson(res, { entry });
      return;
    }
    if (knowledgeRoute && method === "DELETE") {
      const id = decodeURIComponent(knowledgeRoute[1]!);
      const removed = await this.options.personalKnowledgeStore.remove(id);
      if (removed) await this.options.adminOperationLogService.record({ actorUserId: "admin-http", action: "knowledge_remove", detail: id });
      this.sendJson(res, { removed });
      return;
    }

    if (method === "GET" && url.pathname === "/api/reminders") {
      const userId = url.searchParams.get("userId");
      this.sendJson(res, { tasks: userId ? await this.options.personalReminderService.listUserTasks(userId) : [] });
      return;
    }

    if (method === "GET" && url.pathname === "/api/health") {
      this.sendJson(res, await this.options.app.getSystemHealthStatus({ refreshModels: url.searchParams.get("refresh") === "1" }));
      return;
    }

    if (method === "GET" && url.pathname === "/api/system-settings") {
      this.sendJson(res, { settings: await this.options.systemSettingsStore.get() });
      return;
    }
    if (method === "PATCH" && url.pathname === "/api/system-settings") {
      const settings = await this.options.systemSettingsStore.update(await readBody(req));
      await this.options.adminOperationLogService.record({ actorUserId: "admin-http", action: "system_settings_update" });
      this.sendJson(res, { settings });
      return;
    }

    this.sendJson(res, { error: "not_found" }, 404);
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Basic ")) return false;
    const decoded = Buffer.from(auth.slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    return username === this.options.username && password === this.options.password;
  }

  private async serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    const distDir = path.join(process.cwd(), "admin", "dist");
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
  return "application/octet-stream";
}
