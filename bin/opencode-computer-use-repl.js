#!/usr/bin/env node

import { resolveNativeCommand, runServer } from "../lib/repl.mjs";

const native = resolveNativeCommand(process.argv.slice(2));
runServer(native).catch((error) => {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/\b(token|secret|password|api[_-]?key|authorization)\s*[:=]\s*(?:bearer|basic)?[^\n\r,;]*/giu, "$1=[redacted]")
    .slice(0, 4_000);
  process.stderr.write(`[opencode-computer-use] ${message}\n`);
  process.exitCode = 1;
});
