import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AdminHttpServer } from "./admin-http-server.js";
import type { BotApplication } from "./bot.js";
import { AdminOperationLogService } from "./services/admin-operation-log-service.js";
import { PersonalKnowledgeStore } from "./services/personal-knowledge-store.js";
import { PersonalMemoryCandidateService } from "./services/personal-memory-candidate-service.js";
import { PersonalMemoryCandidateStore, PersonalMemoryStore } from "./services/personal-memory-store.js";
import { PersonalReminderService } from "./services/personal-reminder-service.js";
import { SkillService } from "./services/skill-service.js";
import { SystemSettingsStore } from "./services/system-settings-store.js";
import { UserConfigService } from "./services/user-config-service.js";
import type { AiHealthStatus, SystemHealthStatus } from "./types.js";
import { writeJsonFile } from "./utils/json-file.js";

test("admin server exposes UBot style private-user console APIs", async () => {
  const fixture = await createAdminFixture();
  try {
    const unauth = await fetch(`${fixture.baseUrl}/api/overview`);
    assert.equal(unauth.status, 401);

    const login = await fetch(`${fixture.baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "secret" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    assert.match(cookie, /^xbot_admin_session=/);

    const session = await getJson<{ authenticated: boolean; role: string; publicBaseUrl: string }>(`${fixture.baseUrl}/api/session`, cookie);
    assert.equal(session.authenticated, true);
    assert.equal(session.role, "super_admin");
    assert.equal(session.publicBaseUrl, fixture.baseUrl);

    const groups = await getJson<{ groups: Array<{ groupId: string; groupName?: string; currentSkillId: string }> }>(`${fixture.baseUrl}/api/groups?includeDisabled=1`, cookie);
    assert.deepEqual(groups.groups.map((group) => group.groupId), ["200"]);
    assert.equal(groups.groups[0]?.groupName, "Alice");
    assert.equal(groups.groups[0]?.currentSkillId, "helper");

    const overview = await getJson<{
      stats: { groupCount: number; memoryCount: number; pendingCandidateCount: number; knowledgeCount: number };
      recent: { memories: Array<{ groupId: string; subjectUserId: string }>; candidates: Array<{ groupId: string; subjectUserId: string }> };
    }>(`${fixture.baseUrl}/api/overview?groupId=200`, cookie);
    assert.equal(overview.stats.groupCount, 1);
    assert.equal(overview.stats.memoryCount, 1);
    assert.equal(overview.stats.pendingCandidateCount, 1);
    assert.equal(overview.stats.knowledgeCount, 1);
    assert.equal(overview.recent.memories[0]?.groupId, "200");
    assert.equal(overview.recent.candidates[0]?.subjectUserId, "200");

    const members = await getJson<{ members: Array<{ userId: string; displayName: string; memoryCount: number; pendingCandidateCount: number }> }>(
      `${fixture.baseUrl}/api/groups/200/members?page=1&pageSize=20`,
      cookie,
    );
    assert.equal(members.members[0]?.userId, "200");
    assert.equal(members.members[0]?.displayName, "Alice");
    assert.equal(members.members[0]?.memoryCount, 1);
    assert.equal(members.members[0]?.pendingCandidateCount, 1);
  } finally {
    await fixture.cleanup();
  }
});

async function createAdminFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "xbot-admin-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const skillsDir = path.join(root, "skills");
  await mkdir(skillsDir, { recursive: true });
  await writeJsonFile(path.join(skillsDir, "helper.json"), {
    id: "helper",
    name: "Helper",
    systemPrompt: "system",
    styleRules: [],
    knowledge: [],
    temperature: 0.2,
    maxContextTurns: 4,
  });
  await writeJsonFile(path.join(root, "config", "users.json"), {
    superAdminUserIds: ["100"],
    users: [{
      userId: "200",
      displayName: "Alice",
      enabled: true,
      currentSkillId: "helper",
      allowedSkillIds: ["helper"],
    }],
  });

  const userConfigService = new UserConfigService(path.join(root, "config", "users.json"), "helper");
  const skillService = new SkillService(skillsDir);
  const personalMemoryStore = new PersonalMemoryStore(path.join(root, "data", "personal-memory.json"));
  const personalMemoryCandidateStore = new PersonalMemoryCandidateStore(path.join(root, "data", "personal-memory-candidates.json"));
  const personalMemoryCandidateService = new PersonalMemoryCandidateService(personalMemoryCandidateStore, personalMemoryStore, {
    extractPersonalMemoryCandidates: async () => [],
  });
  const personalKnowledgeStore = new PersonalKnowledgeStore(path.join(root, "data", "personal-knowledge-base.json"));
  const personalReminderService = new PersonalReminderService(path.join(root, "data", "personal-reminders.json"));
  const adminOperationLogService = new AdminOperationLogService(path.join(root, "data", "admin-operations.jsonl"));
  const systemSettingsStore = new SystemSettingsStore(path.join(root, "data", "system-settings.json"), [{
    id: "env-reply",
    name: "Env Reply",
    shortName: "Reply",
    purpose: "reply",
    baseUrl: "https://env.example/v1",
    model: "gpt-5.5",
    apiKey: "env-key",
    hasApiKey: true,
    enabled: true,
  }]);

  await personalMemoryStore.create({
    userId: "200",
    type: "personal_profile",
    title: "Preference",
    content: "Alice prefers concise replies.",
    confidence: 0.91,
    source: "test",
  });
  await personalMemoryCandidateStore.create({
    userId: "200",
    type: "personal_fact",
    title: "Candidate",
    content: "Alice is testing XBot.",
    confidence: 0.7,
    source: "test",
  });
  await personalKnowledgeStore.create({
    userId: "200",
    title: "FAQ",
    question: "How to use XBot?",
    answer: "Chat privately with the bot.",
    keywords: ["xbot"],
  });

  const app = {
    getSystemHealthStatus: async (): Promise<SystemHealthStatus> => ({
      transport: { ok: true, detail: "connected" },
      models: [modelHealth()],
      runtime: {
        nodeVersion: process.version,
        pid: process.pid,
        uptimeSeconds: 1,
        hostname: "test",
        rssMb: 64,
        heapUsedMb: 32,
        cwd: root,
      },
    }),
  } as unknown as BotApplication;

  const server = new AdminHttpServer({
    host: "127.0.0.1",
    port,
    publicBaseUrl: baseUrl,
    username: "admin",
    password: "secret",
    sessionSecret: "test-secret",
    userConfigService,
    skillService,
    personalMemoryStore,
    personalMemoryCandidateService,
    personalKnowledgeStore,
    personalReminderService,
    adminOperationLogService,
    systemSettingsStore,
    app,
  });
  server.start();
  await waitForServer(baseUrl);
  return {
    baseUrl,
    cleanup: async () => {
      server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function getJson<T>(url: string, cookie: string): Promise<T> {
  const res = await fetch(url, { headers: { Cookie: cookie } });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return JSON.parse(text) as T;
}

function modelHealth(): AiHealthStatus {
  return {
    ok: true,
    detail: "ok",
    model: "gpt-5.5",
    baseUrl: "https://env.example/v1",
    checkedAt: new Date().toISOString(),
    latencyMs: 1,
    cached: true,
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("no_port"));
      });
    });
  });
}

async function waitForServer(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${baseUrl}/login`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("server_not_ready");
}
