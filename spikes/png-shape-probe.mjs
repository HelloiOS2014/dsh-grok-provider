import { deflateSync } from "node:zlib"
import os from "node:os"
import path from "node:path"

import { attributionHeaders } from "@deepseek-ai/dsh-llm"

import { GROK_PRODUCTION_OIDC_AUTH_CONTRACT, createCredentialSource } from "../src/internal/credential-source.mjs"
import { createGrokTransport } from "../src/internal/grok-transport.mjs"
import { createOfficialCredentialLoader } from "../src/internal/official-credential-loader.mjs"

const CONFIRMATION_ENV = "DSH_GROK_CONFIRM_PNG_SHAPE_PROBE"
const CONFIRMATION_VALUE = "YES"
const PROXY_ORIGIN = "https://cli-chat-proxy.grok.com"
const MODEL_ID = "grok-4.6"
const MAX_CAPTURED_BYTES = 512 * 1024
const MAX_ERROR_SNIPPET = 300
const PROMPT_PREFIX = "Inspect this synthetic test image."
const PROMPT_SUFFIX = "Identify the single solid color filling this image. Reply with exactly one lowercase basic color word and no punctuation."
const COLOR_WORDS = ["blue", "red", "green", "yellow", "black", "white", "purple", "orange", "pink", "gray", "grey"]

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii")
  const chunk = Buffer.alloc(12 + data.byteLength)
  chunk.writeUInt32BE(data.byteLength, 0)
  typeBytes.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.byteLength)
  return chunk
}

function crc32(data) {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function buildPng({ channels, ancillary }) {
  const width = 128
  const height = 64
  const stride = 1 + width * channels
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * stride
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * channels
      pixels[offset] = 0
      pixels[offset + 1] = 0
      pixels[offset + 2] = 255
      if (channels === 4) pixels[offset + 3] = 250
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, channels === 4 ? 6 : 2, 0, 0, 0], 8)
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", header)]
  if (ancillary === "srgb") parts.push(pngChunk("sRGB", Buffer.from([0])))
  if (ancillary === "phys") {
    const phys = Buffer.alloc(9)
    phys.writeUInt32BE(2835, 0)
    phys.writeUInt32BE(2835, 4)
    phys[8] = 1
    parts.push(pngChunk("pHYs", phys))
  }
  parts.push(pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0)))
  return Buffer.concat(parts)
}

function fail(code) {
  console.log(`PROBE FAIL ${code}`)
  process.exit(1)
}

function sanitize(text, limit) {
  const printable = text.replace(/[^\x20-\x7e\u00a0-\uffff]/gu, " ").replace(/\s+/gu, " ").trim()
  return printable.length <= limit ? printable : `${printable.slice(0, limit)}...`
}

async function main() {
  if (process.platform !== "darwin") fail("unsupported-platform")
  if (process.env[CONFIRMATION_ENV] !== CONFIRMATION_VALUE) fail("confirmation-required")

  const fixtures = {
    "rgb+srgb-chunk": buildPng({ channels: 3, ancillary: "srgb" }),
    "rgba+srgb-chunk": buildPng({ channels: 4, ancillary: "srgb" }),
    "rgb+phys-only": buildPng({ channels: 3, ancillary: "phys" }),
  }

  const state = { posts: 0, blocked: 0, lastStatus: undefined, lastContentType: undefined, lastErrorBody: undefined }
  const networkFetch = globalThis.fetch
  const transport = createGrokTransport({
    credentialSource: createCredentialSource({
      contract: GROK_PRODUCTION_OIDC_AUTH_CONTRACT,
      load: createOfficialCredentialLoader({
        authPath: path.join(os.homedir(), ".grok", "auth.json"),
        platform: "darwin",
      }),
      now: () => new Date(),
    }),
    fetch: guardedFetch(networkFetch, state),
    attributionHeaders,
    clientIdentifier: "dsh-grok-provider",
    clientVersion: "1.0.5-png-shape-probe",
  })

  for (const [name, png] of Object.entries(fixtures)) {
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
            image_url: `data:image/png;base64,${png.toString("base64")}`,
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
    const deltas = [...raw.matchAll(/"delta":"((?:[^"\\]|\\.)*)"/gu)].map((match) => match[1]).join(" ").toLowerCase()
    const colors = COLOR_WORDS.filter((word) => new RegExp(`\\b${word}\\b`, "u").test(deltas))
    console.log([
      `CASE ${name}`,
      `pngBytes=${png.byteLength}`,
      `status=${state.lastStatus ?? "none"}`,
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
      throw new Error("png shape probe blocked a non-allowlisted request")
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
