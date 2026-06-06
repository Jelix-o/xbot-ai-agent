import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SkillDefinition } from "../types.js";

export class SkillService {
  private cachedSkills?: SkillDefinition[];

  constructor(private readonly skillsDir: string) {}

  async getAllSkills(): Promise<SkillDefinition[]> {
    if (this.cachedSkills) return this.cachedSkills;
    await mkdir(this.skillsDir, { recursive: true });
    const files = await readdir(this.skillsDir, { withFileTypes: true });
    const skills: SkillDefinition[] = [];
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(this.skillsDir, entry.name);
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<SkillDefinition>;
      skills.push(normalizeSkillDefinition(parsed));
    }
    this.cachedSkills = skills.sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
    return this.cachedSkills;
  }

  async getSkill(skillId: string): Promise<SkillDefinition | undefined> {
    return (await this.getAllSkills()).find((skill) => skill.id === skillId);
  }

  async upsertSkill(input: Partial<SkillDefinition>): Promise<SkillDefinition> {
    const skill = normalizeSkillDefinition(input);
    await mkdir(this.skillsDir, { recursive: true });
    await writeFile(path.join(this.skillsDir, `${normalizeSkillId(skill.id)}.json`), `${JSON.stringify(skill, null, 2)}\n`, "utf8");
    this.cachedSkills = undefined;
    return skill;
  }

  async removeSkill(skillId: string): Promise<boolean> {
    const safeId = normalizeSkillId(skillId);
    if (!safeId) throw new Error("invalid_skill_id");
    try {
      await rm(path.join(this.skillsDir, `${safeId}.json`));
      this.cachedSkills = undefined;
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}

export function normalizeSkillId(value: string | undefined): string {
  return value?.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "") ?? "";
}

export function normalizeSkillDefinition(input: Partial<SkillDefinition>): SkillDefinition {
  const id = normalizeSkillId(input.id);
  if (!id) throw new Error("invalid_skill_id");
  return {
    id,
    name: input.name?.trim() || id,
    systemPrompt: input.systemPrompt?.trim() || "你是一个 QQ 私聊 Agent。",
    styleRules: Array.isArray(input.styleRules) ? input.styleRules.map(String) : [],
    knowledge: Array.isArray(input.knowledge) ? input.knowledge.map(String) : [],
    sourceSkillLines: Array.isArray(input.sourceSkillLines) ? input.sourceSkillLines.map(String) : undefined,
    ttsStyleHint: input.ttsStyleHint,
    exampleExchanges: Array.isArray(input.exampleExchanges) ? input.exampleExchanges : undefined,
    temperature: typeof input.temperature === "number" ? input.temperature : 0.8,
    maxContextTurns: typeof input.maxContextTurns === "number" ? input.maxContextTurns : 16,
    maxReplyCharsPerMessage: input.maxReplyCharsPerMessage,
    maxTotalReplyChars: input.maxTotalReplyChars,
    maxReplyMessages: input.maxReplyMessages,
    preferredMaxReplyMessages: input.preferredMaxReplyMessages,
    stripAsterisks: input.stripAsterisks,
    singleSentencePerMessage: input.singleSentencePerMessage,
    stripTerminalPunctuation: input.stripTerminalPunctuation,
    respectLineBreaks: input.respectLineBreaks,
    allowBurstOnHighEmotion: input.allowBurstOnHighEmotion,
    highEmotionKeywords: Array.isArray(input.highEmotionKeywords) ? input.highEmotionKeywords.map(String) : undefined,
  };
}
