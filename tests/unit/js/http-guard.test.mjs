import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isAllowedLocalHttpRequest,
  isAllowedLocalOrigin,
  isAllowedLoopbackHost,
} from "../../../shared-mcp/proto/http-guard.mjs";

test("loopback host validation rejects rebinding hosts", () => {
  assert.equal(isAllowedLoopbackHost("127.0.0.1:9341"), true);
  assert.equal(isAllowedLoopbackHost("localhost:9341"), true);
  assert.equal(isAllowedLoopbackHost("[::1]:9341"), true);
  assert.equal(isAllowedLoopbackHost("evil.example:9341"), false);
  assert.equal(isAllowedLoopbackHost("127.0.0.1.evil.example"), false);
  assert.equal(isAllowedLoopbackHost(""), false);
});

test("native clients without browser metadata remain supported", () => {
  assert.equal(isAllowedLocalHttpRequest({ host: "127.0.0.1:9341" }), true);
  assert.equal(isAllowedLocalHttpRequest({ host: "localhost:9341" }), true);
});

test("browser requests must be exact same-origin loopback", () => {
  assert.equal(
    isAllowedLocalHttpRequest({
      host: "127.0.0.1:9341",
      origin: "http://127.0.0.1:9341",
      "sec-fetch-site": "same-origin",
    }),
    true,
  );
  assert.equal(
    isAllowedLocalHttpRequest({
      host: "127.0.0.1:9341",
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    }),
    false,
  );
  assert.equal(
    isAllowedLocalHttpRequest({
      host: "127.0.0.1:9341",
      origin: "http://127.0.0.1:3000",
      "sec-fetch-site": "same-site",
    }),
    false,
  );
  assert.equal(
    isAllowedLocalHttpRequest({
      host: "127.0.0.1:9341",
      "sec-fetch-site": "cross-site",
    }),
    false,
  );
});

test("origins reject null, credentials, paths and host aliases", () => {
  assert.equal(isAllowedLocalOrigin("", "127.0.0.1:9341"), true);
  assert.equal(isAllowedLocalOrigin("null", "127.0.0.1:9341"), false);
  assert.equal(isAllowedLocalOrigin("http://localhost:9341", "127.0.0.1:9341"), false);
  assert.equal(isAllowedLocalOrigin("http://user@127.0.0.1:9341", "127.0.0.1:9341"), false);
  assert.equal(isAllowedLocalOrigin("http://127.0.0.1:9341/path", "127.0.0.1:9341"), false);
});
