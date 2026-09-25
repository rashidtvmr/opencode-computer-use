# Security Policy

This plugin exposes a persistent JavaScript session that can observe and control
the interactive desktop as the current user. The VM is not a complete security
sandbox.

## Default protections

- The OpenCode host starts the local MCP server.
- The MCP server starts a fixed native runtime without a shell.
- The model-facing surface contains only `js` and `js_reset`.
- The `cua` API has no arbitrary shell operation.
- JavaScript executes in a restricted VM context inside a worker and timed-out
  evaluations are terminated.
- `require`, `process`, `fetch`, Node built-ins, filesystem access, dynamic
  imports, code generation, and dynamic host objects are unavailable in the
  model-facing context.
- Native calls are serialized through the persistent session.
- `safetyMode: "read-only"` blocks mutating CUA methods before native execution.
- `appAccess` can deny apps by exact name or ID before native access.
- App bindings, output items, text, images, and native frames are bounded.
- Native timeouts send a cancellation notification; shutdown sends a best-effort
  turn-ended notification.
- Desktop environment variables are allowlisted.
- Screenshot and text results remain local MCP content.

## Operator responsibilities

- Review the native runtime and its source before installation.
- Grant only the OS permissions required for the target desktop.
- Keep OpenCode approval prompts enabled for consequential actions.
- Do not run unattended against banking, password-manager, administrator, or
  other high-value sessions.
- Treat screenshots, accessibility trees, and typed text as sensitive data.
- Lock or switch the desktop session when the agent is not needed.

## Reporting a vulnerability

Do not include screenshots, accessibility content, credentials, or raw model
transcripts in a public issue. Report suspected vulnerabilities privately to the
maintainer with a minimal reproduction and affected version.
