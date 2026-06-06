import type { ConversationTurn, ConversationsFile } from "../types.js";
import { readJsonFile, writeJsonFile } from "../utils/json-file.js";

export class ConversationStore {
  private cached?: ConversationsFile;

  constructor(private readonly filePath: string) {}

  async getTurns(userId: string): Promise<ConversationTurn[]> {
    return (await this.read()).conversations[userId] ?? [];
  }

  async appendDialogue(userId: string, turns: ConversationTurn[], maxTurns: number): Promise<void> {
    const data = await this.read();
    data.conversations[userId] = [...(data.conversations[userId] ?? []), ...turns].slice(-maxTurns);
    await this.write(data);
  }

  async clearUser(userId: string): Promise<void> {
    const data = await this.read();
    delete data.conversations[userId];
    await this.write(data);
  }

  private async read(): Promise<ConversationsFile> {
    if (this.cached) return this.cached;
    try {
      const data = await readJsonFile<Partial<ConversationsFile>>(this.filePath);
      this.cached = { conversations: data.conversations && typeof data.conversations === "object" ? data.conversations : {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.cached = { conversations: {} };
    }
    return this.cached;
  }

  private async write(data: ConversationsFile): Promise<void> {
    this.cached = data;
    await writeJsonFile(this.filePath, data);
  }
}
