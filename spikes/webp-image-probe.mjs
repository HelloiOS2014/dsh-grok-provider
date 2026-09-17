import os from "node:os"
import path from "node:path"

import { attributionHeaders } from "@deepseek-ai/dsh-llm"

import { GROK_PRODUCTION_OIDC_AUTH_CONTRACT, createCredentialSource } from "../src/internal/credential-source.mjs"
import { createGrokTransport } from "../src/internal/grok-transport.mjs"
import { createOfficialCredentialLoader } from "../src/internal/official-credential-loader.mjs"

const CONFIRMATION_ENV = "DSH_GROK_CONFIRM_WEBP_PROBE"
const CONFIRMATION_VALUE = "YES"
const PROXY_ORIGIN = "https://cli-chat-proxy.grok.com"
const MODEL_ID = "grok-4.6"
const MAX_CAPTURED_BYTES = 512 * 1024
const MAX_ERROR_SNIPPET = 300
const PROMPT_PREFIX = "Inspect this synthetic test image."
const PROMPT_SUFFIX = "Identify the single solid color filling this image. Reply with exactly one lowercase basic color word and no punctuation."
const COLOR_WORDS = ["blue", "red", "green", "yellow", "black", "white", "purple", "orange", "pink", "gray", "grey"]

const FIXTURES = Object.freeze({
  "alpha-webp": Object.freeze({
    mediaType: "image/webp",
    base64: "UklGRnwAAABXRUJQVlA4WAoAAAAQAAAAPwAAPwAAQUxQSBAAAAABB1D9iAgACeH/ey2i/6kfVlA4IEYAAADwAwCdASpAAEAAPjEYi0QiIaERBAAgAwS0gDsAfgAAEDdTUAV4hbkAAP79Xc///8LM/hZn8LM/+Fmf//CrcMQydAAAAAAA",
  }),
  "opaque-webp": Object.freeze({
    mediaType: "image/webp",
    base64: "UklGRlIAAABXRUJQVlA4IEYAAADwAwCdASpAAEAAPjEYi0QiIaERBAAgAwS0gDsAfgAAEDdTUAV4hbkAAP79Xc///8LM/hZn8LM/+Fmf//CrcMQydAAAAAAA",
  }),
  "alpha-png": Object.freeze({
    mediaType: "image/png",
    base64: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAuUlEQVR4nOXOoQEAAAjAoP1/skXPIBjoVDu/pQNaOqClA1o6oKUDWjqgpQNaOqClA1o6oKUDWjqgpQNaOqClA1o6oKUDWjqgpQNaOqClA1o6oKUDWjqgpQNaOqClA1o6oKUDWjqgpQNaOqClA1o6oKUDWjqgpQNaOqClA1o6oKUDWjqgpQNaOqClA1o6oKUDWjqgpQNaOqClA1o6oKUDWjqgpQNaOqClA1o6oKUDWjqgpQNaOqClA1o6oKUDWjqgpQNaOqClA1o6oKUDWjqgpQNaOqClA9YBQxKR0pAP0qAAAAAASUVORK5CYII=",
  }),
})

function fail(code) {
  console.log(`PROBE FAIL ${code}`)
  process.exit(1)
}

function sanitize(text, limit) {
  const printable = text.replace(/[^\x20-\x7e\u00a0-\uffff]/gu, " ").replace(/\s+/gu, " ").trim()
  return printable.length <= limit ? printable : `${printable.slice(0, limit)}...`
}

function countColorWords(text) {
  const lower = text.toLowerCase()
  return COLOR_WORDS.filter((word) => new RegExp(`\\b${word}\\b`, "u").test(lower))
}

async function main() {
  if (process.platform !== "darwin") fail("unsupported-platform")
  if (process.env[CONFIRMATION_ENV] !== CONFIRMATION_VALUE) fail("confirmation-required")
  if (!process.env.PROXY_ORIGIN_ALLOWED) process.env.PROXY_ORIGIN_ALLOWED = PROXY_ORIGIN

  const state = { posts: 0, blocked: 0, lastStatus: undefined, lastContentType: undefined, lastErrorBody: undefined }
  const networkFetch = globalThis.fetch
  const credentialSource = createCredentialSource({
    contract: GROK_PRODUCTION_OIDC_AUTH_CONTRACT,
    load: createOfficialCredentialLoader({
      authPath: path.join(os.homedir(), ".grok", "auth.json"),
      platform: "darwin",
    }),
    now: () => new Date(),
  })
  const transport = createGrokTransport({
    credentialSource,
    fetch: guardedFetch(networkFetch, state),
    attributionHeaders,
    clientIdentifier: "dsh-grok-provider",
    clientVersion: "1.0.5-webp-probe",
  })

  for (const [name, fixture] of Object.entries(FIXTURES)) {
    state.lastStatus = undefined
    state.lastContentType = undefined
    state.lastErrorBody = undefined
    const request = {
      model: MODEL_ID,
      store: false,
      stream: true,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: PROMPT_PREFIX },
          {
            type: "input_image",
            image_url: `data:${fixture.mediaType};base64,${fixture.base64}`,
            detail: "high",
          },
          { type: "input_text", text: PROMPT_SUFFIX },
        ],
      }],
    }
    let bytes = 0
    let raw = ""
    let failure
    try {
      for await (const chunk of transport.streamResponses(request, { signal: AbortSignal.timeout(120_000) })) {
        bytes += chunk.byteLength
        if (raw.length < MAX_CAPTURED_BYTES) raw += Buffer.from(chunk).toString("utf8")
      }
    } catch (error) {
      failure = `${error?.name}/${error?.code ?? error?.status ?? "no-code"}`
    }
    const events = raw.split("\n").filter((line) => line.startsWith("event:")).length
    const deltas = [...raw.matchAll(/"delta":"((?:[^"\\]|\\.)*)"/gu)].map((match) => match[1]).join(" ")
    const colors = countColorWords(deltas)
    console.log([
      `CASE ${name}`,
      `media=${fixture.mediaType}`,
      `status=${state.lastStatus ?? "none"}`,
      `contentType=${state.lastContentType ?? "none"}`,
      `bytes=${bytes}`,
      `events=${events}`,
      `completed=${raw.includes("response.completed")}`,
      `colors=${colors.join("|") || "none"}`,
      `failure=${failure ?? "none"}`,
    ].join(" "))
    if (state.lastErrorBody !== undefined) console.log(`  error-body=${sanitize(state.lastErrorBody, MAX_ERROR_SNIPPET)}`)
    raw = ""
  }

  console.log(`PROBE SUMMARY posts=${state.posts} blocked=${state.blocked}`)
}

function guardedFetch(networkFetch, state) {
  return async function fetchGuarded(input, init) {
    const url = typeof input === "string" ? input : input?.url
    const method = (init?.method ?? "GET").toUpperCase()
    if (url !== `${PROXY_ORIGIN}/v1/responses` || method !== "POST") {
      state.blocked += 1
      throw new Error("webp probe blocked a non-allowlisted request")
    }
    state.posts += 1
    const response = await networkFetch(input, init)
    state.lastStatus = response.status
    state.lastContentType = response.headers.get("content-type")
    if (response.status !== 200) {
      let body = ""
      try {
        body = await response.clone().text()
      } catch {
        body = ""
      }
      state.lastErrorBody = body
    }
    return response
  }
}

await main()
