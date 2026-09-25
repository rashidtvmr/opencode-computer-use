#!/usr/bin/env node

import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { createContext } from "node:vm";
import { assertSandboxCode, createSandboxBridge, hardenSandboxContext, sanitizeSandboxContext } from "./sandbox.mjs";
import { backendEnvironment, resolveBackend } from "./backend.js";
import { optionsFromEnvironment } from "./options.js";
import { boundToolResult, createOutputCollector, normalizeImage, normalizeNativeImage, outputLimits } from "./output.mjs";
import { JsonLinePeer } from "./json-line-peer.mjs";

export { JsonLinePeer };

const require = createRequire(import.meta.url);
// The js call whose code is running. Timers and promises carry it, so a callback
// scheduled by a finished call still names that call, not the one running now.
const evaluationOwner = new AsyncLocalStorage();
const repl = require("node:repl");
const { PassThrough } = require("node:stream");

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_CODE_CHARS = 200_000;
const MAX_INPUT_LINE_BYTES = 1 * 1024 * 1024;
const SERVER_INSTRUCTIONS = `UI automation through a persistent JavaScript REPL using the initialized cua API.

On the first call after startup or js_reset, bind the requested app with await cua.getApp("Example App"), or call await cua.getState() only when an app inventory is actually needed. App bindings persist across js calls. Batch deterministic actions and the resulting getAXState() in one js call, then verify the returned UI state. Use nodeRepl.write(value) for additional text and await nodeRepl.emitImage(image) for additional images. Ask the user before destructive or externally visible actions such as sending, deleting, or purchasing.`;

function jsDescription(timeoutMs = DEFAULT_TIMEOUT_MS, safetyMode = "full") {
  const safetyNote = safetyMode === "read-only"
    ? " This session is read-only; mutating CUA methods are disabled."
    : "";
  return `Run JavaScript in a persistent Node.js REPL with top-level await and an initialized asynchronous cua API for Open Computer Use. Use this for all desktop interactions. Bind an app with let app = await cua.getApp("Example App"); then call await app.click(...), await app.typeText(...), and await app.getAXState(). Top-level bindings persist until js_reset, so prefer top-level var for names that may be assigned again. Batch deterministic actions and the resulting state read in one call to reduce round trips. Use nodeRepl.write(value) for extra text and await nodeRepl.emitImage(image) for extra images. If timeout_ms is omitted, execution times out after ${timeoutMs} ms.${safetyNote}`;
}

const RESET_DESCRIPTION = `Reset the persistent Open Computer Use JavaScript session and discard all bindings created by prior js calls. The next js call starts with a freshly initialized cua API. This does not close native apps or erase their state.`;

const COMPUTER_USE_GUIDANCE = `## Open Computer Use JavaScript API

The runtime exposes an asynchronous app-bound API:

- \`await cua.getState({ emit? })\`: list current apps.
- \`await cua.listApps({ emit? })\`: list current apps.
- \`await cua.getApp(nameOrBundleID)\`: bind an app and emit its initial accessibility state.
- \`await app.getAXState({ emit?, textLimit?, maxTreeNodes?, maxTreeDepth? })\`
- \`await app.getScreenshot({ emit? })\`
- \`await app.getAXStateAndScreenshot(options?)\`
- \`await app.click(elementIndexOrPoint, { mouseButton?, clickCount?, clickMethod? })\`
- \`await app.scroll(elementIndex, direction, pages?)\`
- \`await app.drag([fromX, fromY], [toX, toY])\`
- \`await app.typeText(text)\`
- \`await app.pressKey(key)\`
- \`await app.setValue(elementIndex, value)\`
- \`await app.performSecondaryAction(elementIndex, action)\`

After actions, call \`getAXState()\` in the same js invocation when the next decision depends on the updated UI. Re-derive element indexes from fresh state after navigation or layout changes. Prefer element indexes over coordinates. Open Computer Use keeps its existing local safety gates, including password-manager denial and explicit authorization for global pointer fallbacks.`;

function asError(error) {
  if (error instanceof Error) return error;
  // Errors thrown inside the REPL context come from another realm and fail instanceof.
  return new Error(typeof error?.message === "string" ? error.message : String(error));
}

function safeErrorMessage(error) {
  return asError(error).message
    .replace(/\b(token|secret|password|api[_-]?key|authorization)\s*[:=]\s*(?:bearer|basic)?[^\n\r,;]*/giu, "$1=[redacted]")
    .slice(0, 4_000);
}

