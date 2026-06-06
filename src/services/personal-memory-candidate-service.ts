import type { AiService } from "./ai-service.js";
import { PersonalMemoryCandidateStore, PersonalMemoryStore } from "./personal-memory-store.js";
import type { PersonalMemoryCandidate, PersonalMemoryEvidence } from "../types.js";

const AUTO_APPROVE_CONFIDENCE_THRESHOLD = 0.8;
const DEFAULT_BATCH_SIZE = 6;
const MESSAGE_TEXT_LIMIT = 1000;

interface BufferedPersonalMessage {
  userId: string;
  text: string;
  timestamp: string;
}

export interface PersonalMemoryFlushStats {
  userId: string;
  messageCount: number;
  candidateCount: number;
  autoApprovedCount: number;
  pendingCount: number;
}

export class PersonalMemoryCandidateService {
  private readonly buffers = new Map<string, BufferedPersonalMessage[]>();

  constructor(
    private readonly candidateStore: PersonalMemoryCandidateStore,
    private readonly memoryStore: PersonalMemoryStore,
    private readonly aiService: Pick<AiService, "extractPersonalMemoryCandidates">,
    private readonly batchSize = DEFAULT_BATCH_SIZE,
  ) {}

  async list(args: { userId?: string; status?: PersonalMemoryCandidate["status"] } = {}): Promise<PersonalMemoryCandidate[]> {
    return this.candidateStore.list(args);
  }

  async get(id: string): Promise<PersonalMemoryCandidate | undefined> {
    return this.candidateStore.get(id);
  }

  async approve(id: string, patch: Partial<PersonalMemoryCandidate> = {}): Promise<PersonalMemoryCandidate | undefined> {
    const current = await this.candidateStore.get(id);
    if (!current || current.status !== "pending") return undefined;
    const candidate = { ...current, ...patch };
    await this.memoryStore.create({
      userId: candidate.userId,
      type: candidate.type,
      title: candidate.title,
      content: candidate.content,
      confidence: candidate.confidence,
      source: candidate.source,
      evidence: candidate.evidence,
    });
    return this.candidateStore.update(id, { ...patch, status: "approved" });
  }

  async reject(id: string): Promise<PersonalMemoryCandidate | undefined> {
    return this.candidateStore.update(id, { status: "rejected" });
  }

  async update(id: string, patch: Partial<PersonalMemoryCandidate>): Promise<PersonalMemoryCandidate | undefined> {
    return this.candidateStore.update(id, patch);
  }

  async remove(id: string): Promise<boolean> {
    return this.candidateStore.remove(id);
  }

  queueMessage(message: BufferedPersonalMessage): void {
    const text = message.text.trim();
    if (!text || text.startsWith("#")) return;
    const buffer = this.buffers.get(message.userId) ?? [];
    buffer.push({ ...message, text: text.slice(0, MESSAGE_TEXT_LIMIT) });
    this.buffers.set(message.userId, buffer.slice(-this.batchSize * 2));
    if (buffer.length >= this.batchSize) {
      void this.flushUser(message.userId);
    }
  }

  async flushAll(): Promise<PersonalMemoryFlushStats[]> {
    const userIds = [...this.buffers.keys()];
    const results = await Promise.all(userIds.map((userId) => this.flushUser(userId)));
    return results.filter((item): item is PersonalMemoryFlushStats => Boolean(item));
  }

  async flushUser(userId: string): Promise<PersonalMemoryFlushStats | undefined> {
    const buffer = this.buffers.get(userId) ?? [];
    if (!buffer.length) return undefined;
    this.buffers.set(userId, []);
    const evidence = buildEvidence(buffer);
    const existingMemories = await this.memoryStore.list(userId);
    const rawCandidates = await this.aiService.extractPersonalMemoryCandidates({
      userId,
      messages: buffer.map((message) => ({ text: message.text, timestamp: message.timestamp })),
      existingMemories,
    });
    let autoApprovedCount = 0;
    let pendingCount = 0;
    for (const candidate of rawCandidates) {
      if (isDuplicate(candidate.content, existingMemories.map((memory) => memory.content))) {
        continue;
      }
      if (candidate.confidence >= AUTO_APPROVE_CONFIDENCE_THRESHOLD) {
        await this.memoryStore.create({
          userId,
          type: candidate.type,
          title: candidate.title,
          content: candidate.content,
          confidence: candidate.confidence,
          source: "auto_extracted_private_chat",
          evidence,
        });
        autoApprovedCount += 1;
      } else {
        await this.candidateStore.create({
          userId,
          type: candidate.type,
          title: candidate.title,
          content: candidate.content,
          confidence: candidate.confidence,
          source: "auto_extracted_private_chat",
          evidence,
        });
        pendingCount += 1;
      }
    }
    return {
      userId,
      messageCount: buffer.length,
      candidateCount: rawCandidates.length,
      autoApprovedCount,
      pendingCount,
    };
  }
}

function buildEvidence(messages: BufferedPersonalMessage[]): PersonalMemoryEvidence {
  return {
    startAt: messages[0]?.timestamp ?? new Date().toISOString(),
    endAt: messages[messages.length - 1]?.timestamp ?? new Date().toISOString(),
    messageCount: messages.length,
    summary: messages.map((message) => `[${message.timestamp}] ${message.text}`).join("\n").slice(0, 2400),
  };
}

function isDuplicate(content: string, existingContents: string[]): boolean {
  const normalized = normalizeText(content);
  return existingContents.some((existing) => normalizeText(existing) === normalized);
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}
