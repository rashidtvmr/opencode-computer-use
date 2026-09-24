import { constants, accessSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";
import { normalizeOptions, optionsFromEnvironment } from "./options.js";

const require = createRequire(import.meta.url);

const PLATFORM_PATHS = {
  "darwin-arm64": ["dist", "Open Computer Use.app", "Contents", "MacOS", "OpenComputerUse"],
  "darwin-x64": ["dist", "Open Computer Use.app", "Contents", "MacOS", "OpenComputerUse"],
  "linux-arm64": ["dist", "linux", "arm64", "open-computer-use"],
  "linux-x64": ["dist", "linux", "amd64", "open-computer-use"],
  "win32-arm64": ["dist", "windows", "arm64", "open-computer-use.exe"],
  "win32-x64": ["dist", "windows", "amd64", "open-computer-use.exe"],
};

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function commandOnPath(name, environment = process.env) {
  const pathValue = environment.PATH;
  if (!pathValue) return undefined;
  const extensions =
    process.platform === "win32"
      ? (environment.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

function packageRoot() {
  try {
    return dirname(require.resolve("open-computer-use/package.json"));
  } catch {
    try {
      let current = dirname(require.resolve("open-computer-use"));
      while (current !== dirname(current)) {
        if (existsSync(join(current, "package.json"))) return current;
        current = dirname(current);
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function nativeCommand(environment) {
  const override = environment.OPEN_COMPUTER_USE_NATIVE_COMMAND;
  if (override) {
    const args = environment.OPEN_COMPUTER_USE_NATIVE_ARGS
      ? JSON.parse(environment.OPEN_COMPUTER_USE_NATIVE_ARGS)
      : ["mcp"];
    if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
      throw new Error("OPEN_COMPUTER_USE_NATIVE_ARGS must be a JSON string array");
    }
    return {
      name: "open-computer-use",
      source: "OPEN_COMPUTER_USE_NATIVE_COMMAND",
      command: override,
      args,
      platform: process.platform,
      arch: process.arch,
    };
  }

  const root = packageRoot();
  const relative = PLATFORM_PATHS[`${process.platform}-${process.arch}`];
  if (root && relative) {
    const executable = join(root, ...relative);
    if (isExecutable(executable)) {
      return {
        name: "open-computer-use",
        source: "open-computer-use",
        command: executable,
        args: ["mcp"],
        platform: process.platform,
        arch: process.arch,
      };
    }
  }

  const fromPath = commandOnPath("open-computer-use", environment);
  if (fromPath) {
    return {
      name: "open-computer-use",
      source: "PATH:open-computer-use",
      command: fromPath,
      args: ["mcp"],
      platform: process.platform,
      arch: process.arch,
    };
  }

  throw new Error(
    "Open Computer Use native runtime is not installed. Install open-computer-use or set OPEN_COMPUTER_USE_NATIVE_COMMAND.",
  );
}

export function resolveBackend(input = {}, environment = process.env) {
  const fromEnvironment = optionsFromEnvironment(environment);
  const options = normalizeOptions({
    ...fromEnvironment,
    ...input,
    command: input.command ?? fromEnvironment.command,
  });

  if (options.backend === "custom") {
    const [command, ...args] = options.command;
    return {
      name: "custom",
      source: "options.command",
      command,
      args,
      platform: process.platform,
      arch: process.arch,
    };
  }
  return nativeCommand(environment);
}

export function backendEnvironment(environment = process.env) {
  const allowed = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TMPDIR",
    "TEMP",
    "TMP",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    "XDG_CURRENT_DESKTOP",
    "XDG_SESSION_TYPE",
    "XDG_SESSION_DESKTOP",
    "XDG_DATA_DIRS",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "ProgramData",
    "SystemRoot",
    "SYSTEMROOT",
    "windir",
    "ComSpec",
    "PATHEXT",
    "RUST_LOG",
    "OPEN_COMPUTER_USE_ACTION_READ_BACK",
    "OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS",
    "OPEN_COMPUTER_USE_WINDOWS_ALLOW_APP_LAUNCH",
    "OPEN_COMPUTER_USE_WINDOWS_ALLOW_FOCUS_ACTIONS",
    "OPEN_COMPUTER_USE_WINDOWS_ALLOW_UIA_TEXT_FALLBACK",
    "OPEN_COMPUTER_USE_IMAGE_CAPTURE_TIMEOUT",
    "OPEN_COMPUTER_USE_IMAGE_MAX_BYTES",
    "OPEN_COMPUTER_USE_IMAGE_MAX_DIMENSION",
    "OPEN_COMPUTER_USE_IMAGE_MIN_SCALE",
    "COMPUTER_USE_LINUX_COSMIC_HELPER",
    "COMPUTER_USE_LINUX_SCREENSHOT_BACKEND",
  ]);

  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) => allowed.has(key) && typeof value === "string",
    ),
  );
}
