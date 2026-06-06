import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PersonalReminderService } from "./personal-reminder-service.js";

test("PersonalReminderService parses private workday reminder windows", async () => {
  const fixture = await createService();
  try {
    const request = fixture.service.parseCreateRequest("#定时任务 添加 工作日 09:00-18:00 每30分钟提醒我喝水");
    assert.equal(request?.dateRule, "workday");
    assert.equal(request?.executionStartTime, "09:00");
    assert.equal(request?.executionEndTime, "18:00");
    assert.equal(request?.executionIntervalMinutes, 30);
    assert.match(request?.topic ?? "", /喝水/);
  } finally {
    await fixture.cleanup();
  }
});

test("PersonalReminderService skips China statutory holidays for workday windows", async () => {
  const fixture = await createService();
  try {
    const task = await fixture.service.createTask({
      userId: "200",
      creatorUserId: "200",
      now: new Date("2026-02-14T10:00:00+08:00"),
      request: {
        intervalMinutes: 60,
        topic: "提交日报",
        executionStartTime: "09:00",
        executionEndTime: "09:00",
        executionIntervalMinutes: 60,
        dateRule: "workday",
      },
    });
    assert.equal(task.dateRule, "workday");
    assert.equal(task.nextRunAt.slice(0, 10), "2026-02-24");
  } finally {
    await fixture.cleanup();
  }
});

async function createService() {
  const root = await mkdtemp(path.join(os.tmpdir(), "xbot-reminder-"));
  return {
    service: new PersonalReminderService(path.join(root, "personal-reminders.json")),
    cleanup: async () => rm(root, { recursive: true, force: true }),
  };
}
