import { mkdir, appendFile, readFile } from "node:fs/promises";
import path from "node:path";

export interface AdminOperationLogEntry {
  time: string;
  actorUserId: string;
  action: string;
  targetUserId?: string;
  detail?: string;
}

export class AdminOperationLogService {
  constructor(private readonly filePath: string) {}

  async record(input: Omit<AdminOperationLogEntry, "time">): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify({ ...input, time: new Date().toISOString() })}\n`, "utf8");
  }

  async list(limit = 50): Promise<AdminOperationLogEntry[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return raw.trim().split(/\r?\n/)
        .filter(Boolean)
        .slice(-limit)
        .reverse()
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as AdminOperationLogEntry];
          } catch {
            return [];
          }
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