function toolResultText(result) {
  return (result?.content ?? []).filter(item => item?.type === "text").map(item => item.text ?? "").filter(Boolean).join("\n");
}

function toolResultImages(result) {
  return (result?.content ?? []).filter(item => item?.type === "image" && typeof item.data === "string");
}

function parseListAppMarkers(markers) {
  const app = {};
  for (const marker of markers.split(/,\s*/)) {
    if (marker === "running") app.isRunning = true;
    else if (marker.startsWith("last-used=")) app.lastUsedDate = marker.slice("last-used=".length);
    else if (marker.startsWith("uses=")) {
      const useCount = Number.parseInt(marker.slice("uses=".length), 10);
      if (Number.isSafeInteger(useCount)) app.useCount = useCount;
    }
  }
  return app;
}

// The native compatibility surface intentionally returns human-readable text.
// Normalize its macOS (em dash) and Linux/Windows (double hyphen) renderings
// into the stable code-first shape used by cua.listApps(). Unknown lines are
// retained as display names rather than making discovery fail completely.
export function parseListApps(text) {
  if (!text.trim() || /^No running top-level apps are visible/u.test(text.trim())) return [];
  return text.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    const match = /^(.*?)\s+(?:\u2014|--|-)\s+(.+?)\s+\[([^\]]*)\]$/u.exec(trimmed);
    if (!match) return { id: trimmed, displayName: trimmed };
    return { id: match[2], displayName: match[1], ...parseListAppMarkers(match[3]) };
  }).filter(app => app.id);
}

function optionsToSnapshotArgs(options = {}) {
  const args = {};
  if (options.textLimit !== undefined) args.text_limit = options.textLimit;
  if (options.maxTreeNodes !== undefined) args.max_tree_nodes = options.maxTreeNodes;
  if (options.maxTreeDepth !== undefined) args.max_tree_depth = options.maxTreeDepth;
  return args;
}

function optionsToClickArgs(options = {}) {
  const args = {};
  if (options.mouseButton !== undefined) args.mouse_button = options.mouseButton;
  if (options.clickCount !== undefined) args.click_count = options.clickCount;
  if (options.clickMethod !== undefined) args.click_method = options.clickMethod;
  return args;
}

export function createCuaApi(native, activeOutput, assertActive = () => {}) {
  let docsEmitted = false;
  async function call(tool, args = {}) {
    assertActive();
    const result = await native.request("tools/call", { name: tool, arguments: args });
    if (result?.isError) throw new Error(toolResultText(result) || `${tool} failed`);
    return result;
  }
  async function emitText(text, options = {}) {
    if (options.emit === false || !text) return;
    activeOutput().write(text, "cua.state");
  }
  async function emitImages(images, options = {}) {
    if (options.emit === false) return;
    for (const image of images) await activeOutput().emitImage({ bytes: Buffer.from(image.data, "base64"), mimeType: image.mimeType ?? "image/png" });
  }
  async function emitDocs() {
    if (docsEmitted) return;
    activeOutput().write(COMPUTER_USE_GUIDANCE, "cua.core");
    docsEmitted = true;
  }
  function appBinding(app) {
    return Object.freeze({
      async getAXState(options = {}) {
        const result = await call("get_app_state", { app, ...optionsToSnapshotArgs(options) });
        const text = toolResultText(result);
        await emitText(text, options);
        return text;
      },
      async getScreenshot(options = {}) {
        const result = await call("get_app_state", { app, text_limit: 1 });
        const image = toolResultImages(result)[0];
        if (!image) throw new Error(`Screenshot unavailable for ${app}`);
        const normalized = normalizeNativeImage(image);
        await emitImages([{ data: normalized.data, mimeType: normalized.mimeType }], options);
        return normalized.bytes;
      },
      async getAXStateAndScreenshot(options = {}) {
        const result = await call("get_app_state", { app, ...optionsToSnapshotArgs(options) });
        const state = toolResultText(result);
        const images = toolResultImages(result).map(normalizeNativeImage);
        await emitText(state, options);
        await emitImages(images, options);
        return images[0] ? { state, screenshot: images[0].bytes } : { state };
      },
      async click(target, options = {}) {
        const targetArgs = Array.isArray(target) ? { x: target[0], y: target[1] } : { element_index: target };
        await call("click", { app, ...targetArgs, ...optionsToClickArgs(options) });
      },
      async drag(from, to) { await call("drag", { app, from_x: from[0], from_y: from[1], to_x: to[0], to_y: to[1] }); },
      async pressKey(key) { await call("press_key", { app, key }); },
      async scroll(target, direction, pages = 1) {
        if (Array.isArray(target)) throw new Error("coordinate scroll is not supported by this Open Computer Use runtime");
        await call("scroll", { app, element_index: target, direction, pages });
      },
      async setValue(elementIndex, value) { await call("set_value", { app, element_index: elementIndex, value }); },
      async typeText(text) { await call("type_text", { app, text }); },
      async performSecondaryAction(elementIndex, action) { await call("perform_secondary_action", { app, element_index: elementIndex, action }); },
    });
  }
  const api = {
    async getState(options = {}) {
      await emitDocs();
      const result = await call("list_apps", {});
      const text = toolResultText(result);
      let apps;
      try {
        const parsed = JSON.parse(text);
        apps = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.apps)
            ? parsed.apps
            : parseListApps(text);
      } catch {
        apps = parseListApps(text);
      }
      if (options.emit !== false) activeOutput().write(apps, "cua.state");
      return { apps };
    },
    async listApps(options = {}) {
      await emitDocs();
      const state = await api.getState({ emit: false });
      if (options.emit !== false) activeOutput().write(state.apps, "cua.state");
      return state.apps;
    },
    async getApp(app) {
      await emitDocs();
      const result = await call("get_app_state", { app, text_limit: "max" });
      await emitText(toolResultText(result));
      return appBinding(app);
    },
    async rewriteDocumentation() { activeOutput().write(COMPUTER_USE_GUIDANCE, "cua.core"); },
  };
  return Object.freeze(api);
}


