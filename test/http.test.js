import assert from "node:assert/strict";
import test from "node:test";

import { readBoundedJsonResponse } from "../src/http.js";

test("reads a JSON response within the declared and actual byte limit", async () => {
  const response = Response.json({ ok: true });
  assert.deepEqual(await readBoundedJsonResponse(response, 100), { ok: true });
});
test("rejects malformed lengths, oversized streams, and malformed JSON", async () => {
  for (const response of [
    new Response("{}", { headers: { "content-length": "unknown" } }),
    new Response("{}", { headers: { "content-length": "101" } }),
    new Response(JSON.stringify({ value: "x".repeat(200) })),
    new Response("{"),
  ]) {
    await assert.rejects(() => readBoundedJsonResponse(response, 100));
  }
});
