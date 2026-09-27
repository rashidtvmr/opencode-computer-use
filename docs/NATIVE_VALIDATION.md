# Native Desktop Validation

Use this checklist before marking a native operating-system target as live-certified. The headless adapter test suite does not replace these checks.

## Target matrix

- macOS arm64
- macOS x64
- Linux arm64
- Linux x64
- Windows arm64
- Windows x64

Run only on a signed-in interactive desktop session. Do not use banking, password-manager, administrator, or other high-value applications for validation.

## 1. Runtime and permissions

```sh
npx opencode-computer-use-permissions --strict
open-computer-use list-apps
```

Confirm that the native runtime starts successfully and that a disposable test application appears in the app list. Resolve Accessibility, Screen Recording, AT-SPI, UI Automation, capture, or input prerequisites before continuing.

## 2. Read-only session

Start OpenCode with `safetyMode: "read-only"` and verify:

- `cua_repl` connects.
- `cua.listApps()` returns the disposable test application.
- `cua.getApp(...)` binds it.
- `getAXState()` returns bounded state.
- `getScreenshot()` returns an image when the host supports capture.
- click, type, key, scroll, drag, value, and secondary actions are rejected by the adapter before native execution.

## 3. Controlled mutation

Use a disposable editor or test application and restore `safetyMode: "full"`.

Verify semantic click, text input, keyboard input, scrolling/drag, and a fresh state read. Coordinate/global-pointer fallback must stay disabled unless explicitly enabled. Do not automatically replay a mutating action after a timeout or transport failure; observe first.

## 4. Lifecycle and recovery

Verify `js_reset`, CPU-loop timeout recovery, normal shutdown, native-request interruption recovery, and that no orphan native process remains.

## 5. Platform-specific checks

### macOS

- Accessibility permission is granted only to the expected executable.
- Screen Recording permission is sufficient for screenshots.
- Intel and Apple Silicon use the expected packaged executable.

### Linux

- Record desktop environment and session type (X11 or Wayland).
- Verify AT-SPI exposes actionable elements for the chosen test application.
- Record the screenshot/input backend used by the native runtime.
- Treat compositor-blocked synthetic input as unsupported rather than success.

### Windows

- Run in the interactive user desktop, not a service/session-0 context.
- Verify UI Automation state and keyboard input.
- Do not cross a UAC secure desktop.
- Confirm process cleanup terminates the native process tree.

## 6. Certification record

For each target record the OS/version, architecture, Node/OpenCode/native-runtime versions, desktop/session type, permission result, app listing, AX state, screenshot, semantic input, lifecycle/recovery result, and known limitations.

Only then change public documentation from packaged/supported target to live-certified for that target.
