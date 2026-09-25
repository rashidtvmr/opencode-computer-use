import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import process from "node:process";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

function safeNativeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\b(token|secret|password|api[_-]?key|authorization)\s*[:=]\s*(?:bearer|basic)?[^\n\r,;]*/giu, "$1=[redacted]")
    .slice(0, 4_000);
}

export class JsonLinePeer extends EventEmitter {
  constructor({ command, args = [], cwd, env = process.env, child } = {}) {
    super();
    this.child = child ?? spawn(command, args, {
      cwd,
      env,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.pid = this.child.pid;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    this.closeError = null;
    this.closed = false;
    this.exited = false;
    this.terminationStarted = false;
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.#onData(chunk));
    this.child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk).slice(-8192); });
    this.child.once("error", (error) => this.#close(error, true));
    this.child.once("exit", (code, signal) => {
      this.exited = true;
      this.resolveExit();
      const detail = this.stderr ? `: ${safeNativeErrorMessage(new Error(this.stderr.trim()))}` : "";
      this.#close(new Error(`native MCP exited (code=${code ?? "null"}, signal=${signal ?? "null"})${detail}`));
    });
    this.child.once("close", () => {
      if (!this.exited) {
        this.exited = true;
        this.resolveExit();
      }
    });
  }

  #onData(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_FRAME_BYTES) {
      this.#close(new Error("native MCP response buffer exceeded limit"), true);
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.#close(new Error(`invalid native MCP JSON: ${line.slice(0, 200)}`), true);
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        this.#close(new Error("invalid native MCP message"), true);
        return;
      }
      if (message.id !== undefined && this.pending.has(String(message.id))) {
        const pending = this.pending.get(String(message.id));
        this.pending.delete(String(message.id));
        clearTimeout(pending.timer);
        if (message.error) {
          const messageText = typeof message.error?.message === "string" ? message.error.message : JSON.stringify(message.error);
          pending.reject(new Error(safeNativeErrorMessage(new Error(messageText))));
        } else {
          pending.resolve(message.result);
        }
      } else {
        this.emit("message", message);
      }
    }
  }

  #close(error, terminate = false) {
    if (!this.closed) {
      this.closed = true;
      this.closeError = error;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.emit("close", error);
    }
    if (terminate) void this.#terminateChild(false);
  }

  #killChild(force) {
    const signal = force ? "SIGKILL" : "SIGTERM";
    if (process.platform === "win32") {
      if (force && this.pid) {
        try {
          const killer = spawn("taskkill", ["/PID", String(this.pid), "/T", "/F"], {
            shell: false,
            windowsHide: true,
            stdio: "ignore",
          });
          killer.unref();
        } catch {
          // Fall through to the direct child termination below.
        }
      } else {
        try { this.child.kill("SIGTERM"); } catch {}
      }
      return;
    }
    if (this.pid) {
      try {
        process.kill(-this.pid, signal);
        return;
      } catch {
        // Fall through to the direct child termination below.
      }
    }
    if (!this.exited) {
      try { this.child.kill(signal); } catch {}
    }
  }

  #terminateChild(graceful = true) {
    if (this.terminationStarted) return this.exitPromise;
    this.terminationStarted = true;
    try { this.child.stdin.end(); } catch {}
    if (!graceful) this.#killChild(false);
    const gracefulTimer = graceful ? setTimeout(() => this.#killChild(false), 100) : undefined;
    const forceTimer = setTimeout(() => this.#killChild(true), 1_000);
    gracefulTimer?.unref();
    forceTimer.unref();
    return this.exitPromise.finally(() => {
      if (gracefulTimer) clearTimeout(gracefulTimer);
      clearTimeout(forceTimer);
    });
  }

  request(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.closed) {
      const detail = this.closeError ? `: ${safeNativeErrorMessage(this.closeError)}` : "";
      return Promise.reject(new Error(`native MCP is closed${detail}; restart the MCP server before trying again`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const cancelTimedOutRequest = () => {
        const key = String(id);
        if (!this.pending.has(key)) return;
        this.pending.delete(key);
        try {
          this.notify("notifications/cancelled", { requestId: id, reason: "timeout" });
        } catch {
          // The native process may already be closing; the timeout remains authoritative.
        }
        reject(new Error(`native MCP ${method} timed out after ${timeoutMs} ms; the native action may still be settling`));
      };
      const timer = timeoutMs > 0 ? setTimeout(cancelTimedOutRequest, timeoutMs) : undefined;
      this.pending.set(String(id), { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (!error) return;
        if (!this.pending.has(String(id))) return;
        if (timer) clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error);
      });
    });
  }

  notify(method, params = {}) {
    if (this.closed) return false;
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
      return true;
    } catch {
      return false;
    }
  }

  async notifyAsync(method, params = {}, timeoutMs = 250) {
    if (this.closed) return false;
    return new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = (delivered) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(delivered);
      };
      timer = setTimeout(() => finish(false), timeoutMs);
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`, (error) => finish(!error));
      } catch {
        finish(false);
      }
    });
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "open-computer-use-node-repl", version: "1" },
    });
    this.notify("notifications/initialized", {});
    return result;
  }

  async close() {
    await this.#terminateChild();
  }
}
