#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { backendEnvironment, resolveBackend } from "../lib/backend.js";

const SKIP_ENV = "OPENCODE_COMPUTER_USE_SKIP_PERMISSIONS";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function print(text, stream = "stdout") {
  process[stream].write(`${text}\n`);
}

export function usage() {
  return `Usage: opencode-computer-use-permissions [options]

Run the native Open Computer Use permission and runtime onboarding check.

Options:
  --strict       Return a failure when the native check cannot run
  --help, -h     Show this help

The command uses the installed open-computer-use runtime:
  macOS   checks or launches Accessibility and Screen Recording onboarding
  Linux   reports AT-SPI and signed-in desktop-session requirements
  Windows reports UI Automation and interactive-session requirements
`;
}

function parseArguments(argv) {
  const options = { strict: false, help: false };
  for (const argument of argv) {
    if (argument === "--strict") options.strict = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown permission option: ${argument}`);
  }
  return options;
}

function shouldSkip(env) {
  const developmentInstall = env.npm_lifecycle_event === "postinstall"
    && env.INIT_CWD
    && resolve(env.INIT_CWD) === PACKAGE_ROOT;
  return developmentInstall || env.CI === "true" || env.CI === "1" || env[SKIP_ENV] === "1";
}

export function main(argv = process.argv.slice(2), env = process.env, io = print) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    io(`[opencode-computer-use-permissions] ${error instanceof Error ? error.message : String(error)}`, "stderr");
    io(usage(), "stderr");
    return 2;
  }
  if (options.help) {
    io(usage());
    return 0;
  }
  if (shouldSkip(env)) {
    io("OpenCode Computer Use permission onboarding skipped.");
    return 0;
  }

  let backend;
  try {
    backend = resolveBackend({ backend: "native" }, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io(`[opencode-computer-use-permissions] Native permission check unavailable: ${message}`);
    if (options.strict) return 1;
    io("Install the optional open-computer-use runtime, then run this command again.");
    return 0;
  }

  const result = spawnSync(backend.command, ["doctor"], {
    env: backendEnvironment(env),
    stdio: "inherit",
    windowsHide: false,
    timeout: 120_000,
  });
  if (result.error) {
    io(`[opencode-computer-use-permissions] Permission check failed: ${result.error.message}`);
    return options.strict ? 1 : 0;
  }
  if (result.status !== 0) {
    io(`[opencode-computer-use-permissions] Native permission check exited with status ${result.status}.`);
    return options.strict ? 1 : 0;
  }
  return 0;
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
  process.exitCode = main();
}
