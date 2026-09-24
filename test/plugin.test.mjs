import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../index.js";

test("V1 entrypoint registers a local cua_repl MCP server", async () => {
  const hooks = await plugin.server({}, { backend: "auto" });
  const config = {};
  await hooks.config(config);
  assert.equal(config.mcp.cua_repl.type, "local");
  assert.equal(config.mcp.cua_repl.enabled, true);
  assert.deepEqual(config.mcp.cua_repl.command.slice(0, 1), ["node"]);
  assert.match(config.mcp.cua_repl.command[1], /opencode-computer-use-repl\.js$/);
});

test("V2 entrypoint uses ctx.mcp.transform and cleans up", async () => {
  let registered;
  let disposed = false;
  const cleanup = await plugin.setup({
    options: { backend: "auto" },
    mcp: {
      transform: async (callback) => {
        callback({
          get: () => undefined,
          set: (name, config) => {
            registered = { name, config };
          },
        });
        return {
          dispose: async () => {
            disposed = true;
          },
        };
      },
    },
  });
  assert.equal(registered.name, "cua_repl");
  assert.equal(registered.config.type, "local");
  assert.equal(registered.config.disabled, false);
  assert.equal("enabled" in registered.config, false);
  await cleanup();
  assert.equal(disposed, true);
});

test("existing server entries are preserved unless override is requested", async () => {
  const existing = { type: "remote", url: "https://example.invalid" };
  let registered;
  await plugin.setup({
    options: { backend: "auto" },
    mcp: {
      transform: async (callback) => {
        callback({
          get: () => existing,
          set: () => {
            registered = true;
          },
        });
        return { dispose: async () => {} };
      },
    },
  });
  assert.equal(registered, undefined);
});
