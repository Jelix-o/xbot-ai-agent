import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BotApplication, type MessageTransport } from "./bot.js";
import type { AiService } from "./services/ai-service.js";
import { AdminOperationLogService } from "./services/admin-operation-log-service.js";
import { ConversationStore } from "./services/conversation-store.js";
import { PersonalKnowledgeStore } from "./services/personal-knowledge-store.js";
import { PersonalMemoryCandidateService } from "./services/personal-memory-candidate-service.js";
import { PersonalMemoryCandidateStore, PersonalMemoryStore } from "./services/personal-memory-store.js";
import { PersonalReminderService } from "./services/personal-reminder-service.js";
import { SkillService } from "./services/skill-service.js";
import { TtsService } from "./services/tts-service.js";
import { UserConfigService } from "./services/user-config-service.js";
import type { AiReply, ConversationTurn, MessageImageInput, NapcatPrivateMessageEvent, PersonalMemory, SkillDefinition } from "./types.js";
import { writeJsonFile } from "./utils/json-file.js";

test("unauthorized private user is blocked before AI", async () => {
  const fixture = await createFixture();
  try {
    await fixture.app.handlePrivateMessage(privateEvent("200", "你好"));
    assert.equal(fixture.ai.calls, 0);
    assert.match(fixture.transport.privateMessages.at(-1)?.text ?? "", /还没有被邀请/);
  } finally {
    await fixture.cleanup();
  }
});

test("super admin can invite a private user", async () => {
  const fixture = await createFixture();
  try {
    await fixture.app.handlePrivateMessage(privateEvent("100", "#用户 邀请 200"));
    const user = await fixture.users.getUser("200");
    assert.equal(user?.enabled, true);
    assert.match(fixture.transport.privateMessages.at(-1)?.text ?? "", /已执行：邀请 200/);
  } finally {
    await fixture.cleanup();
  }
});

