import assert from "node:assert/strict"
import test from "node:test"
import { clientRequestSchema } from "@deepseek-ai/dsh-client-connection"
import { createAuthFetchRoutes } from "../../../src/internal/auth-fetch.mjs"

function request(body, contentType = "application/json", signal) {
  return new Request("http://localhost/api/grok-auth/status", {
    method: "POST", headers: { "content-type": contentType }, body, signal,
  })
}
const message = { type: "client-request", rpcId: "test-1", method: "grok-auth/status", payload: {} }

test("auth Fetch rejects malformed and misdirected envelopes before invoking account operations", async () => {
  let calls = 0
  const [route] = createAuthFetchRoutes(async () => { calls++; return { ok: true, value: {} } }, clientRequestSchema)
  for (const body of ["{", "null", "{}", JSON.stringify({ ...message, rpcId: 42 }), JSON.stringify({ ...message, method: "grok-auth/logout" })]) {
    assert.equal((await route.fetch(request(body))).status, 400)
  }
  assert.equal((await route.fetch(request(JSON.stringify(message), "text/plain"))).status, 415)
  assert.equal(calls, 0)
})

test("auth Fetch preserves request correlation, payload and cancellation without exposing transport details", async () => {
  let received
  const result = { ok: false, error: { code: "cancelled", message: "cancelled", details: {} } }
  const [route] = createAuthFetchRoutes(async (...args) => { received = args; return result }, clientRequestSchema)
  const controller = new AbortController()
  controller.abort()
  const response = await route.fetch(request(JSON.stringify(message), "application/json; charset=utf-8", controller.signal))
  assert.equal(received[0], "status")
  assert.deepEqual(received[1], {})
  assert.equal(received[2].aborted, true)
  assert.deepEqual(await response.json(), { type: "server-response", rpcId: "test-1", result })
})