export class PersistentJavaScriptSession {
  constructor({ native, limits = {}, safetyMode = "full", appAccess = {} }) {
    this.native = native;
    this.limits = outputLimits(limits);
    this.safetyMode = safetyMode;
    this.appAccess = appAccess;
    this.active = null;
    this.reset();
  }

  #currentOutput() {
    const owner = evaluationOwner.getStore();
    if (!owner || owner !== this.active) throw new Error("nodeRepl output is only available while js is executing");
    return owner;
  }

  reset() {
    if (this.active?.timers) {
      for (const timer of this.active.timers) clearTimeout(timer);
      this.active.timers.clear();
    }
    this.active = null;
    this.repl?.close();
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    this.context = createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false },
      importModuleDynamically: async () => {
        throw new Error("dynamic import is disabled in the CUA sandbox");
      },
    });
    // A throw inside evaluated code (sync, or after an await) never reaches the eval
    // callback: the REPL prints it and moves on. Settle the evaluation from the REPL's
    // error path instead (`handleError` on Node 26, a domain on Node 22), but only the
    // call that threw: a late throw from a finished call is dropped, as the REPL would.
    const settle = error => {
      const owner = evaluationOwner.getStore();
      if (owner && owner === this.active) owner.reject(error);
      return "ignore";
    };
    this.repl = repl.start({
      prompt: "",
      input,
      output,
      terminal: false,
      useGlobal: false,
      ignoreUndefined: true,
      breakEvalOnSigint: true,
      handleError: settle,
      context: this.context,
    });
    this.repl.on("error", () => {});
    this.repl._domain?.on("error", settle);
    this.context = this.repl.context;
    sanitizeSandboxContext(this.context);
    hardenSandboxContext(this.context);
    const activeOutput = () => this.#currentOutput();
    const isActive = () => this.active !== null && evaluationOwner.getStore() === this.active;
    const schedule = (callback, delay) => {
      const owner = this.active;
      if (!owner) return -1;
      const timer = setTimeout(() => {
        owner.timers.delete(timer);
        if (this.active === owner) callback();
      }, delay);
      owner.timers.add(timer);
      return timer;
    };
    const cancel = timer => {
      if (timer === -1) return;
      clearTimeout(timer);
      this.active?.timers.delete(timer);
    };
    createSandboxBridge(
      createCuaApi(this.native, activeOutput, isActive),
      this.context,
      activeOutput,
      isActive,
      schedule,
      cancel,
      { safetyMode: this.safetyMode, appAccess: this.appAccess },
    );
    this.nodeRepl = this.context.nodeRepl;
    this.cua = this.context.cua;
  }

  async run(code, timeoutMs = DEFAULT_TIMEOUT_MS, requestMeta = {}) {
    if (typeof code !== "string" || !code.trim()) throw new Error("js expects non-empty JavaScript source");
    assertSandboxCode(code);
    const output = createOutputCollector(this.limits);
    const active = {
      ...output,
      timers: new Set(),
      reject: undefined,
    };
    this.active = active;
    this.requestMeta = requestMeta;
    let timer;
    const enforceTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
    try {
      const evaluation = new Promise((resolve, reject) => {
        active.reject = reject;
        evaluationOwner.run(active, () => this.repl.eval(code, this.repl.context, "open-computer-use-repl", (error, result) => error ? reject(error) : resolve(result)));
      });
      const value = enforceTimeout
        ? await Promise.race([evaluation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`js execution timed out after ${timeoutMs} ms; session reset`)), timeoutMs); })])
        : await evaluation;
      if (output.content.length === 0) output.write("(no output)");
      return { content: output.content, isError: false };
    } catch (error) {
      const message = asError(error).message;
      if (message.includes("timed out")) this.reset();
      output.write(`Error: ${message}`);
      return { content: output.content, isError: true };
    } finally {
      clearTimeout(timer);
      for (const scheduled of active.timers) clearTimeout(scheduled);
      active.timers.clear();
      if (this.active === active) this.active = null;
    }
  }
}

