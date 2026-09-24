const BACKENDS = new Set(["auto", "native", "custom"]);
const DEFAULT_SERVER_NAME = "cua_repl";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOption(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function booleanOption(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function boundedNumber(value, fallback, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function commandOption(value) {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (value.some((item) => typeof item !== "string" || !item)) return undefined;
  return [...value];
}

function serverNameOption(value) {
  const name = stringOption(value, DEFAULT_SERVER_NAME);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new Error("serverName must contain only letters, numbers, underscores, or hyphens");
  }
  return name;
}

export function normalizeOptions(input = {}) {
  const raw = isRecord(input) ? input : {};
  const backend = stringOption(raw.backend, "auto");
  if (!BACKENDS.has(backend)) {
    throw new Error(`backend must be one of: ${[...BACKENDS].join(", ")}`);
  }

  const command = commandOption(raw.command);
  if (backend === "custom" && !command) {
    throw new Error("backend 'custom' requires a non-empty command array");
  }

  return {
    backend,
    command,
    disabled: booleanOption(raw.disabled, false),
    allowGlobalPointerFallbacks: booleanOption(raw.allowGlobalPointerFallbacks, false),
    override: booleanOption(raw.override, false),
    serverName: serverNameOption(raw.serverName),
    timeoutMs: boundedNumber(raw.timeoutMs, 30_000, 1_000, 300_000),
    maxTextChars: boundedNumber(raw.maxTextChars, 200_000, 1_000, 2_000_000),
    maxImageBytes: boundedNumber(raw.maxImageBytes, 2 * 1024 * 1024, 16_384, 16 * 1024 * 1024),
  };
}

export function optionsToEnvironment(options) {
  const normalized = normalizeOptions(options);
  const environment = {
    OPENCODE_COMPUTER_USE_BACKEND: normalized.backend,
    OPENCODE_COMPUTER_USE_SERVER_NAME: normalized.serverName,
    OPENCODE_COMPUTER_USE_TIMEOUT_MS: String(normalized.timeoutMs),
    OPENCODE_COMPUTER_USE_MAX_TEXT_CHARS: String(normalized.maxTextChars),
    OPENCODE_COMPUTER_USE_MAX_IMAGE_BYTES: String(normalized.maxImageBytes),
  };

  if (normalized.command) {
    environment.OPENCODE_COMPUTER_USE_COMMAND = JSON.stringify(normalized.command);
  }
  if (normalized.allowGlobalPointerFallbacks) {
    environment.OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS = "1";
  }

  return environment;
}

export function optionsFromEnvironment(environment = process.env) {
  const commandText = environment.OPENCODE_COMPUTER_USE_COMMAND;
  let command;
  if (commandText) {
    try {
      command = commandOption(JSON.parse(commandText));
    } catch {
      command = undefined;
    }
  }

  return normalizeOptions({
    backend: environment.OPENCODE_COMPUTER_USE_BACKEND,
    command,
    allowGlobalPointerFallbacks: environment.OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS === "1",
    serverName: environment.OPENCODE_COMPUTER_USE_SERVER_NAME,
    timeoutMs: Number(environment.OPENCODE_COMPUTER_USE_TIMEOUT_MS),
    maxTextChars: Number(environment.OPENCODE_COMPUTER_USE_MAX_TEXT_CHARS),
    maxImageBytes: Number(environment.OPENCODE_COMPUTER_USE_MAX_IMAGE_BYTES),
  });
}

export const defaults = Object.freeze({
  backend: "auto",
  disabled: false,
  allowGlobalPointerFallbacks: false,
  override: false,
  serverName: DEFAULT_SERVER_NAME,
  timeoutMs: 30_000,
  maxTextChars: 200_000,
  maxImageBytes: 2 * 1024 * 1024,
});
