export interface PrivateBotConfig {
  userId: string;
  displayName?: string;
  enabled?: boolean;
  currentSkillId: string;
  allowedSkillIds: string[];
  replyModelMode?: string;
  voiceReplyEnabled?: boolean;
  autoReplyEnabled?: boolean;
  scheduledRemindersEnabled?: boolean;
  dailyDigestEnabled?: boolean;
  holidayCountdownEnabled?: boolean;
  memoryEnabled?: boolean;
  knowledgeEnabled?: boolean;
}

export interface SkillDefinition {
  id: string;
  name: string;
  temperature: number;
  maxContextTurns: number;
}

export interface PersonalMemory {
  id: string;
  userId: string;
  type: "personal_profile" | "personal_fact";
  title: string;
  content: string;
  confidence: number;
  source: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  evidence?: {
    startAt: string;
    endAt: string;
    messageCount: number;
    summary: string;
  };
}

export interface PersonalMemoryCandidate extends Omit<PersonalMemory, "enabled"> {
  status: "pending" | "approved" | "rejected";
  evidence?: {
    startAt: string;
    endAt: string;
    messageCount: number;
    summary: string;
  };
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

export interface PersonalReminderTask {
  id: string;
  userId: string;
  intervalMinutes: number;
  topic: string;
  executionStartTime?: string;
  executionEndTime?: string;
  executionIntervalMinutes?: number;
  dateRule?: "all" | "workday" | "holiday" | "custom";
  weekdays?: number[];
  nextRunAt: string;
  enabled: boolean;
}

export interface AdminOperationLogEntry {
  time: string;
  actorUserId: string;
  action: string;
  targetUserId?: string;
  detail?: string;
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

export interface SystemHealthStatus {
  transport: { ok: boolean; detail: string };
  models: AiHealthStatus[];
  runtime: {
    nodeVersion: string;
    pid: number;
    uptimeSeconds: number;
    hostname: string;
    rssMb: number;
    heapUsedMb: number;
    cwd: string;
  };
}

export interface SystemModelConfig {
  id: string;
  name: string;
  shortName: string;
  baseUrl: string;
  model: string;
  purpose: "reply" | "memory" | "tts" | "custom";
  hasApiKey: boolean;
  apiKey?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SystemSettings {
  models: SystemModelConfig[];
  selectedModelIds: Partial<Record<SystemModelConfig["purpose"], string>>;
  updatedAt: string;
}

export interface Overview {
  users: number;
  enabledUsers: number;
  memories: number;
  pendingCandidates: number;
  skills: number;
  health: SystemHealthStatus;
  logs: AdminOperationLogEntry[];
}
