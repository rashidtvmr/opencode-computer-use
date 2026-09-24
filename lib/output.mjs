import { inspect } from "node:util";

export const DEFAULT_MAX_TEXT_CHARS = 200_000;
export const DEFAULT_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_ITEMS = 128;
const MAX_META_ID_CHARS = 128;
const MAX_IMAGE_INPUT_BYTES = 16 * 1024 * 1024;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatValue(value) {
  if (typeof value === "string") return value;
  return inspect(value, { depth: 6, colors: false, breakLength: 100 });
}

function sniffMimeType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new Error("nodeRepl.emitImage could not infer PNG, JPEG, or WebP MIME type");
}

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function decodeImageBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(MAX_IMAGE_INPUT_BYTES * 4 / 3) + 4 || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new Error("nodeRepl.emitImage expected valid base64 image data");
  }
  const bytes = Buffer.from(value, "base64");
  const normalizedInput = value.replace(/=+$/u, "");
  const normalizedOutput = bytes.toString("base64").replace(/=+$/u, "");
  if (normalizedInput !== normalizedOutput) throw new Error("nodeRepl.emitImage expected canonical base64 image data");
  return bytes;
}

function validateImage(mimeType, bytes) {
  if (bytes.length > MAX_IMAGE_INPUT_BYTES) throw new Error("nodeRepl.emitImage image exceeds the 16 MiB input limit");
  const normalizedMime = typeof mimeType === "string" ? mimeType.toLowerCase() : "";
  if (!IMAGE_MIME_TYPES.has(normalizedMime) || sniffMimeType(bytes) !== normalizedMime) {
    throw new Error("nodeRepl.emitImage expected a PNG, JPEG, or WebP image");
  }
  return normalizedMime;
}

function isArrayBuffer(value) {
  return value instanceof ArrayBuffer || Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}

export function normalizeImage(value) {
  let bytes;
  let mimeType;
  if (typeof value === "string") {
    if (!value.startsWith("data:image/")) throw new Error("nodeRepl.emitImage accepts image data URLs or bytes");
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(value);
    if (!match) throw new Error("nodeRepl.emitImage expected a base64 image data URL");
    mimeType = match[1];
    bytes = decodeImageBase64(match[2]);
  } else if (Buffer.isBuffer(value) || isArrayBuffer(value) || ArrayBuffer.isView(value)) {
    const byteLength = value.byteLength;
    if (byteLength > MAX_IMAGE_INPUT_BYTES) throw new Error("nodeRepl.emitImage image exceeds the 16 MiB input limit");
    bytes = Buffer.isBuffer(value)
      ? value
      : isArrayBuffer(value)
        ? Buffer.from(value)
        : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    mimeType = sniffMimeType(bytes);
  } else if (isPlainObject(value) && value.bytes !== undefined) {
    const rawBytes = value.bytes;
    const byteLength = typeof rawBytes === "string" ? rawBytes.length : rawBytes?.byteLength;
    if (Number.isFinite(byteLength) && byteLength > MAX_IMAGE_INPUT_BYTES) {
      throw new Error("nodeRepl.emitImage image exceeds the 16 MiB input limit");
    }
    bytes = Buffer.from(rawBytes);
    mimeType = typeof value.mimeType === "string" ? value.mimeType : sniffMimeType(bytes);
  } else {
    throw new Error("nodeRepl.emitImage received an unsupported value");
  }
  mimeType = validateImage(mimeType, bytes);
  return { mimeType, data: bytes.toString("base64"), bytes };
}

export function normalizeNativeImage(image) {
  return normalizeImage({ bytes: decodeImageBase64(image.data), mimeType: image.mimeType });
}

export function outputLimits(limits = {}) {
  const maxTextChars = Number.isFinite(limits.maxTextChars)
    ? Math.min(Math.max(Math.floor(limits.maxTextChars), 1_000), 2_000_000)
    : DEFAULT_MAX_TEXT_CHARS;
  const maxImageBytes = Number.isFinite(limits.maxImageBytes)
    ? Math.min(Math.max(Math.floor(limits.maxImageBytes), 16_384), 16 * 1024 * 1024)
    : DEFAULT_MAX_IMAGE_BYTES;
  return { maxTextChars, maxImageBytes };
}

