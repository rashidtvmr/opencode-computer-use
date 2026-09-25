#!/usr/bin/env node

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyEdits, modify, parse, parseTree } from "jsonc-parser";

const PACKAGE_NAME = "@frontendxlab/opencode-computer-use";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_V1_OPTIONS = { backend: "auto" };

export const FALLBACK_INSTRUCTIONS = `
Automatic OpenCode setup could not safely choose a configuration.

For OpenCode 1, add this to opencode.json or opencode.jsonc:

{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@frontendxlab/opencode-computer-use", { "backend": "auto" }]
  ]
}

For OpenCode2 V2, add this to opencode.json or opencode.jsonc:

{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@frontendxlab/opencode-computer-use",
      "options": { "backend": "auto" }
    }
  ]
}

For global OpenCode2 V2 setup, run:

opencode2 plugin add @frontendxlab/opencode-computer-use

After changing configuration, restart OpenCode:

opencode service restart
opencode2 service restart
`.trim();

function print(text, stream = "stdout") {
  process[stream].write(`${text}\n`);
}

function parseArguments(argv) {
  const result = {
    scope: "auto",
    flavor: "auto",
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--global" || argument === "-g") {
      result.scope = "global";
    } else if (argument === "--local" || argument === "--project") {
      result.scope = "local";
    } else if (argument === "--v1") {
      result.flavor = "v1";
    } else if (argument === "--v2") {
      result.flavor = "v2";
    } else if (argument === "--opencode-version") {
      const value = argv[++index];
      if (value !== "1" && value !== "2") {
        throw new Error("--opencode-version must be 1 or 2");
      }
      result.flavor = value === "1" ? "v1" : "v2";
    } else if (argument === "--dry-run") {
      result.dryRun = true;
    } else if (argument === "--help" || argument === "-h") {
      result.help = true;
    } else if (argument === "--auto") {
      continue;
    } else {
      throw new Error(`Unknown setup option: ${argument}`);
    }
  }

  return result;
}

function usage() {
  return `Usage: opencode-computer-use-setup [options]

Options:
  --auto                 Detect OpenCode generation and scope (default)
  --local, --project     Configure the current project
  --global               Configure the current user's global config
  --v1                   Configure the OpenCode 1 plugin format
  --v2                   Configure the OpenCode2 V2 plugin format
  --opencode-version 1|2 Select the OpenCode generation explicitly
  --dry-run              Show the action without changing files
  --help, -h             Show this help
`;
}

function executableCandidates(command, env = process.env) {
  const pathValue = env.PATH || "";
  const directories = pathValue.split(delimiter).filter(Boolean);
  if (process.platform === "win32") {
    const extensions = (env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean);
    return directories.flatMap((directory) => [
      join(directory, command),
      ...extensions.map((extension) => join(directory, `${command}${extension.toLowerCase()}`)),
      ...extensions.map((extension) => join(directory, `${command}${extension}`)),
    ]);
  }
  return directories.map((directory) => join(directory, command));
}

function isExecutableFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveCommand(command, env = process.env) {
  return executableCandidates(command, env).find(isExecutableFile) || command;
}

function probeCommand(command, env = process.env) {
  const executable = resolveCommand(command, env);
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    env,
    shell: false,
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    return {
      command,
      available: false,
      version: null,
      output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
    };
  }
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  const match = output.match(/(?:opencode2?|opencode)\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/iu);
  return {
    command,
    available: true,
    version: match?.[1] || output.split(/\r?\n/u)[0] || "unknown",
    output,
  };
}

export function detectOpenCode(env = process.env) {
  return {
    v1: probeCommand("opencode", env),
    v2: probeCommand("opencode2", env),
  };
}

function packageKey(entry) {
  if (typeof entry === "string") return entry;
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0];
  if (entry && typeof entry === "object" && typeof entry.package === "string") return entry.package;
  return undefined;
}

function hasPackage(entries) {
  return Array.isArray(entries) && entries.some((entry) => packageKey(entry) === PACKAGE_NAME);
}

function configFlavor(text) {
  const root = parseTree(text);
  if (!root || root.type !== "object") return null;
  const names = (root.children || [])
    .filter((child) => child.type === "property")
    .map((property) => property.children?.[0]?.value)
    .filter((name) => name === "plugin" || name === "plugins");
  const hasV1 = names.includes("plugin");
  const hasV2 = names.includes("plugins");
  if (hasV1 && hasV2) return "ambiguous";
  if (hasV1) return "v1";
  if (hasV2) return "v2";
  return null;
}

function existingConfigFiles(root, scope, env = process.env) {
  if (env.OPENCODE_CONFIG) return [resolve(env.OPENCODE_CONFIG)];
  const bases = scope === "global"
    ? [globalConfigDir(env)]
    : [root, join(root, ".opencode")];
  const files = [];
  for (const base of bases) {
    for (const name of ["opencode.jsonc", "opencode.json"]) {
      const file = join(base, name);
      if (existsSync(file) && !files.includes(file)) files.push(file);
    }
  }
  return files;
}

