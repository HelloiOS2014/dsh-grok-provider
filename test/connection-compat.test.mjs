import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"
import os from "node:os"
import { mkdtemp, rm } from "node:fs/promises"
import packageJson from "../package.json" with { type: "json" }
import test from "node:test"

// Run against a complete target Harness installation, not a mocked RPC registry.
const modules = process.env.DSH_COMPAT_NODE_MODULES ?? path.resolve(import.meta.dirname, "../node_modules")
const supported = process.platform === "darwin" || process.platform === "win32"

test("Grok status and diagnostics use the real shared Connection carrier and dispose cleanly", {
  skip: !supported,
}, async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "grok-rpc-compat-"))
  t.mock.method(os, "homedir", () => home)
  t.after(() => rm(home, { recursive: true, force: true }))
  const require = createRequire(path.join(modules, "compat-fixture.cjs"))
  const load = (name) => import(pathToFileURL(require.resolve(name)).href)
  const { Context } = await load("@deepseek-ai/cordis")
  const { HostConnectionService } = await load("@deepseek-ai/dsh-client-connection")
  const { default: LlmRuntime } = await load("@deepseek-ai/dsh-llm")
  const plugin = await import("../src/host/index.mjs")
  const ctx = new Context()
  const llm = ctx.plugin(LlmRuntime)
  await llm
  const connection = ctx.plugin({
    name: "compat-connection",
    apply(ctx) {
      // Authentication is exercised separately; no real credentials are read.
      new HostConnectionService(ctx, [], { isAuthenticated: () => true })
    },
  })
  await connection
  const grok = ctx.plugin(plugin)
  await grok
  const shared = ctx.connection.createSharedFetchHandler("/api")
  const request = (endpoint, overrides = {}) => new Request(`http://localhost/api/grok-auth/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: endpoint, method: `grok-auth/${endpoint}`, payload: {}, ...overrides }),
  })
  try {
    for (const endpoint of ["status", "diagnostics"]) {
      const response = await shared.fetch(request(endpoint))
      assert.equal(response.status, 200, `${endpoint} must be reachable through the shared API carrier`)
      const body = await response.json()
      assert.equal(body.rpcId, endpoint)
      assert.equal(body.result.ok, true)
      assert.equal(body.result.value.kind, endpoint)
      if (endpoint === "diagnostics") assert.equal(body.result.value.diagnostics.pluginVersion, packageJson.version)
    }
    assert.equal((await shared.fetch(request("status", { method: "grok-auth/logout" }))).status, 400)
    assert.equal((await shared.fetch(request("unknown"))).status, 404)
    assert.equal(ctx.connection.requestRejection({ headers: new Headers({ host: "localhost", origin: "https://evil.example" }) }), 403)
    await grok.dispose()
    assert.equal((await shared.fetch(request("status"))).status, 404, "Plugin disposal must remove its exact routes")
  } finally {
    await grok.dispose()
    await connection.dispose()
    await llm.dispose()
  }
})
