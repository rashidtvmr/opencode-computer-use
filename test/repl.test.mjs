import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  JsonLinePeer,
  PersistentJavaScriptSession,
  WorkerJavaScriptSession,
  parseListApps,
  toolDefinitions,
} from "../lib/repl.mjs";

function textResult(text, isError = false, image) {
  const content = [{ type: "text", text }];
  if (image) content.push({ type: "image", mimeType: image.mimeType, data: image.data });
  return { content, isError };
}

function mockNative() {
  const calls = [];
  return {
    calls,
    async request(method, params) {
      assert.equal(method, "tools/call");
      calls.push(params);
      switch (params.name) {
        case "list_apps":
          return textResult('[{"id":"com.example.Text","displayName":"Text"}]');
        case "get_app_state":
          return textResult(`state:${params.arguments.app}`, false, {
            mimeType: "image/png",
            data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"),
          });
        case "click":
          return textResult("clicked");
        case "type_text":
          return params.arguments.text === "fail"
            ? textResult("typing failed", true)
            : textResult("typed");
        default:
          return textResult(params.name);
      }
    },
  };
}

test("advertises only Codex-style js and js_reset tools", () => {
  assert.deepEqual(toolDefinitions().map((tool) => tool.name), ["js", "js_reset"]);
  assert.deepEqual(toolDefinitions()[0].inputSchema.required, ["code"]);
  assert.equal(toolDefinitions()[0].inputSchema.properties.code.maxLength, 200_000);
  assert.equal(toolDefinitions()[0].inputSchema.properties.timeout_ms.maximum, 300_000);
});

test("sandbox removes host globals and blocks host-realm escapes", async () => {
  const session = new PersistentJavaScriptSession({ native: mockNative() });
  const globals = await session.run(`
    nodeRepl.write([
      typeof require,
      typeof process,
      typeof fetch,
      typeof Buffer,
      typeof WebAssembly,
    ].join(","));
  `);
  assert.equal(globals.content.at(-1).text, "undefined,undefined,undefined,undefined,undefined");
  const names = await session.run('nodeRepl.write(Object.getOwnPropertyNames(globalThis).join(","));');
  for (const forbidden of ["require", "process", "fetch", "Buffer", "child_process", "fs", "http", "vm"]) {
    assert.equal(names.content.at(-1).text.split(",").includes(forbidden), false);
  }
  const escape = await session.run(`
    try {
      nodeRepl.write(({}).constructor.constructor("return process")());
    } catch (error) {
      nodeRepl.write(error.message);
    }
  `);
  assert.match(escape.content.at(-1).text, /code generation|process is not defined/i);
  const facadeEscape = await session.run(`
    try {
      nodeRepl.write(cua.listApps.constructor("return process")());
    } catch (error) {
      nodeRepl.write(error.message);
    }
  `);
  assert.match(facadeEscape.content.at(-1).text, /code generation|process is not defined/i);
  await assert.rejects(
    session.run('await import("node:fs")'),
    /dynamic imports are disabled/,
  );
  const evalResult = await session.run('eval("1 + 1")');
  assert.equal(evalResult.isError, true);
  const timer = await session.run(`
    await new Promise((resolve) => setTimeout(resolve, 1));
    nodeRepl.write("timer");
  `);
  assert.equal(timer.content.at(-1).text, "timer");
  const background = await session.run('setTimeout(() => cua.listApps(), 1); nodeRepl.write("scheduled");');
  assert.equal(background.content.at(-1).text, "scheduled");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const afterBackground = await session.run('nodeRepl.write("after");');
  assert.equal(afterBackground.content.at(-1).text, "after");
});