// Production isolation boundary. JavaScript runs in a worker so a CPU-bound
// loop can be terminated without hanging the MCP transport. Native tool calls
// are brokered back to the parent and still execute serially in the native MCP.
export class WorkerJavaScriptSession {
  constructor({ native, limits = {}, safetyMode = "full", appAccess = {} }) {
    this.native = native;
    this.limits = outputLimits(limits);
    this.safetyMode = safetyMode;
    this.appAccess = appAccess;
    this.workerData = { ...this.limits, safetyMode: this.safetyMode, appAccess: this.appAccess };
    this.nextId = 1;
    this.activeRequestId = null;
    this.pending = new Map();
    this.runQueue = Promise.resolve();
    this.#start();
  }

  #start() {
    const worker = new Worker(new URL("./repl-kernel.mjs", import.meta.url), {
      execArgv: ["--experimental-repl-await"],
      workerData: this.workerData,
    });
    this.worker = worker;
    worker.on("message", message => void this.#onMessage(worker, message));
    worker.on("error", error => this.#failWorker(worker, error));
    worker.on("exit", code => { if (code !== 0) this.#failWorker(worker, new Error(`JavaScript kernel exited with code ${code}`)); });
  }

  async #onMessage(worker, message) {
    if (message.type === "result") {
      const pending = this.pending.get(message.id);
      if (!pending || pending.worker !== worker) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (this.activeRequestId === message.id) this.activeRequestId = null;
      pending.resolve(message.result);
      return;
    }
    if (message.type === "native_request") {
      if (message.requestId !== this.activeRequestId || this.activeRequestId === null) {
        if (this.worker === worker) worker.postMessage({ type: "native_response", id: message.id, error: "native request is no longer active" });
        return;
      }
      try {
        const result = await this.native.request(message.method, message.params, message.timeoutMs);
        if (this.worker === worker) worker.postMessage({ type: "native_response", id: message.id, result });
      } catch (error) {
        if (this.worker === worker) worker.postMessage({ type: "native_response", id: message.id, error: safeErrorMessage(error) });
      }
    }
  }

  #failWorker(worker, error) {
    if (this.worker === worker) this.activeRequestId = null;
    for (const [id, pending] of this.pending) {
      if (pending.worker !== worker) continue;
      clearTimeout(pending.timer);
      pending.resolve({ content: [{ type: "text", text: `Error: ${safeErrorMessage(error)}` }], isError: true });
      this.pending.delete(id);
    }
  }

  async reset() {
    this.activeRequestId = null;
    const old = this.worker;
    this.#failWorker(old, new Error("JavaScript session reset"));
    await old.terminate();
    if (this.worker === old) this.#start();
  }

  async close() {
    this.activeRequestId = null;
    const old = this.worker;
    this.#failWorker(old, new Error("JavaScript session closed"));
    await old.terminate();
  }

  run(code, timeoutMs = DEFAULT_TIMEOUT_MS, requestMeta = {}) {
    const queued = this.runQueue.then(() => this.#run(code, timeoutMs, requestMeta));
    this.runQueue = queued.catch(() => {});
    return queued;
  }

  #run(code, timeoutMs, requestMeta) {
    const id = this.nextId++;
    return new Promise(resolve => {
      const worker = this.worker;
      this.activeRequestId = id;
      const timer = setTimeout(async () => {
        const pending = this.pending.get(id);
        if (!pending || pending.worker !== worker) return;
        this.pending.delete(id);
        if (this.activeRequestId === id) this.activeRequestId = null;
        await worker.terminate();
        if (this.worker === worker) this.#start();
        resolve({ content: [{ type: "text", text: `Error: js execution timed out after ${timeoutMs} ms; session reset` }], isError: true });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer, worker });
      try {
        worker.postMessage({ type: "exec", id, code, timeoutMs, requestMeta });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        if (this.activeRequestId === id) this.activeRequestId = null;
        resolve({ content: [{ type: "text", text: `Error: ${safeErrorMessage(error)}` }], isError: true });
      }
    });
  }
}

export function resolveNativeCommand(argv = []) {
  const separator = argv.indexOf("--");
  if (separator >= 0) {
    const command = argv[separator + 1];
    if (!command) throw new Error("expected native MCP command after --");
    return { command, args: argv.slice(separator + 2) };
  }
  return resolveBackend({}, process.env);
}

function isJsonRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validRpcId(value) {
  return (typeof value === "string" && value.length <= 128) || (typeof value === "number" && Number.isFinite(value));
}

function parseRpcRequest(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return { error: { id: null, code: -32700, message: "Invalid JSON-RPC payload" } };
  }
  const id = isJsonRecord(value) && validRpcId(value.id) ? value.id : null;
  if (!isJsonRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string" || value.method.length === 0 || value.method.length > 256 || (value.id !== undefined && !validRpcId(value.id)) || (value.params !== undefined && (value.params === null || typeof value.params !== "object"))) {
    return { error: { id, code: -32600, message: "Invalid JSON-RPC request" } };
  }
  return { request: value };
}