export function createOutputCollector(limits) {
  const { maxTextChars, maxImageBytes } = outputLimits(limits);
  const content = [];
  let textChars = 0;
  let imageBytes = 0;
  let truncationAdded = false;
  const truncationMarker = "[output truncated]";

  function markTruncated() {
    if (truncationAdded) return;
    const last = content.at(-1);
    if (last?.type !== "text" || last.text.length < truncationMarker.length) return;
    const previousLength = last.text.length;
    last.text = `${last.text.slice(0, -truncationMarker.length)}${truncationMarker}`;
    textChars = textChars - previousLength + last.text.length;
    truncationAdded = true;
  }

  function appendText(value, itemId) {
    if (content.length >= MAX_CONTENT_ITEMS) {
      markTruncated();
      return;
    }
    let text = formatValue(value);
    const remaining = maxTextChars - textChars;
    if (remaining <= 0) {
      markTruncated();
      return;
    }
    if (text.length > remaining) {
      const marker = remaining >= truncationMarker.length ? truncationMarker : "";
      text = `${text.slice(0, Math.max(0, remaining - marker.length))}${marker}`;
      truncationAdded = Boolean(marker);
    }
    if (!text) return;
    const item = { type: "text", text };
    if (typeof itemId === "string" || typeof itemId === "number") {
      item._meta = { id: String(itemId).slice(0, MAX_META_ID_CHARS) };
    }
    content.push(item);
    textChars += text.length;
  }

  async function appendImage(value) {
    if (content.length >= MAX_CONTENT_ITEMS) {
      appendText("[image omitted because the content item limit was reached]");
      return;
    }
    const image = normalizeImage(await value);
    if (imageBytes + image.bytes.length > maxImageBytes) {
      appendText("[image omitted because it exceeded the configured size limit]");
      return;
    }
    if (content.length >= MAX_CONTENT_ITEMS) {
      appendText("[image omitted because the content item limit was reached]");
      return;
    }
    content.push({ type: "image", mimeType: image.mimeType, data: image.data });
    imageBytes += image.bytes.length;
  }

  return { content, write: appendText, emitImage: appendImage };
}

export function boundToolResult(result, limits) {
  const { maxTextChars, maxImageBytes } = outputLimits(limits);
  const content = [];
  let textChars = 0;
  let imageBytes = 0;
  const truncationMarker = "[output truncated]";
  const imageMarker = "[image omitted because it exceeded the configured size limit]";

  function appendText(text, metadata) {
    if (content.length >= MAX_CONTENT_ITEMS) return;
    const remaining = maxTextChars - textChars;
    if (remaining <= 0) return;
    let bounded = text;
    if (bounded.length > remaining) {
      const marker = remaining >= truncationMarker.length ? truncationMarker : "";
      bounded = `${bounded.slice(0, Math.max(0, remaining - marker.length))}${marker}`;
    }
    if (!bounded) return;
    const item = { type: "text", text: bounded };
    if (metadata && typeof metadata.id === "string") {
      item._meta = { id: metadata.id.slice(0, MAX_META_ID_CHARS) };
    }
    content.push(item);
    textChars += bounded.length;
  }

  for (const item of result?.content ?? []) {
    if (content.length >= MAX_CONTENT_ITEMS) break;
    if (item?.type === "text" && typeof item.text === "string") {
      appendText(item.text, item._meta);
      continue;
    }
    if (item?.type !== "image" || typeof item.data !== "string") continue;
    const estimatedBytes = Math.floor(item.data.length * 3 / 4);
    if (imageBytes + estimatedBytes > maxImageBytes) {
      appendText(imageMarker);
      continue;
    }
    if (content.length >= MAX_CONTENT_ITEMS) {
      appendText(imageMarker);
      continue;
    }
    content.push({
      type: "image",
      mimeType: typeof item.mimeType === "string" ? item.mimeType : "image/png",
      data: item.data,
    });
    imageBytes += estimatedBytes;
  }
  return { ...result, content };
}
