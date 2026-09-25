import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(here);
const replPath = join(packageRoot, "bin", "opencode-computer-use-repl.js");
const nativeFixture = join(packageRoot, "test-fixtures", "fake-backend.mjs");

function startRepl(extraEnvironment = {}) {
  const child = spawn(process.execPath, [replPath], {
    env: {
      ...process.env,
      OPENCODE_COMPUTER_USE_BACKEND: "custom",
      OPENCODE_COMPUTER_USE_COMMAND: JSON.stringify([process.execPath, nativeFixture]),
      ...extraEnvironment,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const unsolicited = [];
  const responseWaiters = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    const resolve = pending.get(String(message.id));
    if (!resolve) {
      const waiter = responseWaiters.shift();
      if (waiter) waiter(message);
      else unsolicited.push(message);
      return;
    }
    pending.delete(String(message.id));
    resolve(message);
  });
  let nextId = 1;
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(String(id), resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (!pending.has(String(id))) return;
        pending.delete(String(id));
        reject(new Error(`timed out waiting for ${method}`));
      }, 5_000).unref();
    });
  return {
    child,
    request,
    sendRaw: (value) => child.stdin.write(value),
    nextResponse: () => unsolicited.length > 0
      ? Promise.resolve(unsolicited.shift())
      : new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("timed out waiting for response")), 5_000);
          timer.unref();
          responseWaiters.push((value) => {
            clearTimeout(timer);
            resolve(value);
          });
        }),
  };
}

test("OpenCode MCP surface is js and js_reset and executes cua code", async () => {
  const repl = startRepl();
  try {
    const initialize = await repl.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(initialize.result.serverInfo.name, "open-computer-use-repl");
    const list = await repl.request("tools/list");
    assert.deepEqual(list.result.tools.map((tool) => tool.name), ["js", "js_reset"]);

    const call = await repl.request("tools/call", {
      name: "js",
      arguments: {
        code: 'var apps = await cua.listApps({ emit: false }); nodeRepl.write(JSON.stringify(apps));',
        title: "Inspect available apps",
      },
    });
    assert.equal(call.result.isError, false);
    assert.equal(call.result._meta.title, "Inspect available apps");
    assert.match(call.result.content.at(-1).text, /com\.example\.Text/);
  } finally {
    repl.child.kill("SIGTERM");
  }
});

test("read-only safety mode changes annotations and blocks mutations", async () => {
  const repl = startRepl({ OPENCODE_COMPUTER_USE_SAFETY_MODE: "read-only" });
  try {
    await repl.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    const list = await repl.request("tools/list");
    assert.equal(list.result.tools[0].annotations.readOnlyHint, true);
    assert.equal(list.result.tools[0].annotations.destructiveHint, false);
    const call = await repl.request("tools/call", {
      name: "js",
      arguments: { code: 'var app = await cua.getApp("Text"); await app.click(1);' },
    });
    assert.equal(call.result.isError, true);
    assert.match(call.result.content.at(-1).text, /mutating CUA method disabled/);
  } finally {
    repl.child.kill("SIGTERM");
  }
});

test("notifies the native runtime before shutdown", async () => {
  const nativeTemp = await mkdtemp(join(tmpdir(), "ocu-native-"));
  const marker = join(nativeTemp, "ocu-native-notifications.jsonl");
  const repl = startRepl({ TMPDIR: nativeTemp, TEMP: nativeTemp, TMP: nativeTemp });
  try {
    await repl.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    repl.child.kill("SIGTERM");
    let notification;
    const deadline = Date.now() + 2_000;
    while (!notification && Date.now() < deadline) {
      try {
        const lines = (await readFile(marker, "utf8")).trim().split("\n").filter(Boolean);
        notification = lines.length ? JSON.parse(lines.at(-1)) : undefined;
        if (!notification) await new Promise((resolve) => setTimeout(resolve, 10));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.ok(notification, "native runtime did not receive turn-ended notification");
    assert.equal(notification.method, "notifications/turn-ended");
    assert.equal(notification.params.reason, "signal");
  } finally {
    repl.child.kill("SIGTERM");
    await rm(nativeTemp, { recursive: true, force: true });
  }
});

test("returns JSON-RPC errors for malformed requests", async () => {
  const repl = startRepl();
  try {
    await repl.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    repl.sendRaw("null\n");
    const response = await repl.nextResponse();
    assert.equal(response.id, null);
    assert.equal(response.error.code, -32600);
  } finally {
    repl.child.kill("SIGTERM");
  }
});

test("bounds oversized inbound request lines", async () => {
  const repl = startRepl();
  try {
    await repl.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    repl.sendRaw("x".repeat(1_048_577));
    const response = await repl.nextResponse();
    assert.equal(response.error.code, -32600);
  } finally {
    repl.child.kill("SIGTERM");
  }
});

test("bounds text returned by the MCP session", async () => {
  const repl = startRepl({ OPENCODE_COMPUTER_USE_MAX_TEXT_CHARS: "1000" });
  try {
    await repl.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    const call = await repl.request("tools/call", {
      name: "js",
      arguments: { code: 'for (let index = 0; index < 20; index += 1) nodeRepl.write("x".repeat(100));' },
    });
    const text = call.result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("");
    assert.equal(text.length <= 1000, true);
    assert.match(text, /output truncated/);
  } finally {
    repl.child.kill("SIGTERM");
  }
});
