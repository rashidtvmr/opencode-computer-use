import test from "node:test";
import assert from "node:assert/strict";
import { main } from "../bin/opencode-computer-use-permissions.js";

test("permission command prints cross-platform help", () => {
  const output = [];
  const code = main(["--help"], {}, (text) => output.push(text));
  assert.equal(code, 0);
  assert.match(output.join("\n"), /macOS.*Accessibility.*Screen Recording/s);
  assert.match(output.join("\n"), /Linux.*AT-SPI/s);
  assert.match(output.join("\n"), /Windows.*UI Automation/s);
});

test("permission command skips CI and explicit opt-out", () => {
  for (const env of [{ CI: "true" }, { OPENCODE_COMPUTER_USE_SKIP_PERMISSIONS: "1" }]) {
    const output = [];
    const code = main([], env, (text) => output.push(text));
    assert.equal(code, 0);
    assert.match(output.join("\n"), /skipped/);
  }
});

test("permission command is best-effort without a native runtime", () => {
  const env = { OPEN_COMPUTER_USE_NATIVE_COMMAND: "/definitely/missing/open-computer-use" };
  const output = [];
  assert.equal(main([], env, (text) => output.push(text)), 0);
  assert.match(output.join("\n"), /Permission check failed/);
  assert.equal(main(["--strict"], env, (text) => output.push(text)), 1);
});

test("permission command rejects unknown options", () => {
  const output = [];
  assert.equal(main(["--unknown"], {}, (text) => output.push(text)), 2);
  assert.match(output.join("\n"), /Unknown permission option/);
});
