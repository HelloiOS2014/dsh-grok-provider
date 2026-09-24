import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { Context, Service } from "@deepseek-ai/cordis"
import { isVolatile, updateVolatile } from "@deepseek-ai/cosmokit"
import LlmRuntime, { LlmError } from "@deepseek-ai/dsh-llm"

import * as grokPlugin from "../src/host/index.mjs"
import { mapLlmError } from "../src/internal/llm-error.mjs"
import {
  InvalidRequestImageProjectionError,
  UnsupportedImageInputError,
  UnsupportedSearchCapabilityError,
} from "../src/internal/responses-request-compiler.mjs"
import { UnsupportedResponsesRequestError } from "../src/internal/responses-request.mjs"

const hostApplySupported = process.platform === "darwin" || process.platform === "win32"

test("the Host loads against the DSH 0.1.7-rc.1 settings API", async () => {
  const settings = await import("@deepseek-ai/dsh-settings")
  assert.equal(settings.installSettingsSection, undefined)
  assert.equal(settings.settingsNamespace, undefined)
  assert.equal(typeof settings.default.prototype.configure, "function")
  assert.equal(typeof settings.default.prototype.describe, "function")
  assert.equal(grokPlugin.name, "llm-grok")
  assert.equal(typeof grokPlugin.apply, "function")
})

test("the Host plugin registers and cleanly removes the Grok provider in the real LLM runtime", {
  skip: hostApplySupported ? false : "Host apply is macOS/Windows only",
}, async () => {
  const ctx = new Context()
  const llmFiber = ctx.plugin(LlmRuntime)
  await llmFiber
  const grokFiber = ctx.plugin(grokPlugin)
  await grokFiber

  assert.deepEqual(ctx.llm.listProviders(), [{ id: "grok", name: "Grok Build" }])

  await grokFiber.dispose()
  assert.deepEqual(ctx.llm.listProviders(), [])
  await llmFiber.dispose()
})

test("the Host owns its settings presentation without a duplicate generated page", {
  skip: hostApplySupported ? false : "Host apply is macOS/Windows only",
}, async () => {
  const ctx = new Context()
  const settingsFiber = ctx.plugin(RecordingSettings)
  await settingsFiber
  const llmFiber = ctx.plugin(LlmRuntime)
  await llmFiber
  const grokFiber = ctx.plugin(grokPlugin)
  await grokFiber

  assert.deepEqual(ctx.settings.presentations, [{ auto: false }])

  await grokFiber.dispose()
  assert.deepEqual(ctx.settings.presentations, [])
  await llmFiber.dispose()
  await settingsFiber.dispose()
})

test("the Host exposes opt-in Search policy without a selectable authentication mode", () => {
  const defaults = grokPlugin.Config({})
  assert.equal(isVolatile(defaults.webSearch), true)
  assert.equal(isVolatile(defaults.xSearch), true)
  assert.deepEqual({ webSearch: defaults.webSearch.get(), xSearch: defaults.xSearch.get() }, {
    webSearch: false,
    xSearch: false,
  })
  const enabled = grokPlugin.Config({ webSearch: true, xSearch: false })
  assert.deepEqual({ webSearch: enabled.webSearch.get(), xSearch: enabled.xSearch.get() }, {
    webSearch: true,
    xSearch: false,
  })
  assert.throws(() => grokPlugin.Config({ webSearch: "true" }), TypeError)
  assert.doesNotMatch(String(grokPlugin.Config), /authMode/u)
  assert.deepEqual(Object.keys(grokPlugin).sort(), ["Config", "apply", "inject", "name"])
})

