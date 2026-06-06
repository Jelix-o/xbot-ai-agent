import OpenAI from "openai";

import type {
  AiReply,
  AiHealthStatus,
  ConversationTurn,
  MessageImageInput,
  PersonalKnowledgeEntry,
  PersonalMemory,
  PersonalMemoryCandidate,
  SkillDefinition,
} from "../types.js";

export interface ExtractPersonalMemoryArgs {
  userId: string;
  messages: Array<{ text: string; timestamp: string }>;
  existingMemories: PersonalMemory[];
}

export interface AiRuntimeConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

type ConfigProvider = () => Promise<AiRuntimeConfig> | AiRuntimeConfig;

export class AiService {
  private healthCache?: AiHealthStatus;

  constructor(baseUrl: string, apiKey: string, model: string);
  constructor(configProvider: ConfigProvider);
  constructor(
    private readonly baseUrlOrProvider: string | ConfigProvider,
    private readonly apiKey?: string,
    private readonly model?: string,
  ) {}

  async getRuntimeConfig(): Promise<AiRuntimeConfig> {
    if (typeof this.baseUrlOrProvider === "function") {
      return await this.baseUrlOrProvider();
    }
    return {
      baseUrl: this.baseUrlOrProvider,
      apiKey: this.apiKey ?? "",
      model: this.model ?? "",
    };
  }

  async generateReply(args: {
    userId: string;
    skill: SkillDefinition;
    history: ConversationTurn[];
    userInput: string;
    images?: MessageImageInput[];
    memories?: PersonalMemory[];
    knowledgeHits?: PersonalKnowledgeEntry[];
  }): Promise<AiReply> {
    const config = await this.getRuntimeConfig();
    const messages = buildChatMessages(args);
    const response = await this.createClient(config).chat.completions.create({
      model: config.model,
      temperature: args.skill.temperature,
      messages,
    });
    return {
      text: response.choices[0]?.message?.content?.trim() || "我刚刚没有生成有效回复，你再说一遍。",
      model: config.model,
      skillId: args.skill.id,
    };
  }

  async extractPersonalMemoryCandidates(args: ExtractPersonalMemoryArgs): Promise<Array<Pick<PersonalMemoryCandidate, "type" | "title" | "content" | "confidence">>> {
    if (args.messages.length === 0) return [];
    const config = await this.getRuntimeConfig();
    const existing = args.existingMemories
      .filter((memory) => memory.enabled)
      .slice(0, 20)
      .map((memory) => `- ${memory.title}: ${memory.content}`)
      .join("\n");
    const transcript = args.messages.map((message) => `[${message.timestamp}] ${message.text}`).join("\n");
    const response = await this.createClient(config).chat.completions.create({
      model: config.model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "你是个人长期记忆提取器。只提取稳定、长期、有助于未来个性化服务的信息。",
            "不要把玩笑、临时情绪、一次性安排、命令文本、无明确归属的信息写成记忆。",
            "返回 JSON: {\"candidates\":[{\"type\":\"personal_profile|personal_fact\",\"title\":\"...\",\"content\":\"...\",\"confidence\":0.0}]}",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `QQ userId: ${args.userId}`,
            "Existing memories:",
            existing || "(none)",
            "Recent private chat:",
            transcript,
          ].join("\n\n"),
        },
      ],
    });
    return normalizeMemoryExtraction(response.choices[0]?.message?.content ?? "");
  }

  async summarizePersonalProfile(args: { userId: string; memories: PersonalMemory[] }): Promise<string> {
    const enabled = args.memories.filter((memory) => memory.enabled);
    if (enabled.length === 0) return "暂时没有足够的长期记忆生成个人画像。";
    const config = await this.getRuntimeConfig();
    const response = await this.createClient(config).chat.completions.create({
      model: config.model,
      temperature: 0.3,
      messages: [
        { role: "system", content: "把用户长期记忆汇总成一段清晰、克制、实用的中文个人画像。不要编造。" },
        { role: "user", content: enabled.map((memory) => `- ${memory.title}: ${memory.content}`).join("\n") },
      ],
    });
    return response.choices[0]?.message?.content?.trim() || "个人画像生成失败。";
  }

  async checkHealth(options: { refresh?: boolean } = {}): Promise<AiHealthStatus> {
    if (!options.refresh && this.healthCache && Date.now() - new Date(this.healthCache.checkedAt).getTime() < 60_000) {
      return { ...this.healthCache, cached: true };
    }
    const config = await this.getRuntimeConfig();
    const started = Date.now();
    try {
      await this.createClient(config).chat.completions.create({
        model: config.model,
        temperature: 0,
        max_tokens: 8,
        messages: [{ role: "user", content: "ping" }],
      });
      this.healthCache = {
        ok: true,
        detail: "model connection ok",
        model: config.model,
        baseUrl: config.baseUrl,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      this.healthCache = {
        ok: false,
        detail: (error as Error).message,
        model: config.model,
        baseUrl: config.baseUrl,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
      };
    }
    return this.healthCache;
  }

  private createClient(config: AiRuntimeConfig): OpenAI {
    return new OpenAI({ baseURL: config.baseUrl, apiKey: config.apiKey });
  }
}

