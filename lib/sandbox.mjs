import { runInContext } from "node:vm";

const MAX_FRAME_BYTES = 32 * 1024 * 1024;

const SANDBOX_FACTORY_SOURCE = String.raw`
((dispatch, write, emitImage, schedule, cancel) => {
  const decodeBase64 = value => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const bytes = [];
    let buffer = 0;
    let bits = 0;
    for (const character of value.replace(/=+$/u, "")) {
      const index = alphabet.indexOf(character);
      if (index < 0) throw new Error("invalid image data");
      buffer = (buffer << 6) | index;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((buffer >> bits) & 255);
      }
    }
    return new Uint8Array(bytes);
  };
  const revive = value => {
    if (value === null || typeof value !== "object") return value;
    if (value.type === "bytes") return decodeBase64(value.data);
    if (Array.isArray(value)) return value.map(revive);
    const result = Object.create(null);
    for (const [key, child] of Object.entries(value)) {
      Object.defineProperty(result, key, {
        value: revive(child),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  };
  const decode = payload => {
    const message = JSON.parse(payload);
    if (!message.ok) throw new Error(message.error);
    return revive(message.value);
  };
  const call = (method, args) => Promise.resolve(dispatch(method, args)).then(decode);
  const appCall = (token, method, args) => call("app:" + method, [token, ...args]);
  const app = token => Object.freeze({
    getAXState: (...args) => appCall(token, "getAXState", args),
    getScreenshot: (...args) => appCall(token, "getScreenshot", args),
    getAXStateAndScreenshot: (...args) => appCall(token, "getAXStateAndScreenshot", args),
    click: (...args) => appCall(token, "click", args),
    drag: (...args) => appCall(token, "drag", args),
    pressKey: (...args) => appCall(token, "pressKey", args),
    scroll: (...args) => appCall(token, "scroll", args),
    setValue: (...args) => appCall(token, "setValue", args),
    typeText: (...args) => appCall(token, "typeText", args),
    performSecondaryAction: (...args) => appCall(token, "performSecondaryAction", args),
  });
  const cua = Object.freeze({
    getState: (...args) => call("getState", args),
    listApps: (...args) => call("listApps", args),
    getApp: name => call("getApp", [name]).then(app),
    rewriteDocumentation: (...args) => call("rewriteDocumentation", args),
  });
  const nodeRepl = Object.freeze({
    write: (value, itemId) => { write(value, itemId); },
    emitImage: value => Promise.resolve(emitImage(value)),
  });
  const timers = new Map();
  let nextTimer = 1;
  const setTimeoutSafe = (callback, delay, ...args) => {
    const id = nextTimer++;
    timers.set(id, schedule(() => {
      timers.delete(id);
      callback(...args);
    }, delay));
    return id;
  };
  const clearTimeoutSafe = id => {
    if (!timers.has(id)) return;
    cancel(timers.get(id));
    timers.delete(id);
  };
  return Object.freeze({ cua, nodeRepl, setTimeout: setTimeoutSafe, clearTimeout: clearTimeoutSafe });
})
`;

