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
  process[stream].write(String(text) + "\n");
}

export function usage() {
  return [
    "Usage: opencode-computer-use-permissions [options]",
    "",
    "Run the native Open Computer Use permission and runtime onboarding check.",
    "",
    "Options:",
    "  --install      Guided install mode used by the package postinstall hook",
    "  --strict       Return a failure when the native check cannot run",
    "  --help, -h     Show this help",
    "",
    "The command uses the installed open-computer-use runtime:",
    "  macOS   checks or launches Accessibility and Screen Recording onboarding.",
    "          macOS still requires the user to approve protected TCC toggles.",
    "  Linux   checks AT-SPI and the signed-in desktop session. On GNOME, install",
    "          mode best-effort enables toolkit accessibility with gsettings.",
    "  Windows checks UI Automation and the interactive signed-in desktop session.",
  ].join("\n");
}

function parseArguments(argv) {
  const options = { install: false, strict: false, help: false };
  for (const argument of argv) {
    if (argument === "--install") options.install = true;
    else if (argument === "--strict") options.strict = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error("Unknown permission option: " + argument);
  }
  return options;
}

export function platformGuidance(platform = process.platform) {
  if (platform === "darwin") {
    return [
      "macOS permission setup:",
      "  - Requires macOS 14 or newer.",
      "  - Open Computer Use needs Accessibility and Screen Recording.",
      "  - The installer runs the native doctor; if either permission is missing,",
      "    the Open Computer Use onboarding window opens and guides you to System Settings.",
      "  - macOS requires a human approval for these protected TCC permissions.",
      "  - Manual: open-computer-use doctor",
      '  - Accessibility pane: open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"',
      '  - Screen Recording pane: open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"',
    ];
  }
  if (platform === "linux") {
    return [
      "Linux desktop setup:",
      "  - There is no macOS-style permission dialog.",
      "  - Open Computer Use needs a signed-in graphical session with AT-SPI2/D-Bus.",
      "  - On GNOME, install mode best-effort enables toolkit accessibility with:",
      "    gsettings set org.gnome.desktop.interface toolkit-accessibility true",
      "  - Wayland screenshot and coordinate input support remains compositor-dependent.",
      "  - Manual verification: open-computer-use doctor && open-computer-use call list_apps",
    ];
  }
  if (platform === "win32") {
    return [
      "Windows desktop setup:",
      "  - There is no separate UI Automation permission toggle to grant.",
      "  - Open Computer Use must run in the signed-in interactive desktop session.",
      "  - Detached services/session 0 cannot control the user's desktop.",
      "  - Manual verification: open-computer-use doctor && open-computer-use call list_apps",
    ];
  }
  return [
    "Desktop permission setup is not defined for " + platform + ".",
    "Use a supported macOS, Linux, or Windows native runtime.",
  ];
}

function printPlatformGuidance(platform, io) {
  for (const line of platformGuidance(platform)) io(line);
}

function shouldSkip(env) {
  const developmentInstall = env.npm_lifecycle_event === "postinstall"
    && env.INIT_CWD
    && resolve(env.INIT_CWD) === PACKAGE_ROOT;
  return developmentInstall || env.CI === "true" || env.CI === "1" || env[SKIP_ENV] === "1";
}

function commandAvailable(command, env) {
  const result = spawnSync(command, ["--version"], {
    env,
    stdio: "ignore",
    windowsHide: true,
    timeout: 5_000,
  });
  return !result.error && result.status === 0;
}

function maybeEnableGnomeAccessibility(env, io) {
  const desktop = ((env.XDG_CURRENT_DESKTOP || "") + " " + (env.DESKTOP_SESSION || "")).toLowerCase();
  if (!desktop.includes("gnome")) {
    io("Linux accessibility auto-enable skipped: GNOME was not detected; AT-SPI will be verified by the native runtime.");
    return;
  }
  if (!commandAvailable("gsettings", env)) {
    io("Linux accessibility auto-enable skipped: gsettings is unavailable.");
    return;
  }
  const result = spawnSync(
    "gsettings",
    ["set", "org.gnome.desktop.interface", "toolkit-accessibility", "true"],
    {
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    },
  );
  if (result.error || result.status !== 0) {
    io("Linux accessibility auto-enable could not update GNOME settings. Run the documented gsettings command manually.");
    return;
  }
  io("GNOME toolkit accessibility enabled.");
}

function printInstallSessionHint(platform, env, io) {
  if (platform === "linux") {
    io("Desktop: " + (env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || "unknown")
      + "; session: " + (env.XDG_SESSION_TYPE || "unknown") + ".");
    if (!env.DBUS_SESSION_BUS_ADDRESS) {
      io("No DBUS_SESSION_BUS_ADDRESS is visible to the installer; the native runtime will try to discover the signed-in user's session automatically.");
    }
  } else if (platform === "win32") {
    io("Windows session: " + (env.SESSIONNAME || "unknown")
      + ". UI Automation requires the signed-in interactive desktop.");
  }
}

export function main(argv = process.argv.slice(2), env = process.env, io = print) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    io("[opencode-computer-use-permissions] "
      + (error instanceof Error ? error.message : String(error)), "stderr");
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

  if (options.install) {
    io("OpenCode Computer Use is checking desktop prerequisites as part of installation.");
    printPlatformGuidance(process.platform, io);
    printInstallSessionHint(process.platform, env, io);
    if (process.platform === "linux") maybeEnableGnomeAccessibility(env, io);
  }

  let backend;
  try {
    backend = resolveBackend({ backend: "native" }, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io("[opencode-computer-use-permissions] Native permission check unavailable: " + message);
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
    io("[opencode-computer-use-permissions] Permission check failed: " + result.error.message);
    return options.strict ? 1 : 0;
  }
  if (result.status !== 0) {
    io("[opencode-computer-use-permissions] Native permission check exited with status "
      + result.status + ".");
    return options.strict ? 1 : 0;
  }
  if (options.install) {
    io("Desktop onboarding check complete.");
    io("You can rerun it any time with: npx opencode-computer-use-permissions --strict");
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
