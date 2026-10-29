import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, statSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "t3-mcp-configure-"));
  mkdirSync(join(root, "scripts"));
  const script = join(root, "scripts/configure.mjs");
  copyFileSync(new URL("../scripts/configure.mjs", import.meta.url), script);
  const cli = join(root, "fake-t3");
  writeFileSync(cli, '#!/bin/sh\nprintf "%s\\n" "fixture-only-not-a-real-token-123456789"\n', { mode: 0o700 });
  return { root, script, cli };
}

test("configure protects credentials, keeps separate tokens, and refuses to overwrite", { skip: process.platform === "win32" }, () => {
  const { root, script, cli } = fixture();
  try {
    const first = spawnSync(process.execPath, [script, "--t3-cli", cli, "--url", "https://mcp.example.com/"], { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const env = readFileSync(join(root, ".env"), "utf8");
    const config = JSON.parse(readFileSync(join(root, "remote-client.json"), "utf8"));
    assert.equal(config.mcpServers.t3code.url, "https://mcp.example.com/");
    assert.equal(config.mcpServers.t3code.headers.Authorization, `Bearer ${env.match(/^MCP_HTTP_TOKEN=(.*)$/m)[1]}`);
    assert.ok(!first.stdout.includes("fixture-only"));
    assert.ok(!first.stdout.includes(env.match(/^MCP_HTTP_TOKEN=(.*)$/m)[1]));
    assert.equal(statSync(join(root, ".env")).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, "remote-client.json")).mode & 0o777, 0o600);
    const second = spawnSync(process.execPath, [script, "--t3-cli", cli], { encoding: "utf8" });
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /refusing to overwrite/);
    assert.equal(readFileSync(join(root, ".env"), "utf8"), env);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("configure rejects remote plain HTTP before issuing credentials", () => {
  const { root, script, cli } = fixture();
  try {
    const result = spawnSync(process.execPath, [script, "--t3-cli", cli, "--url", "http://mcp.example.com/"], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /HTTPS/);
    assert.equal(existsSync(join(root, ".env")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
