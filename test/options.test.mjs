import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOptions, optionsFromEnvironment, optionsToEnvironment } from "../lib/options.js";

test("normalizes Codex-style session defaults", () => {
  assert.deepEqual(normalizeOptions(), {
    backend: "auto",
    command: undefined,
    disabled: false,
    allowGlobalPointerFallbacks: false,
    override: false,
    serverName: "cua_repl",
    timeoutMs: 30_000,
    maxTextChars: 200_000,
    maxImageBytes: 2 * 1024 * 1024,
  });
  assert.throws(
    () => normalizeOptions({ backend: "custom" }),
    /requires a non-empty command array/,
  );
});

test("round trips plugin options through the REPL environment", () => {
  const options = normalizeOptions({
    backend: "custom",
    command: ["/tmp/open-computer-use", "mcp"],
    maxTextChars: 1234,
  });
  const restored = optionsFromEnvironment(optionsToEnvironment(options));
  assert.deepEqual(restored, options);
  assert.equal(
    optionsToEnvironment(normalizeOptions({ allowGlobalPointerFallbacks: true })).OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS,
    "1",
  );
});

test("rejects invalid server names", () => {
  assert.throws(() => normalizeOptions({ serverName: "bad name" }), /serverName/);
});
