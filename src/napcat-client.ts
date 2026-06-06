import { EventEmitter } from "node:events";
import WebSocket, { RawData } from "ws";

import { logInfo, logWarn } from "./logger.js";
import type { MessageSegment, NapcatPrivateMessageEvent, TransportHealthStatus } from "./types.js";

interface NapCatClientOptions {
  wsUrl: string;
  accessToken?: string;
}

export class NapCatClient extends EventEmitter<{ privateMessage: [NapcatPrivateMessageEvent] }> {
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private manuallyClosed = false;

  constructor(private readonly options: NapCatClientOptions) {
    super();
  }

  start(): void {
    this.manuallyClosed = false;
    const headers = this.options.accessToken ? { Authorization: `Bearer ${this.options.accessToken}` } : undefined;
    this.socket = new WebSocket(this.options.wsUrl, { headers });
    this.socket.on("open", () => logInfo("NapCat private forward WebSocket connected."));
    this.socket.on("message", (data: RawData) => this.handleMessage(data.toString()));
    this.socket.on("close", () => {
      logWarn("NapCat private forward WebSocket closed.");
      if (!this.manuallyClosed) this.scheduleReconnect();
    });
    this.socket.on("error", (error) => logWarn("NapCat forward WebSocket error.", { error: error.message }));
  }

  close(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  async sendPrivateMessage(userId: string, text: string): Promise<void> {
    await this.dispatchAction("send_private_msg", { user_id: Number(userId), message: text });
  }

  async sendPrivateRecord(userId: string, recordFile: string): Promise<void> {
    await this.dispatchAction("send_private_msg", {
      user_id: Number(userId),
      message: [{ type: "record", data: { file: recordFile.replace(/\\/g, "/") } }] satisfies MessageSegment[],
    });
  }

  async getHealthStatus(): Promise<TransportHealthStatus> {
    const connected = this.socket?.readyState === WebSocket.OPEN;
    return {
      ok: connected,
      detail: connected ? `forward WebSocket connected to ${this.options.wsUrl}` : `forward WebSocket disconnected from ${this.options.wsUrl}`,
    };
  }

  private handleMessage(raw: string): void {
    try {
      const parsed = JSON.parse(raw) as Partial<NapcatPrivateMessageEvent>;
      if (parsed.post_type !== "message" || parsed.message_type !== "private") return;
      this.emit("privateMessage", parsed as NapcatPrivateMessageEvent);
    } catch {
      logWarn("Failed to parse forward WebSocket event.");
    }
  }

  private async dispatchAction(action: string, payload: Record<string, unknown>): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("NapCat forward WebSocket is not connected.");
    socket.send(JSON.stringify({ action, params: payload }));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.start();
    }, 3000);
  }
}