test("enforces aggregate output budgets before returning from the session", async () => {
  const session = new PersistentJavaScriptSession({
    native: mockNative(),
    limits: { maxTextChars: 1_000, maxImageBytes: 16_384 },
  });
  const textResult = await session.run(`
    for (let index = 0; index < 20; index += 1) nodeRepl.write("x".repeat(100));
  `);
  const totalText = textResult.content
    .filter((item) => item.type === "text")
    .reduce((sum, item) => sum + item.text.length, 0);
  assert.equal(totalText <= 1_000, true);
  assert.ok(textResult.content.some((item) => item.text?.includes("output truncated")));

  const imageResult = await session.run(`
    var imageBytes = new Uint8Array(1000);
    imageBytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    for (let index = 0; index < 20; index += 1) await nodeRepl.emitImage(imageBytes);
  `);
  const totalImageBytes = imageResult.content
    .filter((item) => item.type === "image")
    .reduce((sum, item) => sum + Math.floor(item.data.length * 3 / 4), 0);
  assert.equal(totalImageBytes <= 16_384, true);
  assert.ok(imageResult.content.some((item) => item.text?.includes("image omitted")));
});

test("normalizes native app-list text across supported desktop runtimes", () => {
  assert.deepEqual(
    parseListApps(
      [
        "TextEdit - com.apple.TextEdit [frontmost, running, last-used=2026-09-22, uses=42]",
        "Google Chrome - com.google.Chrome [last-used=2026-09-21, uses=7]",
      ].join("\n"),
    ),
    [
      {
        id: "com.apple.TextEdit",
        displayName: "TextEdit",
        isRunning: true,
        lastUsedDate: "2026-09-22",
        useCount: 42,
      },
      {
        id: "com.google.Chrome",
        displayName: "Google Chrome",
        lastUsedDate: "2026-09-21",
        useCount: 7,
      },
    ],
  );
  assert.deepEqual(parseListApps("TextEdit \u2014 com.apple.TextEdit [running]"), [
    { id: "com.apple.TextEdit", displayName: "TextEdit", isRunning: true },
  ]);
});

test("cua.listApps returns structured apps and app bindings persist", async () => {
  const native = mockNative();
  const session = new PersistentJavaScriptSession({ native });
  const first = await session.run(`
    var apps = await cua.listApps({ emit: false });
    nodeRepl.write(JSON.stringify(apps));
  `);
  assert.equal(first.isError, false);
  assert.deepEqual(JSON.parse(first.content.at(-1).text), [
    { id: "com.example.Text", displayName: "Text" },
  ]);
  const second = await session.run(`
    var app = await cua.getApp("Text");
    await app.click(7, { clickMethod: "accessibility" });
    await app.typeText("hello");
    await app.getAXState();
  `);
  assert.equal(second.isError, false);
  assert.deepEqual(native.calls.map((call) => call.name), [
    "list_apps",
    "get_app_state",
    "click",
    "type_text",
    "get_app_state",
  ]);
  assert.equal(native.calls[2].arguments.element_index, 7);
  assert.equal(native.calls[2].arguments.click_method, "accessibility");
});

test("enforces read-only mode and app access policy before native mutation", async () => {
  const native = mockNative();
  const session = new PersistentJavaScriptSession({
    native,
    safetyMode: "read-only",
    appAccess: { default: "allow", allow: ["Text"], deny: ["Locked"] },
  });
  const blocked = await session.run(`
    var app = await cua.getApp("Text");
    try { await app.click(7); } catch (error) { nodeRepl.write(error.message); }
  `);
  assert.equal(blocked.isError, false);
  assert.match(blocked.content.at(-1).text, /mutating CUA method disabled in read-only safety mode/);
  assert.equal(native.calls.some((call) => call.name === "click"), false);

  const denied = await session.run(`
    try { await cua.getApp("Locked"); } catch (error) { nodeRepl.write(error.message); }
  `);
  assert.match(denied.content.at(-1).text, /app access denied by policy/);
  assert.equal(native.calls.filter((call) => call.name === "get_app_state").length, 1);

  const readOnlyTool = toolDefinitions(30_000, { safetyMode: "read-only" })[0];
  assert.equal(readOnlyTool.annotations.readOnlyHint, true);
  assert.equal(readOnlyTool.annotations.destructiveHint, false);
});

test("resolves app IDs when enforcing a deny rule", async () => {
  const native = mockNative();
  const session = new PersistentJavaScriptSession({
    native,
    appAccess: { default: "allow", allow: [], deny: ["com.example.Text"] },
  });
  const result = await session.run(`
    try { await cua.getApp("Text"); } catch (error) { nodeRepl.write(error.message); }
  `);
  assert.match(result.content.at(-1).text, /app access denied by policy/);
  assert.equal(native.calls.some((call) => call.name === "get_app_state"), false);
});

