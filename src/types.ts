export type MessageSegment =
  | {
      type: string;
      data?: Record<string, string>;
    }
  | string;

export interface NapcatSender {
  user_id?: number;
  nickname?: string;
  card?: string;
  role?: string;
}

export interface NapcatPrivateMessageEvent {
  post_type: "message";
  message_type: "private";
  sub_type?: string;
  self_id: number;
  user_id: number;
  message_id: number;
  raw_message: string;
  message: MessageSegment[] | string;
  sender?: NapcatSender;
}

export interface MessageImageInput {
  url?: string;
  file?: string;
  summary?: string;
}

export interface ParsedPrivateMessage {
  text: string;
  images: MessageImageInput[];
}

export interface SkillDefinition {
  id: string;
  name: string;
  systemPrompt: string;
  styleRules: string[];
  knowledge: string[];
  sourceSkillLines?: string[];
  ttsStyleHint?: string;
  exampleExchanges?: Array<{
    user: string;
    assistant: string;
  }>;
  temperature: number;
  maxContextTurns: number;
  maxReplyCharsPerMessage?: number;
  maxTotalReplyChars?: number;
  maxReplyMessages?: number;
  preferredMaxReplyMessages?: number;
  stripAsterisks?: boolean;
  singleSentencePerMessage?: boolean;
  stripTerminalPunctuation?: boolean;
  respectLineBreaks?: boolean;
  allowBurstOnHighEmotion?: boolean;
  highEmotionKeywords?: string[];
}

export type ReplyModelMode = string;

export interface PrivateBotConfig {
  userId: string;
  displayName?: string;
  enabled?: boolean;
  currentSkillId: string;
  allowedSkillIds: string[];
  adminUserIds?: string[];
  replyModelMode?: ReplyModelMode;
  voiceReplyEnabled?: boolean;
  autoReplyEnabled?: boolean;
  scheduledRemindersEnabled?: boolean;
  dailyDigestEnabled?: boolean;
  holidayCountdownEnabled?: boolean;
  memoryEnabled?: boolean;
  knowledgeEnabled?: boolean;
}

export type ScheduleDateRule = "all" | "workday" | "holiday" | "custom";
export type SystemModelPurpose = "reply" | "memory" | "tts" | "custom";

export interface UsersConfigFile {
  superAdminUserIds?: string[];
  users: PrivateBotConfig[];
}

export interface ConversationTurn {
  userId: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface ConversationsFile {
  conversations: Record<string, ConversationTurn[]>;
}

export type PersonalMemoryType = "personal_profile" | "personal_fact";
export type PersonalMemoryCandidateStatus = "pending" | "approved" | "rejected";

export interface PersonalMemoryEvidence {
  startAt: string;
  endAt: string;
  messageCount: number;
  summary: string;
}

export interface PersonalMemory {
  id: string;
  userId: string;
  type: PersonalMemoryType;
  title: string;
  content: string;
  confidence: number;
  source: string;
  createdAt: string;
  updatedAt: string;
  enabled: boolean;
  evidence?: PersonalMemoryEvidence;
}

export interface PersonalMemoryCandidate {
  id: string;
  userId: string;
  type: PersonalMemoryType;
  title: string;
  content: string;
  confidence: number;
  source: string;
  status: PersonalMemoryCandidateStatus;
  createdAt: string;
  updatedAt: string;
  evidence?: PersonalMemoryEvidence;
}

export interface PersonalMemoryFile {
  memories: PersonalMemory[];
}

export interface PersonalMemoryCandidatesFile {
  candidates: PersonalMemoryCandidate[];
}

export interface PersonalKnowledgeEntry {
  id: string;
  userId: string;
  title: string;
  question: string;
  answer: string;
  keywords: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalKnowledgeFile {
  entries: PersonalKnowledgeEntry[];
}

export interface PersonalReminderTask {
  id: string;
  userId: string;
  creatorUserId: string;
  intervalMinutes: number;
  topic: string;
  executionStartTime?: string;
  executionEndTime?: string;
  executionIntervalMinutes?: number;
  dateRule?: ScheduleDateRule;
  weekdays?: number[];
  createdAt: string;
  nextRunAt: string;
  enabled: boolean;
  recentMessages?: string[];
}

export interface PersonalRemindersFile {
  tasks: Record<string, PersonalReminderTask>;
}

export interface AiReply {
  text: string;
  model: string;
  skillId: string;
}

export interface AiHealthStatus {
  ok: boolean;
  detail: string;
  model: string;
  baseUrl: string;
  checkedAt: string;
  latencyMs: number;
  cached?: boolean;
}

export interface RuntimeHealthStatus {
  nodeVersion: string;
  pid: number;
  uptimeSeconds: number;
  hostname: string;
  rssMb: number;
  heapUsedMb: number;
  cwd: string;
}

export interface SystemHealthStatus {
  transport: TransportHealthStatus;
  models: AiHealthStatus[];
  runtime: RuntimeHealthStatus;
}

export interface SystemModelConfig {
  id: string;
  name: string;
  shortName: string;
  baseUrl: string;
  model: string;
  purpose: SystemModelPurpose;
  apiKey?: string;
  hasApiKey: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SystemSettings {
  models: SystemModelConfig[];
  selectedModelIds: Partial<Record<SystemModelPurpose, string>>;
  updatedAt: string;
}

export interface AppConfig {
  napcatMode: "forward" | "reverse";
  napcatWsUrl: string;
  napcatAccessToken?: string;
  napcatReverseWsHost: string;
  napcatReverseWsPort: number;
  napcatReverseWsPath: string;
  openAiBaseUrl: string;
  openAiApiKey: string;
  openAiModel: string;
  memoryAiBaseUrl: string;
  memoryAiApiKey: string;
  memoryAiModel: string;
  ttsBaseUrl: string;
  ttsApiKey: string;
  ttsModel: string;
  ttsVoice: string;
  ttsAudioFormat: "wav" | "mp3" | "pcm" | "pcm16";
  botQq: string;
  usersConfigPath: string;
  skillsDir: string;
  conversationsPath: string;
  personalMemoryPath: string;
  personalMemoryCandidatesPath: string;
  personalKnowledgePath: string;
  personalRemindersPath: string;
  adminOperationLogPath: string;
  systemSettingsPath: string;
  adminHttpEnabled: boolean;
  adminHttpHost: string;
  adminHttpPort: number;
  adminPublicBaseUrl: string;
  adminUsername?: string;
  adminPassword?: string;
  adminSessionSecret?: string;
}

export interface TransportHealthStatus {
  ok: boolean;
  detail: string;
}
