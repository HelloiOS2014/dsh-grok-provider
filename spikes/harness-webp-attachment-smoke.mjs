import { readFile, realpath, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const RUNTIME_ENV = "DSH_HARNESS_ATTACHMENT_RUNTIME"
const ADAPTER_ENV = "DSH_GROK_ADAPTER_PATH"
const SOURCE_WIDTH = 128
const SOURCE_HEIGHT = 64

class HarnessWebpAttachmentSmokeError extends Error {
  constructor(code) {
    super("The Harness WebP attachment smoke failed")
    this.name = "HarnessWebpAttachmentSmokeError"
    this.code = code
  }
}

async function main() {
  const runtime = process.env[RUNTIME_ENV]
  if (typeof runtime !== "string" || !path.isAbsolute(runtime)) fail("runtime-required")

  const repository = path.resolve(import.meta.dirname, "..")
  const runtimeRequire = createRequire(path.join(runtime, "package.json"))
  const repoRequire = createRequire(path.join(repository, "package.json"))
  const versions = await resolveVersions(runtimeRequire, repoRequire)
  const adapterPath = process.env[ADAPTER_ENV] === undefined
    ? path.join(repository, "src/internal/grok-adapter.mjs")
    : path.resolve(process.env[ADAPTER_ENV])

  const [{ Context }, { LlmRuntime }, { LocalAttachmentStore }, { default: sharp }, { createGrokAdapter }] = await Promise.all([
    import(pathToFileURL(repoRequire.resolve("@deepseek-ai/cordis")).href),
    import(pathToFileURL(repoRequire.resolve("@deepseek-ai/dsh-llm")).href),
    import(pathToFileURL(runtimeRequire.resolve("@deepseek-ai/dsh-attachment-local")).href),
    import(pathToFileURL(runtimeRequire.resolve("sharp")).href),
    import(pathToFileURL(adapterPath).href),
  ])

  const ctx = new Context()
  const dshHome = await import("node:fs/promises").then(({ mkdtemp }) => (
    mkdtemp(path.join(os.tmpdir(), "dsh-grok-harness-webp-"))
  ))
  let removeAdapter
  try {
    await ctx.plugin(LocalAttachmentStore, { dshHome })
    const store = ctx.get("attachments")
    if (!(store instanceof LocalAttachmentStore)) fail("attachment-service-not-mounted")

    // The observed failing shape: an alpha image carrying a Display P3 profile,
    // which the store must re-encode and therefore stores as WebP.
    const rgba = Buffer.alloc(SOURCE_WIDTH * SOURCE_HEIGHT * 4)
    for (let index = 0; index < SOURCE_WIDTH * SOURCE_HEIGHT; index += 1) {
      rgba[index * 4] = 0
      rgba[index * 4 + 1] = 0
      rgba[index * 4 + 2] = 255
      rgba[index * 4 + 3] = 250
    }
    const source = await sharp(rgba, {
      raw: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT, channels: 4 },
    }).withIccProfile("p3").png({ compressionLevel: 9 }).toBuffer()
    const ref = await store.saveImage({
      data: source,
      mediaType: "image/png",
      name: "synthetic-alpha-display-p3.png",
    })
    if (ref.mediaType !== "image/webp") fail("store-did-not-normalize-to-webp")

    const projection = await store.readImageRequest(ref, imageReadPolicy(), AbortSignal.timeout(30_000))
    if (
      projection?.attachment?.attachmentId !== ref.attachmentId ||
      projection.mediaType !== "image/webp" ||
      projection.hasAlpha !== true ||
      !(projection.data instanceof Uint8Array)
    ) {
      fail("request-image-projection-mismatch")
    }

    const compiledRequests = []
    const adapter = createGrokAdapter({
      getGeneration: () => ({
        id: 1,
        transport: {
          async listModels() { return modelCatalog() },
          async *streamResponses(request) {
            compiledRequests.push(request)
            yield * completedResponseEvents()
          },
        },
      }),
      getAttachmentStore: () => ctx.get("attachments"),
    })
    await ctx.plugin(LlmRuntime)
    removeAdapter = ctx.llm.registerAdapter(["grok"], adapter)

    for (const model of ["grok-4.6", "grok-4.5"]) {
      for await (const _chunk of ctx.llm.stream(streamOptions(model, ref))) {}
    }

    const expectedImageUrl = `data:image/webp;base64,${Buffer.from(projection.data).toString("base64")}`
    const verifiedModelUsesImage = hasInlineWebpInput(compiledRequests[0], expectedImageUrl)
    const textOnlyModelOmitsImage = hasTextOnlyProjection(compiledRequests[1])
    if (!verifiedModelUsesImage || !textOnlyModelOmitsImage || compiledRequests.length !== 2) {
      fail("runtime-modality-projection-mismatch")
    }

    writeRecord({
      kind: "harness-webp-attachment-smoke",
      status: "passed",
      runtime: versionRecord(versions),
      sourceBytes: source.byteLength,
      storedMediaType: ref.mediaType,
      storedBytes: ref.bytes,
      requestMediaType: projection.mediaType,
      requestBytes: projection.bytes,
      hasAlpha: projection.hasAlpha,
      verifiedModelUsesImage,
      textOnlyModelOmitsImage,
      compiledRequests: compiledRequests.length,
      networkRequests: 0,
    })
  } finally {
    try {
      removeAdapter?.()
    } finally {
      try {
        await ctx.fiber.dispose()
      } finally {
        await rm(dshHome, { force: true, recursive: true })
      }
    }
  }
}

