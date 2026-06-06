import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";

export interface TtsRuntimeConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

type TtsConfigProvider = () => Promise<TtsRuntimeConfig> | TtsRuntimeConfig;

export class TtsService {
  constructor(
    configProvider: TtsConfigProvider,
    voice: string,
    audioFormat: "wav" | "mp3" | "pcm" | "pcm16",
    cacheDir: string,
  );
  constructor(
    baseUrl: string,
    apiKey: string,
    model: string,
    voice: string,
    audioFormat: "wav" | "mp3" | "pcm" | "pcm16",
    cacheDir: string,
  );
  constructor(
    private readonly baseUrlOrProvider: string | TtsConfigProvider,
    private readonly first: string,
    private readonly second: string,
    private readonly third: string,
    private readonly fourth?: "wav" | "mp3" | "pcm" | "pcm16",
    private readonly fifth?: string,
  ) {}

  async synthesize(text: string): Promise<string> {
    const config = await this.getRuntimeConfig();
    const voice = this.getVoice();
    const audioFormat = this.getAudioFormat();
    const cacheDir = this.getCacheDir();
    await mkdir(cacheDir, { recursive: true });
    const response = await new OpenAI({ baseURL: config.baseUrl, apiKey: config.apiKey }).audio.speech.create({
      model: config.model,
      voice,
      input: text,
      response_format: audioFormat === "pcm16" ? "pcm" : audioFormat,
    });
    const arrayBuffer = await response.arrayBuffer();
    const filePath = path.join(cacheDir, `tts-${Date.now()}.${audioFormat === "pcm16" ? "pcm" : audioFormat}`);
    await writeFile(filePath, Buffer.from(arrayBuffer));
    return filePath;
  }

  private async getRuntimeConfig(): Promise<TtsRuntimeConfig> {
    if (typeof this.baseUrlOrProvider === "function") {
      return await this.baseUrlOrProvider();
    }
    return {
      baseUrl: this.baseUrlOrProvider,
      apiKey: this.first,
      model: this.second,
    };
  }

  private getVoice(): string {
    return typeof this.baseUrlOrProvider === "function" ? this.first : this.third;
  }

  private getAudioFormat(): "wav" | "mp3" | "pcm" | "pcm16" {
    return typeof this.baseUrlOrProvider === "function"
      ? this.second as "wav" | "mp3" | "pcm" | "pcm16"
      : this.fourth ?? "wav";
  }

  private getCacheDir(): string {
    return typeof this.baseUrlOrProvider === "function" ? this.third : this.fifth ?? path.join(process.cwd(), "data", "tts-cache");
  }
}
