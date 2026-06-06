import { createServer, type IncomingMessage } from "node:http";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import WebSocket, { RawData, WebSocketServer } from "ws";

import { logInfo, logWarn } from "./logger.js";
import type { MessageSegment, NapcatPrivateMessageEvent, TransportHealthStatus } from "./types.js";

interface NapCatReverseServerOptions {
  host: string;
  port: number;
  path: string;
  accessToken?: string;
}

interface NapCatActionResponse<TData = unknown> {
  status?: string;
  retcode?: number;
  data?: TData;
  echo?: string;
}

export class NapCatReverseServer extends EventEmitter<{ privateMessage: [NapcatPrivateMessageEvent] }> {
  private readonly httpServer = createServer((_req, res) => {
    res.statusCode = 200;
    res.end("XBot private reverse ws server is running.");
  });
  private readonly wsServer = new WebSocketServer({ noServer: true });
  private activeSocket?: WebSocket;
  private readonly pendingActions = new Map<
    string,
    {
      resolve: (response: NapCatActionResponse<unknown>) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(private readonly options: NapCatReverseServerOptions) {
    super();
  }

  start(): void {
    this.httpServer.on("upgrade", (req, socket, head) => {
      if (extractPathname(req) !== this.options.path) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      if (!this.isAuthorized(req)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wsServer.handleUpgrade(req, socket, head, (ws) => {
        this.wsServer.emit("connection", ws, req);
      });
    });

    this.wsServer.on("connection", (ws) => {
      this.activeSocket = ws;
      logInfo("NapCat private reverse WebSocket connected.");
      ws.on("message", (data: RawData) => this.handleIncomingMessage(data.toString()));
      ws.on("close", () => {
        if (this.activeSocket === ws) this.activeSocket = undefined;
        this.rejectPendingActions(new Error("NapCat reverse WebSocket closed."));
        logWarn("NapCat private reverse WebSocket closed.");
      });
    });

    this.httpServer.listen(this.options.port, this.options.host, () => {
      logInfo("XBot private reverse WebSocket server listening.", {
        host: this.options.host,
        port: this.options.port,
        path: this.options.path,
      });
    });
  }

  close(): void {
    this.rejectPendingActions(new Error("NapCat reverse WebSocket server stopped."));
    this.activeSocket?.close();
    this.wsServer.close();
    this.httpServer.close();
  }

  async sendPrivateMessage(userId: string, text: string): Promise<void> {
    await this.dispatchAction("send_private_msg", {
      user_id: Number(userId),
      message: text,
    });
  }

  async sendPrivateRecord(userId: string, recordFile: string): Promise<void> {
    await this.dispatchAction("send_private_msg", {
      user_id: Number(userId),
      message: [
        {
          type: "record",
          data: { file: normalizeRecordFile(recordFile) },
        },
      ] satisfies MessageSegment[],
    });
  }

  async getHealthStatus(): Promise<TransportHealthStatus> {
    const connected = this.activeSocket?.readyState === WebSocket.OPEN;
    return {
      ok: connected,
      detail: connected
        ? `reverse WebSocket connected at ${this.options.host}:${this.options.port}${this.options.path}`
        : `reverse WebSocket waiting at ${this.options.host}:${this.options.port}${this.options.path}`,
    };
  }

  private handleIncomingMessage(raw: string): void {
    try {
      const parsed = JSON.parse(raw) as Partial<NapcatPrivateMessageEvent> & NapCatActionResponse<unknown>;
      if (parsed.echo && this.pendingActions.has(parsed.echo)) {
        const pending = this.pendingActions.get(parsed.echo);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingActions.delete(parsed.echo);
        if (parsed.retcode) {
          pending.reject(new Error(`NapCat action failed with retcode ${parsed.retcode} (${parsed.status ?? "unknown"})`));
        } else {
          pending.resolve(parsed);
        }
        return;
      }

      if (parsed.post_type !== "message" || parsed.message_type !== "private") return;
      this.emit("privateMessage", parsed as NapcatPrivateMessageEvent);
    } catch {
      logWarn("Failed to parse reverse WebSocket event.");
    }
  }

  private async dispatchAction(action: string, payload: Record<string, unknown>): Promise<void> {
    await this.callAction(action, payload);
  }

  private async callAction<TData>(action: string, payload: Record<string, unknown>): Promise<NapCatActionResponse<TData>> {
    const socket = this.ensureSocketOpen();
    const echo = randomUUID();
    const request = { action, params: payload, echo };
    const response = await new Promise<NapCatActionResponse<TData>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingActions.delete(echo);
        reject(new Error(`NapCat action timed out: ${action}`));
      }, 15000);
      this.pendingActions.set(echo, {
        resolve: (value) => resolve(value as NapCatActionResponse<TData>),
        reject,
        timer,
      });
      socket.send(JSON.stringify(request), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pendingActions.delete(echo);
        reject(error);
      });
    });
    return response;
  }

  private ensureSocketOpen(): WebSocket {
    if (!this.activeSocket || this.activeSocket.readyState !== WebSocket.OPEN) {
      throw new Error("NapCat reverse WebSocket is not connected.");
    }
    return this.activeSocket;
  }

  private rejectPendingActions(error: Error): void {
    for (const pending of this.pendingActions.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingActions.clear();
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const expected = this.options.accessToken?.trim();
    if (!expected) return true;
    const authHeader = req.headers.authorization;
    if (authHeader?.replace(/^Bearer\s+/i, "").trim() === expected) return true;
    const searchParams = new URL(req.url ?? "/", "http://localhost").searchParams;
    return searchParams.get("access_token") === expected || searchParams.get("token") === expected;
  }
}

function extractPathname(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

function normalizeRecordFile(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
