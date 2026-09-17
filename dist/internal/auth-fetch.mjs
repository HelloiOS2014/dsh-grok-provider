// Exact routes participate in Connection's authenticated /api carrier, including
// shell-owned transports. Never register an independent, unguarded HTTP handler.
export function createAuthFetchRoutes(handler, requestSchema) {
  return ["status", "dashboard", "diagnostics", "login", "cancel", "logout"].map((endpoint) => ({
    path: `/api/grok-auth/${endpoint}`,
    methods: ["POST"],
    requestBody: "buffered",
    async fetch(request) {
      if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        return new Response("content type must be application/json", { status: 415 })
      }
      let body
      try {
        body = await request.json()
      } catch {
        return new Response("invalid request", { status: 400 })
      }
      const parsed = requestSchema.safeParse(body)
      if (!parsed.success || parsed.data.method !== `grok-auth/${endpoint}`) {
        return new Response("invalid request", { status: 400 })
      }
      const message = parsed.data
      const result = await handler(endpoint, message.payload, request.signal)
      return Response.json({ type: "server-response", rpcId: message.rpcId, result })
    },
  }))
}