const SAFE_SANDBOX_GLOBALS = new Set([
  "globalThis",
  "Object",
  "Function",
  "Array",
  "ArrayBuffer",
  "Boolean",
  "BigInt",
  "DataView",
  "Date",
  "Error",
  "EvalError",
  "Infinity",
  "Intl",
  "JSON",
  "Map",
  "Math",
  "NaN",
  "Number",
  "Promise",
  "Proxy",
  "Reflect",
  "RegExp",
  "Set",
  "String",
  "Symbol",
  "SyntaxError",
  "TypeError",
  "URIError",
  "WeakMap",
  "WeakRef",
  "WeakSet",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "eval",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "undefined",
  "AsyncDisposableStack",
  "DisposableStack",
  "Iterator",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

function asError(error) {
  if (error instanceof Error) return error;
  return new Error(typeof error?.message === "string" ? error.message : String(error));
}

function safeErrorMessage(error) {
  return asError(error).message
    .replace(/\b(token|secret|password|api[_-]?key|authorization)\s*[:=]\s*(?:bearer|basic)?[^\n\r,;]*/giu, "$1=[redacted]")
    .slice(0, 4_000);
}

export function hardenSandboxContext(context) {
  const blockedCodeGeneration = runInContext(
    '(function blockedCodeGeneration() { throw new Error("code generation is disabled in the CUA sandbox"); })',
    context,
  );
  const prototypes = runInContext(
    "[Object.getPrototypeOf(() => {}), Object.getPrototypeOf(async () => {}), Object.getPrototypeOf(function* () {}), Object.getPrototypeOf(async function* () {})]",
    context,
  );
  for (const prototype of prototypes) {
    Object.defineProperty(prototype, "constructor", {
      value: blockedCodeGeneration,
      configurable: false,
      writable: false,
    });
  }
  for (const name of ["Function", "eval", "WebAssembly", "SharedArrayBuffer", "Atomics"]) {
    Object.defineProperty(context, name, {
      value: undefined,
      configurable: false,
      writable: false,
    });
  }
}

export function assertSandboxCode(code) {
  if (/(^|[^A-Za-z0-9_$])import([^A-Za-z0-9_$]|$)/u.test(code)) {
    throw new Error("dynamic imports are disabled in the CUA sandbox");
  }
}

export function sanitizeSandboxContext(context) {
  for (const name of Object.getOwnPropertyNames(context)) {
    if (SAFE_SANDBOX_GLOBALS.has(name)) continue;
    try {
      delete context[name];
    } catch {
      throw new Error(`could not remove sandbox global: ${name}`);
    }
  }
}

function encodeSandboxValue(value, seen = new Set()) {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Buffer.isBuffer(value) || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = Buffer.isBuffer(value)
      ? value
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { type: "bytes", data: bytes.toString("base64") };
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) throw new Error("CUA result contained a cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => encodeSandboxValue(item, seen));
    const result = Object.create(null);
    for (const [key, child] of Object.entries(value)) {
      Object.defineProperty(result, key, {
        value: encodeSandboxValue(child, seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function encodeSandboxResult(value) {
  const payload = JSON.stringify({ ok: true, value: encodeSandboxValue(value) });
  if (Buffer.byteLength(payload, "utf8") > MAX_FRAME_BYTES) {
    throw new Error("CUA result exceeded the sandbox output limit");
  }
  return payload;
}

export function createSandboxBridge(api, context, activeOutput, isActive, schedule, cancel) {
  const bindings = new Map();
  let nextBinding = 1;
  const dispatch = async (method, args) => {
    try {
      if (!isActive()) throw new Error("CUA calls are only available while js is executing");
      if (method === "getState") {
        const state = await api.getState({ emit: false });
        return encodeSandboxResult({ apps: state.apps });
      }
      if (method === "listApps") return encodeSandboxResult(await api.listApps({ emit: false }));
      if (method === "getApp") {
        const app = args[0];
        if (typeof app !== "string" || !app.trim()) {
          throw new Error("cua.getApp expects a non-empty app name or bundle ID");
        }
        const binding = await api.getApp(app);
        const token = `app-${nextBinding++}`;
        bindings.set(token, binding);
        return encodeSandboxResult(token);
      }
      if (method === "rewriteDocumentation") {
        api.rewriteDocumentation();
        return encodeSandboxResult(undefined);
      }
      if (method.startsWith("app:")) {
        const [token, ...callArgs] = args;
        const binding = bindings.get(token);
        if (!binding) throw new Error("unknown CUA app binding");
        const result = await binding[method.slice(4)](...callArgs);
        return encodeSandboxResult(result);
      }
      throw new Error(`unknown sandbox method: ${method}`);
    } catch (error) {
      return JSON.stringify({ ok: false, error: safeErrorMessage(error) });
    }
  };
  const factory = runInContext(SANDBOX_FACTORY_SOURCE, context);
  const facade = factory(
    dispatch,
    (value, itemId) => activeOutput().write(value, itemId),
    value => activeOutput().emitImage(value),
    schedule,
    cancel,
  );
  Object.defineProperties(context, {
    cua: { value: facade.cua, configurable: false, writable: false },
    nodeRepl: { value: facade.nodeRepl, configurable: false, writable: false },
    setTimeout: { value: facade.setTimeout, configurable: false, writable: false },
    clearTimeout: { value: facade.clearTimeout, configurable: false, writable: false },
  });
}
