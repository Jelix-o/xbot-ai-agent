import { randomUUID } from "node:crypto";

import type { PersonalMemory, PersonalMemoryCandidate, PersonalMemoryCandidatesFile, PersonalMemoryFile } from "../types.js";
import { readJsonFile, writeJsonFile } from "../utils/json-file.js";

export class PersonalMemoryStore {
  private cached?: PersonalMemoryFile;

  constructor(private readonly filePath: string) {}

  async list(userId?: string): Promise<PersonalMemory[]> {
    const memories = (await this.read()).memories;
    return userId ? memories.filter((memory) => memory.userId === userId) : memories;
  }

  async create(input: Omit<PersonalMemory, "id" | "createdAt" | "updatedAt" | "enabled"> & { enabled?: boolean }): Promise<PersonalMemory> {
    const data = await this.read();
    const now = new Date().toISOString();
    const memory: PersonalMemory = {
      ...input,
      id: `mem-${randomUUID()}`,
      createdAt: now,
      updatedAt: now,
      enabled: input.enabled !== false,
    };
    data.memories.push(memory);
    await this.write(data);
    return memory;
  }

  async update(id: string, patch: Partial<PersonalMemory>): Promise<PersonalMemory | undefined> {
    const data = await this.read();
    const index = data.memories.findIndex((memory) => memory.id === id);
    if (index < 0) return undefined;
    data.memories[index] = { ...data.memories[index]!, ...patch, id, updatedAt: new Date().toISOString() };
    await this.write(data);
    return data.memories[index];
  }

  async remove(id: string): Promise<boolean> {
    const data = await this.read();
    const before = data.memories.length;
    data.memories = data.memories.filter((memory) => memory.id !== id);
    await this.write(data);
    return data.memories.length !== before;
  }

  private async read(): Promise<PersonalMemoryFile> {
    if (this.cached) return this.cached;
    try {
      const data = await readJsonFile<Partial<PersonalMemoryFile>>(this.filePath);
      this.cached = { memories: Array.isArray(data.memories) ? data.memories : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.cached = { memories: [] };
    }
    return this.cached;
  }

  private async write(data: PersonalMemoryFile): Promise<void> {
    this.cached = data;
    await writeJsonFile(this.filePath, data);
  }
}

export class PersonalMemoryCandidateStore {
  private cached?: PersonalMemoryCandidatesFile;

  constructor(private readonly filePath: string) {}

  async list(args: { userId?: string; status?: PersonalMemoryCandidate["status"] } = {}): Promise<PersonalMemoryCandidate[]> {
    const candidates = (await this.read()).candidates;
    return candidates.filter((candidate) =>
      (!args.userId || candidate.userId === args.userId) &&
      (!args.status || candidate.status === args.status)
    );
  }

  async get(id: string): Promise<PersonalMemoryCandidate | undefined> {
    return (await this.read()).candidates.find((candidate) => candidate.id === id);
  }

  async create(input: Omit<PersonalMemoryCandidate, "id" | "createdAt" | "updatedAt" | "status"> & { status?: PersonalMemoryCandidate["status"] }): Promise<PersonalMemoryCandidate> {
    const data = await this.read();
    const now = new Date().toISOString();
    const candidate: PersonalMemoryCandidate = {
      ...input,
      id: `cand-${randomUUID()}`,
      status: input.status ?? "pending",
      createdAt: now,
      updatedAt: now,
    };
    data.candidates.push(candidate);
    await this.write(data);
    return candidate;
  }

  async update(id: string, patch: Partial<PersonalMemoryCandidate>): Promise<PersonalMemoryCandidate | undefined> {
    const data = await this.read();
    const index = data.candidates.findIndex((candidate) => candidate.id === id);
    if (index < 0) return undefined;
    data.candidates[index] = { ...data.candidates[index]!, ...patch, id, updatedAt: new Date().toISOString() };
    await this.write(data);
    return data.candidates[index];
  }

  async remove(id: string): Promise<boolean> {
    const data = await this.read();
    const before = data.candidates.length;
    data.candidates = data.candidates.filter((candidate) => candidate.id !== id);
    await this.write(data);
    return data.candidates.length !== before;
  }

  private async read(): Promise<PersonalMemoryCandidatesFile> {
    if (this.cached) return this.cached;
    try {
      const data = await readJsonFile<Partial<PersonalMemoryCandidatesFile>>(this.filePath);
      this.cached = { candidates: Array.isArray(data.candidates) ? data.candidates : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.cached = { candidates: [] };
    }
    return this.cached;
  }

  private async write(data: PersonalMemoryCandidatesFile): Promise<void> {
    this.cached = data;
    await writeJsonFile(this.filePath, data);
  }
}
