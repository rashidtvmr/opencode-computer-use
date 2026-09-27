import test from "node:test";
import assert from "node:assert/strict";
import { platformGuidance } from "../bin/opencode-computer-use-permissions.js";

test("permission guidance explains what each desktop can automate", () => {
  assert.match(platformGuidance("darwin").join("\n"), /Accessibility.*Screen Recording/s);
  assert.match(platformGuidance("darwin").join("\n"), /human approval/);
  assert.match(platformGuidance("linux").join("\n"), /gsettings set.*toolkit-accessibility/s);
  assert.match(platformGuidance("linux").join("\n"), /Wayland.*compositor-dependent/s);
  assert.match(platformGuidance("win32").join("\n"), /no separate UI Automation permission toggle/i);
  assert.match(platformGuidance("win32").join("\n"), /interactive desktop session/i);
});