async function resolveVersions(runtimeRequire, repoRequire) {
  const read = async (require, name) => {
    const manifestPath = await realpath(require.resolve(`${name}/package.json`))
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    return [manifest.name, manifest.version]
  }
  const entries = [
    await read(runtimeRequire, "@deepseek-ai/dsh-attachment"),
    await read(runtimeRequire, "@deepseek-ai/dsh-attachment-local"),
    await read(repoRequire, "@deepseek-ai/dsh-llm"),
    await read(repoRequire, "@deepseek-ai/cordis"),
  ]
  return Object.fromEntries(entries)
}

function versionRecord(versions) {
  return versions
}

function imageReadPolicy() {
  return { maxBytes: 4 * 1024 * 1024, maxPixels: 16 * 1024 * 1024 }
}

function streamOptions(model, ref) {
  return {
    provider: "grok",
    model,
    messages: [{
      id: "harness-webp-smoke",
      role: "user",
      source: { kind: "user" },
      content: [{ type: "image", attachment: ref }],
    }],
  }
}

function hasInlineWebpInput(request, expectedImageUrl) {
  const block = request?.input?.[0]?.content?.[0]
  return block?.type === "input_image" &&
    block.detail === "high" &&
    block.image_url === expectedImageUrl
}

function hasTextOnlyProjection(request) {
  const content = request?.input?.[0]?.content
  return typeof content === "string" &&
    content.startsWith("[image omitted because this model accepts text only")
}

function modelCatalog() {
  return JSON.stringify({
    object: "list",
    data: ["grok-4.5", "grok-4.6"].map((id) => ({
      id,
      name: id,
      context_window: 500000,
      api_backend: "responses",
      supports_reasoning_effort: false,
    })),
  })
}

async function* completedResponseEvents() {
  const encoder = new TextEncoder()
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
  for (const event of events) {
    yield encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  }
}

function writeRecord(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`)
}

function fail(code) {
  throw new HarnessWebpAttachmentSmokeError(code)
}

main().catch((error) => {
  writeRecord({
    kind: "harness-webp-attachment-smoke",
    status: "failed",
    errorCode: error instanceof HarnessWebpAttachmentSmokeError ? error.code : "unexpected",
    detail: error instanceof HarnessWebpAttachmentSmokeError ? undefined : error?.message,
  })
  process.exitCode = 1
})