test("authorized private chat replies and stores isolated context", async () => {
  const fixture = await createFixture();
  try {
    await fixture.users.inviteUser("200", { currentSkillId: "helper", allowedSkillIds: ["helper"] });
    await fixture.app.handlePrivateMessage(privateEvent("200", "帮我分析一下"));
    assert.equal(fixture.ai.calls, 1);
    assert.match(fixture.transport.privateMessages.at(-1)?.text ?? "", /AI:帮我分析一下/);
    const turns = await fixture.conversations.getTurns("200");
    assert.equal(turns.length, 2);
    assert.equal(turns[0]?.role, "user");
    assert.equal(turns[1]?.role, "assistant");
    assert.equal((await fixture.conversations.getTurns("300")).length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("memory reply model mode routes private replies to memory AI service", async () => {
  const fixture = await createFixture();
  try {
    await fixture.users.inviteUser("200", {
      currentSkillId: "helper",
      allowedSkillIds: ["helper"],
      replyModelMode: "memory",
    });
    await fixture.app.handlePrivateMessage(privateEvent("200", "走记忆模型"));
    assert.equal(fixture.ai.calls, 0);
    assert.equal(fixture.memoryAi.calls, 1);
    assert.match(fixture.transport.privateMessages.at(-1)?.text ?? "", /AI:走记忆模型/);
  } finally {
    await fixture.cleanup();
  }
});

test("skill switch updates user and clears context", async () => {
  const fixture = await createFixture();
  try {
    await fixture.users.inviteUser("200", { currentSkillId: "helper", allowedSkillIds: ["helper", "alt"] });
    await fixture.conversations.appendDialogue("200", [{ userId: "200", role: "user", content: "old", timestamp: new Date().toISOString() }], 10);
    await fixture.app.handlePrivateMessage(privateEvent("200", "#技能 切换 alt"));
    assert.equal((await fixture.users.getUser("200"))?.currentSkillId, "alt");
    assert.equal((await fixture.conversations.getTurns("200")).length, 0);
    assert.match(fixture.transport.privateMessages.at(-1)?.text ?? "", /已切换技能/);
  } finally {
    await fixture.cleanup();
  }
});

test("personal reminder command creates a user scoped task", async () => {
  const fixture = await createFixture();
  try {
    await fixture.users.inviteUser("200", { currentSkillId: "helper", allowedSkillIds: ["helper"] });
    await fixture.app.handlePrivateMessage(privateEvent("200", "#定时任务 添加 每30分钟提醒我喝水"));
    const tasks = await fixture.reminders.listUserTasks("200");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.intervalMinutes, 30);
    assert.match(tasks[0]?.topic ?? "", /喝水/);
  } finally {
    await fixture.cleanup();
  }
});

test("personal digest summarizes today's private context", async () => {
  const fixture = await createFixture();
  try {
    await fixture.users.inviteUser("200", { currentSkillId: "helper", allowedSkillIds: ["helper"] });
    await fixture.conversations.appendDialogue("200", [
      { userId: "200", role: "user", content: "今天要整理 XBot", timestamp: new Date().toISOString() },
      { userId: "200", role: "assistant", content: "可以先列任务。", timestamp: new Date().toISOString() },
    ], 10);
    await fixture.app.handlePrivateMessage(privateEvent("200", "#日记"));
    const text = fixture.transport.privateMessages.at(-1)?.text ?? "";
    assert.match(text, /个人日记摘要/);
    assert.match(text, /今天要整理 XBot/);
  } finally {
    await fixture.cleanup();
  }
});

test("holiday command returns weekend and holiday countdown", async () => {
  const fixture = await createFixture();
  try {
    await fixture.users.inviteUser("200", { currentSkillId: "helper", allowedSkillIds: ["helper"] });
    await fixture.app.handlePrivateMessage(privateEvent("200", "#节假日"));
    const text = fixture.transport.privateMessages.at(-1)?.text ?? "";
    assert.match(text, /距离【周六】还有/);
    assert.match(text, /距离【/);
  } finally {
    await fixture.cleanup();
  }
});

test("high confidence personal memory is auto approved on flush", async () => {
  const fixture = await createFixture();
  try {
    fixture.memoryAi.candidates = [{ type: "personal_profile", title: "偏好", content: "用户喜欢 TypeScript。", confidence: 0.92 }];
    fixture.memoryCandidates.queueMessage({ userId: "200", text: "我一直喜欢 TypeScript", timestamp: new Date().toISOString() });
    const stats = await fixture.memoryCandidates.flushUser("200");
    assert.equal(stats?.autoApprovedCount, 1);
    assert.equal((await fixture.memories.list("200")).length, 1);
    assert.equal((await fixture.memoryCandidates.list({ userId: "200", status: "pending" })).length, 0);
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "xbot-"));
  const skillsDir = path.join(root, "skills");
  await writeJsonFile(path.join(skillsDir, "helper.json"), skill("helper", "Helper"));
  await writeJsonFile(path.join(skillsDir, "alt.json"), skill("alt", "Alt"));
  await writeJsonFile(path.join(root, "config", "users.json"), {
    superAdminUserIds: ["100"],
    users: [{
      userId: "100",
      enabled: true,
      currentSkillId: "helper",
      allowedSkillIds: ["helper", "alt"],
    }],
  });

  const transport = new FakeTransport();
  const users = new UserConfigService(path.join(root, "config", "users.json"), "helper");
  const skills = new SkillService(skillsDir);
  const conversations = new ConversationStore(path.join(root, "data", "conversations.json"));
  const ai = new FakeAiService();
  const memoryAi = new FakeAiService();
  const memories = new PersonalMemoryStore(path.join(root, "data", "personal-memory.json"));
  const memoryCandidateStore = new PersonalMemoryCandidateStore(path.join(root, "data", "personal-memory-candidates.json"));
  const memoryCandidates = new PersonalMemoryCandidateService(memoryCandidateStore, memories, memoryAi);
  const knowledge = new PersonalKnowledgeStore(path.join(root, "data", "personal-knowledge-base.json"));
  const reminders = new PersonalReminderService(path.join(root, "data", "personal-reminders.json"));
  const tts = new FakeTtsService();
  const app = new BotApplication(
    transport,
    users,
    skills,
    conversations,
    ai,
    memoryAi,
    memories,
    memoryCandidates,
    knowledge,
    reminders,
    tts,
    new AdminOperationLogService(path.join(root, "data", "admin-operations.jsonl")),
    "999",
  );
  return {
    root,
    transport,
    users,
    conversations,
    ai,
    memoryAi,
    memories,
    memoryCandidates,
    reminders,
    app,
    cleanup: async () => rm(root, { recursive: true, force: true }),
  };
}

function skill(id: string, name: string): SkillDefinition {
  return {
    id,
    name,
    systemPrompt: "system",
    styleRules: [],
    knowledge: [],
    temperature: 0.2,
    maxContextTurns: 4,
  };
}

function privateEvent(userId: string, text: string): NapcatPrivateMessageEvent {
  return {
    post_type: "message",
    message_type: "private",
    self_id: 999,
    user_id: Number(userId),
    message_id: Date.now(),
    raw_message: text,
    message: [{ type: "text", data: { text } }],
  };
}

class FakeTransport implements MessageTransport {
  privateMessages: Array<{ userId: string; text: string }> = [];
  privateRecords: Array<{ userId: string; file: string }> = [];

  async sendPrivateMessage(userId: string, text: string): Promise<void> {
    this.privateMessages.push({ userId, text });
  }

  async sendPrivateRecord(userId: string, recordFile: string): Promise<void> {
    this.privateRecords.push({ userId, file: recordFile });
  }
}

class FakeAiService implements Pick<AiService, "generateReply" | "extractPersonalMemoryCandidates" | "summarizePersonalProfile"> {
  calls = 0;
  candidates: Array<{ type: "personal_profile" | "personal_fact"; title: string; content: string; confidence: number }> = [];

  async generateReply(args: { userInput: string }): Promise<AiReply> {
    this.calls += 1;
    return { text: `AI:${args.userInput}`, model: "fake", skillId: "helper" };
  }

  async extractPersonalMemoryCandidates(): Promise<Array<{ type: "personal_profile" | "personal_fact"; title: string; content: string; confidence: number }>> {
    return this.candidates;
  }

  async summarizePersonalProfile(args: { memories: PersonalMemory[] }): Promise<string> {
    return `画像 ${args.memories.length}`;
  }

  async checkHealth() {
    return {
      ok: true,
      detail: "fake ok",
      model: "fake",
      baseUrl: "http://fake",
      checkedAt: new Date().toISOString(),
      latencyMs: 1,
    };
  }
}

class FakeTtsService implements Pick<TtsService, "synthesize"> {
  async synthesize(): Promise<string> {
    return "voice.wav";
  }
}
