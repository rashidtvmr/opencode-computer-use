import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseJsonc } from "jsonc-parser";
import {
  FALLBACK_INSTRUCTIONS,
  configFiles,
  globalConfigDir,
  inferScope,
  main,
  setup,
  updateConfigText,
} from "../bin/opencode-computer-use-setup.js";

function temporaryProject() {
  return mkdtempSync(join(tmpdir(), "opencode-computer-use-setup-"));
}

function quiet() {}

test("adds the V1 tuple without removing JSONC comments", () => {
  const source = `{
  // keep this comment
  "theme": "dark",
  "plugin": [],
}
`;
  const first = updateConfigText(source, "v1");
  assert.equal(first.changed, true);
  assert.match(first.text, /keep this comment/);
  assert.deepEqual(parseJsonc(first.text), {
    theme: "dark",
    plugin: [["@frontendxlab/opencode-computer-use", { backend: "auto" }]],
  });
  const second = updateConfigText(first.text, "v1");
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);
});

test("adds the V2 string entry and recognizes object entries", () => {
  const first = updateConfigText('{ "plugins": [] }', "v2");
  assert.equal(first.changed, true);
  assert.deepEqual(JSON.parse(first.text).plugins, ["@frontendxlab/opencode-computer-use"]);
  const second = updateConfigText('{ "plugins": [{ "package": "@frontendxlab/opencode-computer-use" }] }', "v2");
  assert.equal(second.changed, false);
});

test("rejects invalid or conflicting configuration shapes", async () => {
  assert.throws(
    () => updateConfigText('{ "plugin": {} }', "v1"),
    /not an array/,
  );
  assert.throws(
    () => updateConfigText('{ "plugin": [], "plugins": [] }', "v1"),
    /both plugin and plugins/,
  );
  const project = temporaryProject();
  try {
    writeFileSync(join(project, "opencode.json"), '{ "plugin": [], "plugins": [] }');
    await assert.rejects(
      setup({ scope: "local", flavor: "v1" }, { INIT_CWD: project, PATH: "" }, quiet),
      /ambiguous configuration|both plugin and plugins/,
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("creates an idempotent local configuration", async () => {
  const project = temporaryProject();
  try {
    const env = { INIT_CWD: project, PATH: "" };
    const first = await setup({ scope: "local", flavor: "v1" }, env, quiet);
    assert.equal(first.changed, true);
    const file = join(project, "opencode.json");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).plugin, [
      ["@frontendxlab/opencode-computer-use", { backend: "auto" }],
    ]);
    const second = await setup({ scope: "local", flavor: "v1" }, env, quiet);
    assert.equal(second.changed, false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("honors an explicit OpenCode config path and protects inline config", async () => {
  const project = temporaryProject();
  const custom = join(project, "custom.opencode.jsonc");
  try {
    assert.deepEqual(configFiles(project, "local", { OPENCODE_CONFIG: custom }), [custom]);
    await assert.rejects(
      setup({ scope: "local", flavor: "v2" }, { INIT_CWD: project, PATH: "", OPENCODE_CONFIG_CONTENT: "{}" }, quiet),
      /OPENCODE_CONFIG_CONTENT is immutable/,
    );
    await setup({ scope: "local", flavor: "v2" }, { INIT_CWD: project, PATH: "", OPENCODE_CONFIG: custom }, quiet);
    assert.deepEqual(JSON.parse(readFileSync(custom, "utf8")).plugins, ["@frontendxlab/opencode-computer-use"]);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("uses package-manager scope and platform-specific global paths", () => {
  assert.equal(inferScope("auto", { npm_config_global: "true" }), "global");
  assert.equal(inferScope("auto", {}), "local");
  assert.equal(globalConfigDir({ XDG_CONFIG_HOME: "/tmp/opencode-config" }), "/tmp/opencode-config/opencode");
  assert.equal(globalConfigDir({ USERPROFILE: "/tmp/opencode-home" }), "/tmp/opencode-home/.config/opencode");
});

test("creates the V2 local configuration", async () => {
  const project = temporaryProject();
  try {
    const result = await setup({ scope: "local", flavor: "v2" }, { INIT_CWD: project, PATH: "" }, quiet);
    assert.equal(result.changed, true);
    assert.deepEqual(JSON.parse(readFileSync(join(project, "opencode.json"), "utf8")).plugins, [
      "@frontendxlab/opencode-computer-use",
    ]);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("missing CLIs produce a non-destructive fallback", async () => {
  const project = temporaryProject();
  const output = [];
  try {
    const code = await main(["--auto"], { INIT_CWD: project, PATH: "" }, (text, stream) => output.push(`${stream}:${text}`));
    assert.equal(code, 0);
    assert.match(output.join("\n"), /neither opencode nor opencode2 was found/);
    assert.match(output.join("\n"), /For OpenCode 1/);
    assert.equal(existsSync(join(project, "opencode.json")), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("does not mutate configuration in CI", async () => {
  const project = temporaryProject();
  const output = [];
  try {
    const code = await main(["--auto"], { CI: "true", INIT_CWD: project, PATH: "" }, (text, stream) => output.push(`${stream}:${text}`));
    assert.equal(code, 0);
    assert.match(output.join("\n"), /skipped in CI/);
    assert.equal(existsSync(join(project, "opencode.json")), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("manual failures print both configuration formats", async () => {
  const output = [];
  const code = await main(["--definitely-invalid"], {}, (text, stream) => output.push(`${stream}:${text}`));
  assert.equal(code, 2);
  assert.match(output.join("\n"), /Usage: opencode-computer-use-setup/);
  assert.match(FALLBACK_INSTRUCTIONS, /opencode2 plugin add @frontendxlab\/opencode-computer-use/);
});