export async function runServer({ command, args }) {
  const options = optionsFromEnvironment(process.env);
  // Actions return a short status instead of a settle + full snapshot the adapter would
  // discard; state is read explicitly by getAXState(). Runtimes without the flag ignore it.
  const native = new JsonLinePeer({
    command,
    args,
    env: { ...backendEnvironment(), OPEN_COMPUTER_USE_ACTION_READ_BACK: "0" },
  });
  let session;
  let buffer = "";
  let requestQueue = Promise.resolve();
  let shuttingDown;
  let stopping = false;
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const shutdown = (reason = "server_shutdown") => {
    if (shuttingDown) return shuttingDown;
    stopping = true;
    const closeSession = session ? session.close() : Promise.resolve();
    shuttingDown = closeSession.catch(() => {}).then(async () => {
      try {
        await native.notifyAsync("notifications/turn-ended", { reason });
      } catch {
        // The native process may already be closing; local cleanup still continues.
      }
      return native.close().catch(() => {});
    });
    return shuttingDown;
  };
  const enqueue = (line) => {
    if (!line) return;
    requestQueue = requestQueue.then(() => handle(line)).catch(error => console.error(safeErrorMessage(error)));
  };
  const rejectOversizedInput = () => {
    buffer = "";
    send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request frame exceeded the input size limit" } });
    void shutdown("input_limit");
  };
  const onInput = (chunk) => {
    if (stopping) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf("\n", offset);
      const piece = newline < 0 ? chunk.slice(offset) : chunk.slice(offset, newline);
      if (Buffer.byteLength(buffer, "utf8") + Buffer.byteLength(piece, "utf8") > MAX_INPUT_LINE_BYTES) {
        rejectOversizedInput();
        return;
      }
      buffer += piece;
      if (newline < 0) return;
      enqueue(buffer.trim());
      buffer = "";
      offset = newline + 1;
    }
  };

  try {
    await native.initialize();
    session = new WorkerJavaScriptSession({
      native,
      limits: options,
      safetyMode: options.safetyMode,
      appAccess: options.appAccess,
    });
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onInput);
    process.stdin.on("error", error => {
      console.error(safeErrorMessage(error));
      void shutdown("stdin_error");
    });
  } catch (error) {
    await shutdown("startup_error");
    throw error;
  }

  async function handle(line) {
    const parsed = parseRpcRequest(line);
    if (parsed.error) {
      return send({ jsonrpc: "2.0", id: parsed.error.id, error: { code: parsed.error.code, message: parsed.error.message } });
    }
    const { id, method, params = {} } = parsed.request;
    if (id === undefined) {
      if (method === "notifications/turn-ended") {
        try { native.notify(method, params); } catch (error) { console.error(safeErrorMessage(error)); }
      }
      return;
    }
    try {
      if (method === "initialize") {
        return send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "open-computer-use-repl", version: "1" },
            instructions: SERVER_INSTRUCTIONS,
          },
        });
      }
      if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
      if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: toolDefinitions(options.timeoutMs, options) } });
      if (method === "tools/call") {
        if (!isJsonRecord(params) || typeof params.name !== "string") throw new Error("tools/call requires a tool name");
        if (params.arguments !== undefined && !isJsonRecord(params.arguments)) throw new Error("tools/call arguments must be an object");
        if (params.name === "js_reset") {
          await session.reset();
          return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Open Computer Use JavaScript session reset" }], isError: false } });
        }
        if (params.name === "js") {
          const requestedTimeoutMs = params.arguments?.timeout_ms;
          const timeoutMs = Number.isInteger(requestedTimeoutMs) && requestedTimeoutMs > 0
            ? Math.min(requestedTimeoutMs, options.timeoutMs, MAX_TIMEOUT_MS)
            : options.timeoutMs;
          const code = params.arguments?.code;
          if (typeof code !== "string" || code.length > MAX_CODE_CHARS) {
            throw new Error(`js code must be a string no longer than ${MAX_CODE_CHARS} characters`);
          }
          const title = params.arguments?.title;
          if (title !== undefined && (typeof title !== "string" || !title.trim() || title.length > 80)) {
            throw new Error("js title must be a non-empty string no longer than 80 characters");
          }
          const result = boundToolResult(await session.run(code, timeoutMs), options);
          if (title) result._meta = { ...(result._meta || {}), title: title.trim() };
          return send({ jsonrpc: "2.0", id, result });
        }
        throw new Error(`Unsupported tool: ${params.name}`);
      }
      throw new Error(`Unsupported method: ${method}`);
    } catch (error) {
      send({ jsonrpc: "2.0", id, error: { code: -32603, message: safeErrorMessage(error) } });
    }
  }

  const shutdownSignals = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of shutdownSignals) {
    process.on(signal, () => { void shutdown("signal").finally(() => process.exit(0)); });
  }
  process.stdin.on("end", () => { void requestQueue.finally(() => shutdown("stdin_closed")); });
}

