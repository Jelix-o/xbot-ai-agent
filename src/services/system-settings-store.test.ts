import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SystemSettingsStore } from "./system-settings-store.js";

test("SystemSettingsStore exposes default env models without api keys", async () => {
  const fixture = await createStore();
  try {
    const settings = await fixture.store.get();
    const reply = settings.models.find((model) => model.id === "env-reply");
    assert.equal(reply?.model, "gpt-5.5");
    assert.equal(reply?.hasApiKey, true);
    assert.equal(reply?.apiKey, undefined);
    assert.equal(settings.selectedModelIds.reply, "env-reply");
  } finally {
    await fixture.cleanup();
  }
});

test("SystemSettingsStore preserves api key when editing with blank key", async () => {
  const fixture = await createStore();
  try {
    await fixture.store.update({
      models: [{
        id: "reply-pro",
        name: "Reply Pro",
        shortName: "Pro",
        purpose: "reply",
        baseUrl: "https://api.example/v1",
        model: "reply-pro",
        apiKey: "secret-key",
        hasApiKey: true,
        enabled: true,
      }],
      selectedModelIds: { reply: "reply-pro" },
    });
    const edited = await fixture.store.update({
      models: [{
        id: "reply-pro",
        name: "Reply Pro 2",
        shortName: "Pro2",
        purpose: "reply",
        baseUrl: "https://api2.example/v1",
        model: "reply-pro-2",
        apiKey: "",
        hasApiKey: true,
        enabled: true,
      }],
      selectedModelIds: { reply: "reply-pro" },
    });
    assert.equal(edited.models.find((model) => model.id === "reply-pro")?.apiKey, undefined);
    const selected = await fixture.store.getSelectedModel("reply");
    assert.equal(selected?.apiKey, "secret-key");
    assert.equal(selected?.model, "reply-pro-2");
  } finally {
    await fixture.cleanup();
  }
});

async function createStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), "xbot-settings-"));
  return {
    store: new SystemSettingsStore(path.join(root, "system-settings.json"), [{
      id: "env-reply",
      name: "Env Reply",
      shortName: "Reply",
      purpose: "reply",
      baseUrl: "https://env.example/v1",
      model: "gpt-5.5",
      apiKey: "env-key",
      hasApiKey: true,
      enabled: true,
    }]),
    cleanup: async () => rm(root, { recursive: true, force: true }),
  };
}