export function configFiles(root, scope, env = process.env) {
  return existingConfigFiles(root, scope, env);
}

export function globalConfigDir(env = process.env) {
  if (env.OPENCODE_CONFIG_DIR) return resolve(env.OPENCODE_CONFIG_DIR);
  if (env.XDG_CONFIG_HOME) return join(resolve(env.XDG_CONFIG_HOME), "opencode");
  const home = env.HOME || env.USERPROFILE || homedir();
  return join(resolve(home), ".config", "opencode");
}

export function detectConfigFlavor(root, scope, env = process.env) {
  const files = existingConfigFiles(root, scope, env);
  let detected = null;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const flavor = configFlavor(text);
    if (flavor && detected && flavor !== detected) return "ambiguous";
    if (flavor) detected = flavor;
  }
  return detected;
}

export function inferScope(requested, env = process.env) {
  if (requested === "local" || requested === "global") return requested;
  const globalFlag = env.npm_config_global ?? env.NPM_CONFIG_GLOBAL;
  if (globalFlag === "true" || globalFlag === true || globalFlag === "1") return "global";
  return "local";
}

function defaultConfigFile(root, scope, env) {
  const configDir = scope === "global" ? globalConfigDir(env) : root;
  return join(configDir, "opencode.json");
}

function addEntry(entries, flavor) {
  if (hasPackage(entries)) return { entries, changed: false };
  const entry = flavor === "v1"
    ? [PACKAGE_NAME, { ...DEFAULT_V1_OPTIONS }]
    : PACKAGE_NAME;
  return { entries: [...entries, entry], changed: true };
}

function newConfig(flavor) {
  const key = flavor === "v1" ? "plugin" : "plugins";
  const entry = flavor === "v1"
    ? [[PACKAGE_NAME, { ...DEFAULT_V1_OPTIONS }]]
    : [PACKAGE_NAME];
  return {
    $schema: "https://opencode.ai/config.json",
    [key]: entry,
  };
}

export function updateConfigText(text, flavor) {
  const parsed = parse(text);
  if (text.trim() && (parsed === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new Error("configuration is not a JSON or JSONC object");
  }
  const data = parsed && typeof parsed === "object" ? parsed : {};
  if (data.plugin !== undefined && data.plugins !== undefined) {
    throw new Error("configuration contains both plugin and plugins fields");
  }
  const key = flavor === "v1" ? "plugin" : "plugins";
  const current = data[key];
  if (current !== undefined && !Array.isArray(current)) {
    throw new Error(`configuration field "${key}" is not an array`);
  }
  const result = addEntry(current || [], flavor);
  if (!result.changed) return { text, changed: false };
  const edits = modify(text, [key], result.entries, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
      eol: text.includes("\r\n") ? "\r\n" : "\n",
    },
  });
  return { text: applyEdits(text, edits), changed: true };
}

function writeConfig(file, content, dryRun) {
  if (dryRun) return;
  mkdirSync(dirname(file), { recursive: true });
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  if (existsSync(file)) {
    const backup = `${file}.bak`;
    copyFileSync(file, backup);
    chmodSync(backup, mode);
  }
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, content, { encoding: "utf8", mode, flag: "wx" });
  chmodSync(temporary, mode);
  if (process.platform === "win32" && existsSync(file)) rmSync(file, { force: true });
  renameSync(temporary, file);
}

function validateConfigFiles(root, scope, env) {
  for (const file of existingConfigFiles(root, scope, env)) {
    const text = readFileSync(file, "utf8");
    const data = parse(text);
    if (text.trim() && (data === undefined || data === null || typeof data !== "object" || Array.isArray(data))) {
      throw new Error(`configuration is not valid JSON or JSONC: ${file}`);
    }
  }
}

function packageAlreadyConfigured(root, scope, env) {
  for (const file of existingConfigFiles(root, scope, env)) {
    try {
      const data = parse(readFileSync(file, "utf8"));
      const key = data?.plugins !== undefined ? "plugins" : data?.plugin !== undefined ? "plugin" : undefined;
      if (key && hasPackage(data[key])) return file;
    } catch {
      continue;
    }
  }
  return undefined;
}

function redactMessage(value) {
  return String(value)
    .replace(/\b(token|secret|password|api[_-]?key|authorization)\s*[:=]\s*(?:bearer|basic)?[^\n\r,;]*/giu, "$1=[redacted]")
    .slice(0, 500);
}

function runPluginCli(flavor, scope, root, env) {
  const command = flavor === "v1" ? "opencode" : "opencode2";
  const args = ["plugin", "add", PACKAGE_NAME];
  if (flavor === "v1" && scope === "global") args.push("--global");
  const result = spawnSync(resolveCommand(command, env), args, {
    cwd: root,
    encoding: "utf8",
    env,
    shell: process.platform === "win32",
    windowsHide: true,
    timeout: 120_000,
  });
  if (result.error || result.status !== 0) {
    const detail = redactMessage(`${result.stdout || ""}${result.stderr || ""}`.trim());
    throw new Error(`${command} plugin add failed${detail ? `: ${detail}` : ""}`);
  }
}

