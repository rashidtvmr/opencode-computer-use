# Third-party notices

## Open Codex Computer Use

The persistent JavaScript session adapter in `lib/repl.mjs`,
`lib/repl-kernel.mjs`, and `lib/sandbox.mjs` is adapted from:

- Project: `iFurySt/open-codex-computer-use`
- URL: https://github.com/iFurySt/open-codex-computer-use
- License: MIT
- Copyright: Copyright (c) 2026 Leo
- Source revision: `51f3a590e734c374b627c25ca9831a912eb02b14`

The native runtime is installed separately as the optional dependency
`open-computer-use@0.3.5`, which is distributed under the same MIT license.

The automatic setup command uses `jsonc-parser@3.3.1`, copyright Microsoft
Corporation and contributors, under the MIT license. It is used only to make
targeted edits to OpenCode JSONC configuration files.

The adapter was changed to resolve the optional runtime package, use a
minimal desktop environment allowlist, expose the session through the
OpenCode plugin entrypoint, and run model code in a restricted VM context.

The original MIT license text must remain available in the upstream project
and in the installed `open-computer-use` package.
