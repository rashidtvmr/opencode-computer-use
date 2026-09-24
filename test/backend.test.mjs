import test from "node:test";
import assert from "node:assert/strict";
import { backendEnvironment, resolveBackend } from "../lib/backend.js";

test("custom backends use a fixed argv without shell parsing", () => {
  const backend = resolveBackend(
    { backend: "custom", command: ["/opt/computer use", "mcp", "--fixed"] },
    {},
  );
  assert.deepEqual(backend, {
    name: "custom",
    source: "options.command",
    command: "/opt/computer use",
    args: ["mcp", "--fixed"],
    platform: process.platform,
    arch: process.arch,
  });
});

test("native environment override is parsed as structured argv", () => {
  const backend = resolveBackend(
    {},
    {
      OPEN_COMPUTER_USE_NATIVE_COMMAND: "/opt/native",
      OPEN_COMPUTER_USE_NATIVE_ARGS: JSON.stringify(["mcp", "--fixed"]),
    },
  );
  assert.equal(backend.command, "/opt/native");
  assert.deepEqual(backend.args, ["mcp", "--fixed"]);
});

test("native child environment excludes unrelated secrets", () => {
  const environment = backendEnvironment({
    PATH: "/usr/bin",
    HOME: "/home/test",
    OPEN_COMPUTER_USE_ACTION_READ_BACK: "0",
    OPENAI_API_KEY: "do-not-forward",
    SECRET_TOKEN: "do-not-forward",
  });
  assert.deepEqual(environment, {
    PATH: "/usr/bin",
    HOME: "/home/test",
    OPEN_COMPUTER_USE_ACTION_READ_BACK: "0",
  });
});
