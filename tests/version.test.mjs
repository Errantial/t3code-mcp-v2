import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), "utf8");
const version = JSON.parse(read("package.json")).version;

test("package, server, verify script and release docs share one version", () => {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.match(read("src/index.ts"), new RegExp(`const VERSION = "${version}";`));

  const verify = read("scripts/verify.mjs");
  assert.match(verify, /package\.json/);
  assert.match(verify, /expectedVersion/);
  assert.doesNotMatch(
    verify,
    /getServerVersion\(\)\?\.version,\s*["']\d/,
    "verify.mjs must not hardcode the expected MCP version",
  );

  assert.match(read("README.md"), new RegExp(`Current version: ${version}`));
  const prompt = read("AGENT_PROMPT.md");
  const setup = read("AGENT_SETUP.md");
  assert.match(prompt, new RegExp(`t3code-mcp ${version}`));
  assert.match(setup, new RegExp(`package\\.json\` version is \`${version}\``));

  const downloads = join(root, "downloads");
  if (existsSync(downloads)) {
    assert.ok(existsSync(join(downloads, `t3code-mcp-v2-${version}.tar.gz`)));
    assert.ok(
      existsSync(join(downloads, `t3code-mcp-v2-${version}.tar.gz.sha256`)),
    );
  }
});