test("the Host reads live Search settings while prepared calls keep their snapshot", {
  skip: hostApplySupported ? false : "Host apply is macOS/Windows only",
}, async () => {
  const originalFetch = globalThis.fetch
  const originalHome = process.env.HOME
  const originalUserProfile = process.env.USERPROFILE
  const fixtureHome = await mkdtemp(join(tmpdir(), "dsh-grok-host-config-"))
  const authDir = join(fixtureHome, ".grok")
  let grokFiber
  let llmFiber
  const capturedRequests = []

  try {
    await mkdir(authDir)
    await writeFile(join(authDir, "auth.json"), JSON.stringify(officialCredentialFixture()), {
      mode: 0o600,
    })
    process.env.HOME = fixtureHome
    process.env.USERPROFILE = fixtureHome
    globalThis.fetch = async (url, init = {}) => {
      if (url === "https://cli-chat-proxy.grok.com/v1/models") {
        return new Response(modelCatalogFixture(), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url === "https://cli-chat-proxy.grok.com/v1/responses") {
        capturedRequests.push(JSON.parse(init.body))
        return new Response(completedResponseFixture(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      }
      throw new Error(`Unexpected fixture URL: ${url}`)
    }

    const ctx = new Context()
    llmFiber = ctx.plugin(LlmRuntime)
    await llmFiber
    grokFiber = ctx.plugin(grokPlugin, { webSearch: true })
    await grokFiber

    const requestOptions = (id) => ({
      provider: "grok",
      model: "grok-4.6",
      messages: [{
        id,
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "Find the official documentation" }],
      }],
    })

    for await (const _chunk of ctx.llm.stream(requestOptions("composition-fallback"))) {}

    const prepared = await ctx.llm.prepareCall({ provider: "grok", model: "grok-4.6" })
    const updated = grokPlugin.Config({ xSearch: true })
    updateVolatile(grokFiber.config.webSearch, updated.webSearch)
    updateVolatile(grokFiber.config.xSearch, updated.xSearch)
    for await (const _chunk of prepared.stream(requestOptions("prepared-before-update"))) {}
    for await (const _chunk of ctx.llm.stream(requestOptions("created-after-update"))) {}

    assert.deepEqual(capturedRequests.map((request) => request.tools), [
      [{ type: "web_search" }],
      [{ type: "web_search" }],
      [{ type: "x_search" }],
    ])
  } finally {
    globalThis.fetch = originalFetch
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    try {
      await grokFiber?.dispose()
    } finally {
      try {
        await llmFiber?.dispose()
      } finally {
        await rm(fixtureHome, { recursive: true, force: true })
      }
    }
  }
})

class RecordingSettings extends Service {
  presentations = []

  constructor(ctx) {
    super(ctx, "settings")
  }

  configure(presentation) {
    this.presentations.push(presentation)
    return () => { this.presentations = this.presentations.filter((item) => item !== presentation) }
  }
}

test("the Host distinguishes image and Search policy failures from invalid generic requests", () => {
  assert.equal(mapLlmError(new UnsupportedImageInputError()).code, "UNSUPPORTED_CONTENT")
  assert.equal(mapLlmError(new UnsupportedSearchCapabilityError()).code, "UNSUPPORTED_CONTENT")
  assert.equal(mapLlmError(Object.assign(new Error("unsupported projection"), {
    code: "ATTACHMENT_PROJECTION_UNSUPPORTED",
  })).code, "UNSUPPORTED_CONTENT")
  assert.equal(mapLlmError(new InvalidRequestImageProjectionError()).code, "INVALID_RESPONSE")
  assert.equal(mapLlmError(new UnsupportedResponsesRequestError()).code, "INVALID_RESPONSE")
})

test("an aborted request maps an existing LLM error to ABORTED", () => {
  const controller = new AbortController()
  const reason = new LlmError("fixture", "AUTH")
  controller.abort(reason)

  const mapped = mapLlmError(reason, controller.signal)

  assert.equal(mapped.code, "ABORTED")
  assert.notEqual(mapped, reason)
  assert.equal(mapped.cause, reason)
})

function officialCredentialFixture() {
  const clientId = "b1a00492-073a-47ea-816f-4c329264a828"
  return {
    [`https://auth.x.ai::${clientId}`]: {
      auth_mode: "oidc",
      oidc_issuer: "https://auth.x.ai",
      oidc_client_id: clientId,
      key: "fixture-access-token",
      expires_at: "2999-01-01T00:00:00.000Z",
    },
  }
}

function modelCatalogFixture() {
  return JSON.stringify({
    object: "list",
    data: [{
      id: "grok-4.6",
      name: "Grok 4.6",
      context_window: 500000,
      api_backend: "responses",
      supports_reasoning_effort: false,
    }],
  })
}

function completedResponseFixture() {
  const events = [
    { type: "response.created", sequence_number: 0, response: { status: "in_progress" } },
    { type: "response.in_progress", sequence_number: 1, response: { status: "in_progress" } },
    { type: "response.output_item.added", sequence_number: 2, output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] } },
    { type: "response.content_part.added", sequence_number: 3, output_index: 0, item_id: "msg_1", part: { type: "output_text", text: "" } },
    { type: "response.output_text.delta", sequence_number: 4, output_index: 0, item_id: "msg_1", delta: "OK" },
    { type: "response.output_text.done", sequence_number: 5, output_index: 0, item_id: "msg_1", text: "OK" },
    { type: "response.content_part.done", sequence_number: 6, output_index: 0, item_id: "msg_1", part: { type: "output_text", text: "OK" } },
    { type: "response.output_item.done", sequence_number: 7, output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", status: "completed" } },
    { type: "response.completed", sequence_number: 8, response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } },
  ]
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")
}
