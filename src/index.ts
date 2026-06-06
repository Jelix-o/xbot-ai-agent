import path from "node:path";

import { AdminHttpServer } from "./admin-http-server.js";
import { BotApplication, type MessageTransport } from "./bot.js";
import { loadConfig } from "./config.js";
import { logError, logInfo } from "./logger.js";
import { NapCatClient } from "./napcat-client.js";
import { NapCatReverseServer } from "./napcat-reverse-server.js";
import { AiService } from "./services/ai-service.js";
import { AdminOperationLogService } from "./services/admin-operation-log-service.js";
import { ConversationStore } from "./services/conversation-store.js";
import { PersonalKnowledgeStore } from "./services/personal-knowledge-store.js";
import { PersonalMemoryCandidateService } from "./services/personal-memory-candidate-service.js";
import { PersonalMemoryCandidateStore, PersonalMemoryStore } from "./services/personal-memory-store.js";
import { PersonalReminderService } from "./services/personal-reminder-service.js";
import { SkillService } from "./services/skill-service.js";
import { SystemSettingsStore } from "./services/system-settings-store.js";
import { TtsService } from "./services/tts-service.js";
import { UserConfigService } from "./services/user-config-service.js";
import type { NapcatPrivateMessageEvent } from "./types.js";

type NapCatRuntime = MessageTransport & {
  start(): void;
  on(event: "privateMessage", listener: (event: NapcatPrivateMessageEvent) => void): unknown;
};

async function main(): Promise<void> {
  const config = loadConfig();
  const systemSettingsStore = new SystemSettingsStore(config.systemSettingsPath, [
    {
      id: "env-reply",
      name: "Env Reply Model",
      shortName: "Reply",
      purpose: "reply",
      baseUrl: config.openAiBaseUrl,
      apiKey: config.openAiApiKey,
      model: config.openAiModel,
      hasApiKey: true,
      enabled: true,
    },
    {
      id: "env-memory",
      name: "Env Memory Model",
      shortName: "Memory",
      purpose: "memory",
      baseUrl: config.memoryAiBaseUrl,
      apiKey: config.memoryAiApiKey,
      model: config.memoryAiModel,
      hasApiKey: true,
      enabled: true,
    },
    {
      id: "env-tts",
      name: "Env TTS Model",
      shortName: "TTS",
      purpose: "tts",
      baseUrl: config.ttsBaseUrl,
      apiKey: config.ttsApiKey,
      model: config.ttsModel,
      hasApiKey: true,
      enabled: true,
    },
  ]);
  const replyAiService = new AiService(async () => {
    const model = await systemSettingsStore.getSelectedModel("reply");
    return {
      baseUrl: model?.baseUrl ?? config.openAiBaseUrl,
      apiKey: model?.apiKey ?? config.openAiApiKey,
      model: model?.model ?? config.openAiModel,
    };
  });
  const memoryAiService = new AiService(async () => {
    const model = await systemSettingsStore.getSelectedModel("memory");
    return {
      baseUrl: model?.baseUrl ?? config.memoryAiBaseUrl,
      apiKey: model?.apiKey ?? config.memoryAiApiKey,
      model: model?.model ?? config.memoryAiModel,
    };
  });
  const userConfigService = new UserConfigService(config.usersConfigPath);
  const skillService = new SkillService(config.skillsDir);
  const personalMemoryStore = new PersonalMemoryStore(config.personalMemoryPath);
  const personalMemoryCandidateStore = new PersonalMemoryCandidateStore(config.personalMemoryCandidatesPath);
  const personalMemoryCandidateService = new PersonalMemoryCandidateService(
    personalMemoryCandidateStore,
    personalMemoryStore,
    memoryAiService,
  );
  const personalKnowledgeStore = new PersonalKnowledgeStore(config.personalKnowledgePath);
  const personalReminderService = new PersonalReminderService(config.personalRemindersPath);
  const adminOperationLogService = new AdminOperationLogService(config.adminOperationLogPath);
  const napcatRuntime: NapCatRuntime =
    config.napcatMode === "reverse"
      ? new NapCatReverseServer({
          host: config.napcatReverseWsHost,
          port: config.napcatReverseWsPort,
          path: config.napcatReverseWsPath,
          accessToken: config.napcatAccessToken,
        })
      : new NapCatClient({
          wsUrl: config.napcatWsUrl,
          accessToken: config.napcatAccessToken,
        });

  const app = new BotApplication(
    napcatRuntime,
    userConfigService,
    skillService,
    new ConversationStore(config.conversationsPath),
    replyAiService,
    memoryAiService,
    personalMemoryStore,
    personalMemoryCandidateService,
    personalKnowledgeStore,
    personalReminderService,
    new TtsService(
      async () => {
        const model = await systemSettingsStore.getSelectedModel("tts");
        return {
          baseUrl: model?.baseUrl ?? config.ttsBaseUrl,
          apiKey: model?.apiKey ?? config.ttsApiKey,
          model: model?.model ?? config.ttsModel,
        };
      },
      config.ttsVoice,
      config.ttsAudioFormat,
      path.join(process.cwd(), "data", "tts-cache"),
    ),
    adminOperationLogService,
    config.botQq,
  );

  const adminHttpServer = config.adminHttpEnabled
    ? createAdminServer(config, userConfigService, skillService, personalMemoryStore, personalMemoryCandidateService, personalKnowledgeStore, personalReminderService, adminOperationLogService, systemSettingsStore, app)
    : undefined;

  napcatRuntime.on("privateMessage", async (event) => {
    try {
      await app.handlePrivateMessage(event);
    } catch (error) {
      logError("Unhandled private message error.", {
        error: (error as Error).message,
        userId: event.user_id,
      });
    }
  });

  app.start();
  napcatRuntime.start();
  adminHttpServer?.start();
  logInfo("XBot private Agent bot started.", { mode: config.napcatMode });
}

function createAdminServer(
  config: ReturnType<typeof loadConfig>,
  userConfigService: UserConfigService,
  skillService: SkillService,
  personalMemoryStore: PersonalMemoryStore,
  personalMemoryCandidateService: PersonalMemoryCandidateService,
  personalKnowledgeStore: PersonalKnowledgeStore,
  personalReminderService: PersonalReminderService,
  adminOperationLogService: AdminOperationLogService,
  systemSettingsStore: SystemSettingsStore,
  app: BotApplication,
): AdminHttpServer {
  if (!config.adminUsername || !config.adminPassword || !config.adminSessionSecret) {
    throw new Error("ADMIN_USERNAME, ADMIN_PASSWORD and ADMIN_SESSION_SECRET are required when ADMIN_HTTP_ENABLED=true.");
  }
  return new AdminHttpServer({
    host: config.adminHttpHost,
    port: config.adminHttpPort,
    username: config.adminUsername,
    password: config.adminPassword,
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
}

void main().catch((error) => {
  logError("XBot startup failed.", { error: (error as Error).message });
  process.exitCode = 1;
});
