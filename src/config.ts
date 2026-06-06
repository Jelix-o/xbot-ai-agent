import path from "node:path";
import dotenv from "dotenv";

import type { AppConfig } from "./types.js";

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function parsePort(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? String(fallback));
  if (!Number.isFinite(value) || value <= 0 || value > 65535) {
    throw new Error(`${name} must be a valid TCP port (1-65535).`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  const cwd = process.cwd();
  const napcatMode = (process.env.NAPCAT_MODE ?? "reverse").trim().toLowerCase();
  if (napcatMode !== "forward" && napcatMode !== "reverse") {
    throw new Error("NAPCAT_MODE must be either 'forward' or 'reverse'.");
  }
  const openAiBaseUrl = requireEnv("OPENAI_BASE_URL");
  const openAiApiKey = requireEnv("OPENAI_API_KEY");
  const openAiModel = requireEnv("OPENAI_MODEL");
  const ttsAudioFormat = (process.env.TTS_AUDIO_FORMAT ?? "wav").trim().toLowerCase();
  if (!["wav", "mp3", "pcm", "pcm16"].includes(ttsAudioFormat)) {
    throw new Error("TTS_AUDIO_FORMAT must be one of 'wav', 'mp3', 'pcm', or 'pcm16'.");
  }

  return {
    napcatMode,
    napcatWsUrl: napcatMode === "forward" ? requireEnv("NAPCAT_WS_URL") : process.env.NAPCAT_WS_URL ?? "ws://127.0.0.1:3001",
    napcatAccessToken: optionalEnv("NAPCAT_ACCESS_TOKEN"),
    napcatReverseWsHost: optionalEnv("NAPCAT_REVERSE_WS_HOST") ?? "127.0.0.1",
    napcatReverseWsPort: parsePort("NAPCAT_REVERSE_WS_PORT", 6299),
    napcatReverseWsPath: optionalEnv("NAPCAT_REVERSE_WS_PATH") ?? "/onebot/ws",
    openAiBaseUrl,
    openAiApiKey,
    openAiModel,
    memoryAiBaseUrl: optionalEnv("MEMORY_AI_BASE_URL") ?? openAiBaseUrl,
    memoryAiApiKey: optionalEnv("MEMORY_AI_API_KEY") ?? openAiApiKey,
    memoryAiModel: optionalEnv("MEMORY_AI_MODEL") ?? openAiModel,
    ttsBaseUrl: optionalEnv("TTS_BASE_URL") ?? openAiBaseUrl,
    ttsApiKey: optionalEnv("TTS_API_KEY") ?? openAiApiKey,
    ttsModel: optionalEnv("TTS_MODEL") ?? "mimo-v2-tts",
    ttsVoice: optionalEnv("TTS_VOICE") ?? "mimo_default",
    ttsAudioFormat: ttsAudioFormat as AppConfig["ttsAudioFormat"],
    botQq: requireEnv("BOT_QQ"),
    usersConfigPath: path.join(cwd, "config", "users.json"),
    skillsDir: path.join(cwd, "skills"),
    conversationsPath: path.join(cwd, "data", "conversations.json"),
    personalMemoryPath: path.join(cwd, "data", "personal-memory.json"),
    personalMemoryCandidatesPath: path.join(cwd, "data", "personal-memory-candidates.json"),
    personalKnowledgePath: path.join(cwd, "data", "personal-knowledge-base.json"),
    personalRemindersPath: path.join(cwd, "data", "personal-reminders.json"),
    adminOperationLogPath: path.join(cwd, "data", "admin-operations.jsonl"),
    systemSettingsPath: path.join(cwd, "data", "system-settings.json"),
    adminHttpEnabled: (process.env.ADMIN_HTTP_ENABLED ?? "false").trim().toLowerCase() === "true",
    adminHttpHost: optionalEnv("ADMIN_HTTP_HOST") ?? "127.0.0.1",
    adminHttpPort: parsePort("ADMIN_HTTP_PORT", 6300),
    adminPublicBaseUrl: optionalEnv("ADMIN_PUBLIC_BASE_URL") ?? "http://127.0.0.1:6300",
    adminUsername: optionalEnv("ADMIN_USERNAME"),
    adminPassword: optionalEnv("ADMIN_PASSWORD"),
    adminSessionSecret: optionalEnv("ADMIN_SESSION_SECRET"),
  };
}
