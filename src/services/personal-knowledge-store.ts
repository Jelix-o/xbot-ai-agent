import { randomUUID } from "node:crypto";

import type { PersonalKnowledgeEntry, PersonalKnowledgeFile } from "../types.js";
import { readJsonFile, writeJsonFile } from "../utils/json-file.js";

export class PersonalKnowledgeStore {
  private cached?: PersonalKnowledgeFile;

  constructor(private readonly filePath: string) {}

  async list(userId?: string): Promise<PersonalKnowledgeEntry[]> {
    const entries = (await this.read()).entries;
    return userId ? entries.filter((entry) => entry.userId === userId) : entries;
  }

  async search(userId: string, text: string): Promise<PersonalKnowledgeEntry[]> {
    const normalized = text.toLowerCase();
    return (await this.list(userId))
      .filter((entry) => entry.enabled)
      .filter((entry) =>
        entry.question.toLowerCase().includes(normalized) ||
        entry.title.toLowerCase().includes(normalized) ||
        entry.keywords.some((keyword) => normalized.includes(keyword.toLowerCase()))
      )
      .slice(0, 5);
  }

  async create(input: Omit<PersonalKnowledgeEntry, "id" | "createdAt" | "updatedAt" | "enabled"> & { enabled?: boolean }): Promise<PersonalKnowledgeEntry> {
    const data = await this.read();
    const now = new Date().toISOString();
    const entry: PersonalKnowledgeEntry = {
      ...input,
      id: `know-${randomUUID()}`,
      enabled: input.enabled !== false,
      createdAt: now,
      updatedAt: now,
    };
    data.entries.push(entry);
    await this.write(data);
    return entry;
  }

  async update(id: string, patch: Partial<PersonalKnowledgeEntry>): Promise<PersonalKnowledgeEntry | undefined> {
    const data = await this.read();
    const index = data.entries.findIndex((entry) => entry.id === id);
    if (index < 0) return undefined;
    data.entries[index] = { ...data.entries[index]!, ...patch, id, updatedAt: new Date().toISOString() };
    await this.write(data);
    return data.entries[index];
  }

  async remove(id: string): Promise<boolean> {
    const data = await this.read();
    const before = data.entries.length;
    data.entries = data.entries.filter((entry) => entry.id !== id);
    await this.write(data);
    return data.entries.length !== before;
  }

  private async read(): Promise<PersonalKnowledgeFile> {
    if (this.cached) return this.cached;
    try {
      const data = await readJsonFile<Partial<PersonalKnowledgeFile>>(this.filePath);
      this.cached = { entries: Array.isArray(data.entries) ? data.entries : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.cached = { entries: [] };
    }
    return this.cached;
  }

  private async write(data: PersonalKnowledgeFile): Promise<void> {
    this.cached = data;
    await writeJsonFile(this.filePath, data);
  }
}
