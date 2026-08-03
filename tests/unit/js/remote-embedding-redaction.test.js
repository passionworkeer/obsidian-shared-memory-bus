import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  redactRemoteEmbeddingTexts,
  redactSensitiveText,
} from "../../../bus/redaction.js";
import { createOpenAICompatibleProvider } from "../../../bus/embedding-providers/openai-compatible-provider.js";
import { createGeminiProvider } from "../../../bus/embedding-providers/gemini-provider.js";

const originalRedaction = process.env.AI_MEMORY_REDACTION_ENABLED;

afterEach(() => {
  if (originalRedaction === undefined) delete process.env.AI_MEMORY_REDACTION_ENABLED;
  else process.env.AI_MEMORY_REDACTION_ENABLED = originalRedaction;
});

test("redacts common credentials and email without changing batch shape", () => {
  const input = [
    "api_key=super-secret-value user@example.com",
    "Bearer abcdefghijklmnopqrstuvwxyz",
    "github ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
  ];
  const output = redactRemoteEmbeddingTexts(input);

  assert.equal(output.length, input.length);
  assert.equal(output.some((text) => text.includes("super-secret-value")), false);
  assert.equal(output.some((text) => text.includes("user@example.com")), false);
  assert.equal(output.some((text) => text.includes("abcdefghijklmnopqrstuvwxyz")), false);
  assert.equal(output.some((text) => text.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456")), false);
  assert.equal(output.every((text) => text.includes("REDACTED")), true);
});

test("explicit redaction opt-out remains available", () => {
  process.env.AI_MEMORY_REDACTION_ENABLED = "false";
  const secret = "api_key=super-secret-value";
  assert.equal(redactSensitiveText(secret), secret);
});

test("OpenAI-compatible provider sends only redacted input", async () => {
  let outbound;
  const provider = createOpenAICompatibleProvider({
    sleep: async () => {},
    fetchImpl: async (_url, options) => {
      outbound = JSON.parse(options.body);
      return {
        ok: true,
        async json() {
          return {
            data: outbound.input.map((_text, index) => ({ index, embedding: [index + 1] })),
          };
        },
      };
    },
  });

  await provider.embedWithOpenAICompatible(
    ["fact api_key=super-secret-value", "contact user@example.com"],
    {
      baseUrl: "https://embeddings.example/v1",
      apiKey: "provider-key-not-part-of-text",
      model: "test-model",
      maxRetries: 0,
    },
  );

  assert.equal(JSON.stringify(outbound).includes("super-secret-value"), false);
  assert.equal(JSON.stringify(outbound).includes("user@example.com"), false);
  assert.equal(outbound.input.every((text) => text.includes("REDACTED")), true);
});

test("Gemini pool receives only redacted text", async () => {
  let request;
  const pool = {
    buildWorkerScript: () => "pass",
    initPool: async () => {},
    embedWithPool: async (payload) => {
      request = payload;
      return payload.texts.map((_text, index) => [index + 1]);
    },
  };
  const provider = createGeminiProvider({
    pythonRuntime: { available: true, command: "python" },
    withPythonArgs: (_runtime, args) => args,
    getPool: async () => pool,
  });

  await provider.embedWithGemini(
    ["password=correct-horse-battery-staple", "Bearer abcdefghijklmnop"],
    { apiKey: "provider-key", model: "gemini-embedding-2" },
  );

  assert.equal(JSON.stringify(request.texts).includes("correct-horse-battery-staple"), false);
  assert.equal(JSON.stringify(request.texts).includes("abcdefghijklmnop"), false);
  assert.equal(request.texts.every((text) => text.includes("REDACTED")), true);
});