function buildChatMessages(args: {
  userId: string;
  skill: SkillDefinition;
  history: ConversationTurn[];
  userInput: string;
  images?: MessageImageInput[];
  memories?: PersonalMemory[];
  knowledgeHits?: PersonalKnowledgeEntry[];
}): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const style = args.skill.styleRules.map((rule) => `- ${rule}`).join("\n");
  const knowledge = args.skill.knowledge.map((item) => `- ${item}`).join("\n");
  const source = args.skill.sourceSkillLines?.length
    ? ["Original source skill content:", ...args.skill.sourceSkillLines].join("\n")
    : "";
  const memory = (args.memories ?? [])
    .filter((item) => item.enabled)
    .slice(0, 30)
    .map((item) => `- ${item.title}: ${item.content}`)
    .join("\n");
  const personalKnowledge = (args.knowledgeHits ?? [])
    .filter((item) => item.enabled)
    .map((item) => `- Q: ${item.question}\n  A: ${item.answer}`)
    .join("\n");
  const system = [
    args.skill.systemPrompt,
    style ? `Style rules:\n${style}` : "",
    knowledge ? `Skill knowledge:\n${knowledge}` : "",
    source,
    "Private chat behavior:",
    "- You are talking one-to-one with the QQ user.",
    "- Do not mention groups, group members, or @ behavior unless the user asks about them.",
    "- Use the personal memories only as context; do not reveal raw memory metadata.",
    `Runtime userId: ${args.userId}`,
    memory ? `Approved personal memory:\n${memory}` : "",
    personalKnowledge ? `Matched personal knowledge:\n${personalKnowledge}` : "",
  ].filter(Boolean).join("\n\n");

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [{ role: "system", content: system }];
  for (const turn of args.history) {
    messages.push({ role: turn.role, content: turn.content });
  }
  const imageParts = (args.images ?? []).map((image) => image.summary || image.url || image.file).filter(Boolean).join("\n");
  messages.push({
    role: "user",
    content: imageParts ? `${args.userInput}\n\nImages:\n${imageParts}` : args.userInput,
  });
  return messages;
}

function normalizeMemoryExtraction(raw: string): Array<Pick<PersonalMemoryCandidate, "type" | "title" | "content" | "confidence">> {
  try {
    const parsed = JSON.parse(raw) as { candidates?: unknown[] };
    if (!Array.isArray(parsed.candidates)) return [];
    return parsed.candidates.flatMap((item) => {
      const candidate = item as Partial<PersonalMemoryCandidate>;
      const title = candidate.title?.trim();
      const content = candidate.content?.trim();
      const confidence = typeof candidate.confidence === "number" ? candidate.confidence : 0;
      if (!title || !content) return [];
      return [{
        type: candidate.type === "personal_fact" ? "personal_fact" : "personal_profile",
        title: title.slice(0, 80),
        content: content.slice(0, 1000),
        confidence: Math.max(0, Math.min(1, confidence)),
      }];
    });
  } catch {
    return [];
  }
}
