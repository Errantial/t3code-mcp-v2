/** Effect RPC's framed JSON protocol used by T3's /ws endpoint (not JSON-RPC). */
export class T3Rpc {
  private socket?: WebSocket;
  private connecting?: Promise<WebSocket>;
  private nextId = 0;
  private idle?: ReturnType<typeof setTimeout>;
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
      onChunk?: (values: unknown[]) => void;
    }
  >();

  constructor(
    private origin: string,
    private ticket: () => Promise<string>,
  ) {}

  private async connect(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const url = new URL("/ws", this.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("orchestrationProtocol", "2");
      url.searchParams.set("wsTicket", await this.ticket());
      return await new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(url);
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error("T3 WebSocket connection timed out"));
        }, 10_000);
        socket.addEventListener("open", () => {
          clearTimeout(timer);
          this.socket = socket;
          resolve(socket);
        });
        socket.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("T3 WebSocket connection failed"));
        });
        socket.addEventListener("close", () => {
          clearTimeout(timer);
          const current = this.socket === socket;
          if (current) this.socket = undefined;
          reject(new Error("T3 WebSocket closed before connection completed"));
          if (!current) return;
          for (const [id, request] of this.pending) {
            if (request.timer) clearTimeout(request.timer);
            request.reject(
              new Error(
                "T3 connection lost; command outcome may be unknown. Read thread state before retrying.",
              ),
            );
            this.pending.delete(id);
          }
        });
        socket.addEventListener("message", (event) => {
          try {
            const decoded = JSON.parse(String(event.data));
            for (const message of Array.isArray(decoded)
              ? decoded
              : [decoded]) {
              if (message._tag === "Ping") {
                socket.send(JSON.stringify({ _tag: "Pong" }));
                continue;
              }
              if (message._tag === "Chunk") {
                const request = this.pending.get(String(message.requestId));
                if (!request?.onChunk) continue;
                const values = Array.isArray(message.values)
                  ? message.values
                  : message.values === undefined
                    ? []
                    : [message.values];
                try {
                  request.onChunk(values as unknown[]);
                } catch (error) {
                  this.pending.delete(String(message.requestId));
                  request.reject(
                    error instanceof Error ? error : new Error(String(error)),
                  );
                }
                continue;
              }
              if (message._tag !== "Exit") continue;
              const id = String(message.requestId);
              const request = this.pending.get(id);
              if (!request) continue;
              if (request.timer) clearTimeout(request.timer);
              this.pending.delete(id);
              if (message.exit?._tag === "Success")
                request.resolve(message.exit.value);
              else
                request.reject(
                  new Error(
                    `T3 RPC failed: ${JSON.stringify(message.exit?.cause ?? message.exit).slice(0, 2000)}`,
                  ),
                );
              this.scheduleIdle();
            }
          } catch {
            this.close(new Error("T3 sent an invalid RPC frame"));
          }
        });
      });
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private scheduleIdle() {
    clearTimeout(this.idle);
    if (this.pending.size === 0)
      this.idle = setTimeout(() => this.close(), 5000).unref();
  }

  async call<T>(tag: string, payload: unknown, timeoutMs = 30_000): Promise<T> {
    clearTimeout(this.idle);
    const socket = await this.connect();
    const id = String(++this.nextId);
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `T3 RPC ${tag} timed out; command outcome may be unknown. Read state before retrying.`,
          ),
        );
        this.scheduleIdle();
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        socket.send(
          JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }),
        );
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("T3 RPC send failed; command outcome may be unknown"));
        this.scheduleIdle();
      }
    });
  }

  /**
   * Subscribe to an Effect RPC stream. The promise resolves when T3 ends the
   * stream and rejects if the socket closes. Chunks are delivered in order.
   * No timeout is applied: streams intentionally outlive one request.
   */
  async stream(
    tag: string,
    payload: unknown,
    onChunk: (values: unknown[]) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    clearTimeout(this.idle);
    const socket = await this.connect();
    if (signal?.aborted) throw new Error("MCP request cancelled");
    const id = String(++this.nextId);
    return await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
        this.scheduleIdle();
      };
      const abort = () => {
        if (!this.pending.delete(id)) return;
        finish(new Error("MCP request cancelled"));
      };
      this.pending.set(id, {
        resolve: () => finish(),
        reject: (error) => finish(error),
        onChunk,
      });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        socket.send(
          JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }),
        );
      } catch {
        this.pending.delete(id);
        finish(new Error("T3 RPC send failed; command outcome may be unknown"));
      }
    });
  }

  close(error = new Error("T3 RPC client closed")) {
    clearTimeout(this.idle);
    const socket = this.socket;
    this.socket = undefined;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    socket?.close();
  }
}