export function toolDefinitions(defaultTimeoutMs = DEFAULT_TIMEOUT_MS, { safetyMode = "full" } = {}) {
  const requestedTimeout = Number.isFinite(defaultTimeoutMs) ? defaultTimeoutMs : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(Math.max(requestedTimeout, 1_000), MAX_TIMEOUT_MS);
  const readOnly = safetyMode === "read-only";
  const annotations = readOnly
    ? { destructiveHint: false, openWorldHint: false, readOnlyHint: true }
    : { destructiveHint: true, openWorldHint: true, readOnlyHint: false };
  return [
    { name: "js", description: jsDescription(timeoutMs, safetyMode), annotations, inputSchema: { type: "object", additionalProperties: false, properties: { code: { type: "string", minLength: 1, maxLength: MAX_CODE_CHARS, description: "JavaScript source to execute with top-level await and the initialized cua API." }, timeout_ms: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS, description: `Optional timeout in milliseconds. Defaults to ${timeoutMs} and is capped at 300000.` }, title: { type: "string", minLength: 1, maxLength: 80, description: "Short user-facing description of what this code is doing." } }, required: ["code"] } },
    { name: "js_reset", description: RESET_DESCRIPTION, annotations: { destructiveHint: false, openWorldHint: false, readOnlyHint: true, idempotentHint: true }, inputSchema: { type: "object", additionalProperties: false, properties: {} } },
  ];
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  runServer(resolveNativeCommand(process.argv.slice(2))).catch(error => { console.error(`open-computer-use-repl: ${safeErrorMessage(error)}`); process.exit(1); });
}
