import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { normalizeOptions, optionsToEnvironment } from "./lib/options.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const proxyPath = join(packageRoot, "bin", "opencode-computer-use-repl.js");

function proxyCommand() {
  return [process.env.OPENCODE_NODE || "node", proxyPath];
}

function baseServerConfig(options) {
  return {
    type: "local",
    command: proxyCommand(),
    cwd: packageRoot,
    environment: optionsToEnvironment(options),
  };
}

function v1ServerConfig(options) {
  return {
    ...baseServerConfig(options),
    enabled: !options.disabled,
  };
}

function v2ServerConfig(options) {
  return {
    ...baseServerConfig(options),
    disabled: options.disabled,
  };
}

function shouldReplace(existing, options) {
  return options.override || !existing;
}

async function setup(ctx) {
  const options = normalizeOptions(ctx.options);
  if (!ctx.mcp?.transform) {
    throw new Error("This OpenCode2 runtime does not expose ctx.mcp.transform");
  }
  const registration = await ctx.mcp.transform((editor) => {
    const existing = editor.get(options.serverName);
    if (shouldReplace(existing, options)) {
      editor.set(options.serverName, v2ServerConfig(options));
    }
  });
  return async () => {
    await registration?.dispose?.();
  };
}

async function server(_input, inputOptions) {
  const options = normalizeOptions(inputOptions);
  return {
    config: async (config) => {
      if (!config.mcp || typeof config.mcp !== "object" || Array.isArray(config.mcp)) {
        config.mcp = {};
      }
      const existing = config.mcp[options.serverName];
      if (shouldReplace(existing, options)) {
        config.mcp[options.serverName] = v1ServerConfig(options);
      }
    },
  };
}

const plugin = {
  id: "opencode-computer-use",
  setup,
  server,
};

export const ComputerUsePlugin = server;
export default plugin;
