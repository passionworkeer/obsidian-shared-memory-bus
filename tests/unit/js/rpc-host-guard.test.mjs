// Unit tests for shared-mcp/proto/rpc.mjs — Host-header loopback guard.
// Defense against DNS-rebinding: only requests identifying loopback interfaces
// (127.0.0.1, localhost, [::1]) may reach the /mcp endpoint.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

const { isAllowedMcpHost } = await import(
  pathToFileURL(path.join(REPO_ROOT, "shared-mcp/proto/rpc.mjs")).href
);

test("isAllowedMcpHost accepts loopback hosts (with and without ports)", () => {
  assert.equal(isAllowedMcpHost("127.0.0.1"), true);
  assert.equal(isAllowedMcpHost("127.0.0.1:9331"), true);
  assert.equal(isAllowedMcpHost("localhost"), true);
  assert.equal(isAllowedMcpHost("localhost:9331"), true);
  assert.equal(isAllowedMcpHost("[::1]"), true);
  assert.equal(isAllowedMcpHost("[::1]:9331"), true);
  assert.equal(isAllowedMcpHost("  LOCALHOST:9331  "), true, "trims and case-insensitive");
});

test("isAllowedMcpHost rejects non-loopback and malformed hosts", () => {
  assert.equal(isAllowedMcpHost("evil.com"), false, "attacker domain");
  assert.equal(isAllowedMcpHost("127.0.0.1.evil.com"), false, "loopback-prefixed attacker");
  assert.equal(isAllowedMcpHost("127.0.0.2"), false, "non-loopback IPv4");
  assert.equal(isAllowedMcpHost("192.168.1.1"), false, "private RFC1918");
  assert.equal(isAllowedMcpHost(""), false, "empty");
  assert.equal(isAllowedMcpHost(undefined), false, "missing");
  assert.equal(isAllowedMcpHost(null), false, "null");
  assert.equal(isAllowedMcpHost("127.0.0.1:abc"), false, "non-numeric port");
  assert.equal(isAllowedMcpHost("127.0.0.1:"), false, "empty port");
  assert.equal(isAllowedMcpHost("evil.com:127.0.0.1"), false, "port confusion");
});