test("bounds persistent app bindings until reset", async () => {
  const native = mockNative();
  const session = new PersistentJavaScriptSession({ native });
  const result = await session.run(`
    for (let index = 0; index < 129; index += 1) {
      try { await cua.getApp("Text"); } catch (error) { nodeRepl.write(error.message); break; }
    }
  `);
  assert.equal(result.isError, false);
  assert.equal(native.calls.filter((call) => call.name === "get_app_state").length, 128);
  assert.equal(result.content.length, 128);
  session.reset();
  const afterReset = await session.run('await cua.getApp("Text"); nodeRepl.write("ok");');
  assert.equal(afterReset.isError, false);
});

test("top-level bindings persist until reset and errors are catchable", async () => {
  const session = new PersistentJavaScriptSession({ native: mockNative() });
  await session.run("var answer = 41;");
  const result = await session.run("answer += 1; nodeRepl.write(answer);");
  assert.equal(result.content.at(-1).text, "42");
  const caught = await session.run(`
    var bad = await cua.getApp("Text");
    try { await bad.typeText("fail"); } catch (error) { nodeRepl.write("caught: " + error.message); }
  `);
  assert.equal(caught.content.at(-1).text, "caught: typing failed");
  session.reset();
  const reset = await session.run("nodeRepl.write(typeof answer);");
  assert.equal(reset.content.at(-1).text, "undefined");
});

test("screenshots emit image content", async () => {
  const session = new PersistentJavaScriptSession({ native: mockNative() });
  const result = await session.run(`
    var imageApp = await cua.getApp("Text");
    var bytes = await imageApp.getScreenshot();
    nodeRepl.write(bytes.length);
  `);
  assert.equal(result.isError, false);
  assert.ok(result.content.some((item) => item.type === "image" && item.mimeType === "image/png"));
  assert.equal(result.content.at(-1).text, "8");
});

test("JsonLinePeer initializes and correlates native MCP responses", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => {};
  let input = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk) => {
    input += chunk;
    for (;;) {
      const newline = input.indexOf("\n");
      if (newline < 0) break;
      const request = JSON.parse(input.slice(0, newline));
      input = input.slice(newline + 1);
      child.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: request.method === "initialize" ? { ok: true } : { content: [] },
        })}\n`,
      );
    }
  });
  const peer = new JsonLinePeer({ child });
  assert.deepEqual(await peer.initialize(), { ok: true });
  assert.deepEqual(await peer.request("tools/call", { name: "list_apps" }), { content: [] });
  peer.closed = true;
});

test("notifies the native runtime when a request times out", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => {};
  const messages = [];
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk) => {
    for (const line of String(chunk).split("\n").filter(Boolean)) {
      const message = JSON.parse(line);
      messages.push(message);
      if (message.method === "initialize") {
        child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } })}\n`);
      }
    }
  });
  const peer = new JsonLinePeer({ child });
  await peer.initialize();
  await assert.rejects(
    peer.request("tools/call", { name: "click" }, 5),
    /timed out.*native action may still be settling/,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const cancellation = messages.find((message) => message.method === "notifications/cancelled");
  assert.deepEqual(cancellation.params, { requestId: 2, reason: "timeout" });
  peer.closed = true;
});

test("terminates the owned child when the native peer fails", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  const signals = [];
  child.kill = (signal) => signals.push(signal);
  const peer = new JsonLinePeer({ child });
  child.emit("error", new Error("native failed"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peer.closed, true);
  assert.ok(signals.includes("SIGTERM"));
  await assert.rejects(peer.request("tools/list"), /closed.*restart the MCP server/i);
});

test("worker session terminates CPU-bound code and recovers", async () => {
  const session = new WorkerJavaScriptSession({ native: mockNative() });
  const timedOut = await session.run("while (true) {}", 100);
  assert.equal(timedOut.isError, true);
  assert.match(timedOut.content[0].text, /timed out/);
  const recovered = await session.run("nodeRepl.write(21 * 2);", 5_000);
  assert.equal(recovered.content.at(-1).text, "42");
  await session.close();
});