function configForSetup(root, scope, flavor, env, dryRun) {
  const files = existingConfigFiles(root, scope, env);
  if (files.length > 0) {
    const flavors = files.map((file) => {
      try {
        return configFlavor(readFileSync(file, "utf8"));
      } catch {
        return null;
      }
    });
    if (flavors.includes("ambiguous")) {
      throw new Error("configuration contains both plugin and plugins fields");
    }
    if (new Set(flavors.filter(Boolean)).size > 1) {
      throw new Error("multiple conflicting OpenCode configuration files were found");
    }
  }
  const file = files[0] || defaultConfigFile(root, scope, env);
  if (!existsSync(file)) {
    const content = JSON.stringify(newConfig(flavor), null, 2) + "\n";
    writeConfig(file, content, dryRun);
    return { file, changed: true };
  }
  const result = updateConfigText(readFileSync(file, "utf8"), flavor);
  writeConfig(file, result.text, dryRun);
  return { file, changed: result.changed };
}

function chooseFlavor(requested, detection, config) {
  if (config === "ambiguous") {
    throw new Error("configuration contains both plugin and plugins fields");
  }
  if (requested !== "auto") {
    if (config && config !== requested) {
      throw new Error(`selected ${requested} conflicts with the existing ${config} configuration`);
    }
    return requested;
  }
  if (detection.v1.available && detection.v2.available) {
    if (config === "v1" || config === "v2") return config;
    throw new Error("both OpenCode 1 and OpenCode2 are installed, and the configuration is ambiguous");
  }
  if (detection.v1.available) return "v1";
  if (detection.v2.available) return "v2";
  throw new Error("neither opencode nor opencode2 was found");
}

function chooseRoot(scope, env) {
  if (scope === "global") return process.cwd();
  const initial = env.INIT_CWD || process.cwd();
  return resolve(initial);
}

export async function setup(options = {}, env = process.env, io = print) {
  const requestedScope = options.scope || "auto";
  const requestedFlavor = options.flavor || "auto";
  const scope = inferScope(requestedScope, env);
  const root = chooseRoot(scope, env);
  if (env.OPENCODE_CONFIG_CONTENT) {
    throw new Error("OPENCODE_CONFIG_CONTENT is immutable; add the plugin to that configuration manually");
  }
  const detection = detectOpenCode(env);
  const config = detectConfigFlavor(root, scope, env);
  const flavor = chooseFlavor(requestedFlavor, detection, config);
  const dryRun = Boolean(options.dryRun);
  let result;
  if (scope === "global" && !dryRun) {
    validateConfigFiles(root, scope, env);
    const existing = packageAlreadyConfigured(root, scope, env);
    if (existing) {
      result = { file: existing, changed: false };
    } else {
      runPluginCli(flavor, scope, root, env);
      const configured = packageAlreadyConfigured(root, scope, env);
      if (!configured) throw new Error(`${flavor.toUpperCase()} plugin command did not register the package`);
      result = { file: configured, changed: true };
    }
  } else {
    result = configForSetup(root, scope, flavor, env, dryRun);
  }
  const action = options.dryRun
    ? (result.changed ? "would configure" : "already configured")
    : (result.changed ? "configured" : "already configured");
  io(`OpenCode Computer Use setup ${action} for ${flavor.toUpperCase()} (${scope}).`);
  if (result.changed) io(`Configuration: ${result.file}`);
  return { ...result, scope, flavor, detection };
}

export function printHelp() {
  print(usage());
}

function isDevelopmentInstall(env) {
  const initial = env.INIT_CWD ? resolve(env.INIT_CWD) : undefined;
  return env.npm_lifecycle_event === "postinstall" && initial === PACKAGE_ROOT;
}

export async function main(argv = process.argv.slice(2), env = process.env, io = print) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    io(`[opencode-computer-use] ${error instanceof Error ? error.message : String(error)}`, "stderr");
    io(usage(), "stderr");
    return 2;
  }
  if (options.help) {
    printHelp();
    return 0;
  }
  if (env.CI === "true" || env.CI === "1") {
    io("OpenCode Computer Use setup skipped in CI.");
    return 0;
  }
  if (isDevelopmentInstall(env)) {
    io("OpenCode Computer Use setup skipped for a package-development install.");
    return 0;
  }
  if (env.OPENCODE_COMPUTER_USE_SKIP_SETUP === "1") {
    io("OpenCode Computer Use setup skipped by OPENCODE_COMPUTER_USE_SKIP_SETUP.");
    return 0;
  }
  return setup(options, env, io)
    .then(() => 0)
    .catch((error) => {
      io(`[opencode-computer-use] Automatic setup was not changed: ${error instanceof Error ? error.message : String(error)}`, "stderr");
      io(FALLBACK_INSTRUCTIONS, "stderr");
      return 0;
    });
}

function sameFile(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return resolve(left) === resolve(right);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const scriptPath = fileURLToPath(import.meta.url);
if (invokedPath && sameFile(invokedPath, scriptPath)) {
  process.exitCode = await main();
}
