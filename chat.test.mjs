// The chat page's local service holds the user's magpie gateway key, their
// conversations and their MCP tools, so it answers only the chat page it
// served: a request needs the per-process token from that page's HTML and
// this service's own Host. Everything here runs against a fake gateway on a
// free port, with a temporary config folder; nothing reaches the network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = import.meta.dir
const tmp = mkdtempSync(join(tmpdir(), "page-chat-"))
const cfg = join(tmp, "magpie")
mkdirSync(cfg, { recursive: true })
writeFileSync(join(cfg, "caller-keys.json"), JSON.stringify([{ name: "chat", secret: "mk-test-key" }]))
process.env.XDG_CONFIG_HOME = tmp
delete process.env.MAGPIE_API_KEY
delete process.env.MAGPIE_GATEWAY_KEY
delete process.env.MAGPIE_ADDR

const seen = []
let imageReply = false
const gateway = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "fake/model", owned_by: "fake" }] })
    if (url.pathname === "/v1/chat/completions") {
      const payload = await req.json()
      seen.push({ auth: req.headers.get("authorization"), body: payload })
      const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`
      if (imageReply && !payload.messages.some(message => message.role === "tool")) {
        const calls = [{ index: 0, id: "image-call", type: "function", function: { name: "images_generate_image", arguments: JSON.stringify({ prompt: "a kitten", model: "provider/wrong" }) } }]
        if (imageReply === "multiple") calls.push({ index: 1, id: "list-call", type: "function", function: { name: "images_list_models", arguments: "{}" } })
        return new Response(chunk({ choices: [{ delta: { tool_calls: calls }, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
      }
      if (imageReply === "async" && payload.messages.filter(message => message.role === "tool").length === 1) {
        return new Response(chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "poll-call", type: "function", function: { name: "images_generation_result", arguments: JSON.stringify({ id: "fake-task" }) } }] }, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
      }
      const body = chunk({ choices: [{ delta: { content: "hel" } }] })
        + chunk({ choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] })
        + "data: [DONE]\n\n"
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }
    return new Response("no", { status: 404 })
  },
})
process.env.MAGPIE_CHAT_GATEWAY = `http://127.0.0.1:${gateway.port}`

let svc, port, token
beforeAll(async () => {
  const { startServer } = await import("./lib/server.mjs")
  svc = await startServer({ configDir: cfg, options: { port: 0 } })
  port = svc.port
  const page = await raw("GET", "/")
  token = /name="magpie-chat-token" content="([0-9a-f]+)"/.exec(page.body)?.[1]
})
afterAll(async () => {
  await svc?.close()
  gateway.stop(true)
  rmSync(tmp, { recursive: true, force: true })
})

// node:http, so the test sets Host and Origin exactly as a hostile page would
function raw(method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = ""
      res.setEncoding("utf8")
      res.on("data", (c) => (data += c))
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on("error", reject)
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body))
    req.end()
  })
}

const chatBody = { model: "fake/model", messages: [{ role: "user", content: "hi" }] }
const json = { "content-type": "application/json" }

// 仅在 HTTP 边界模拟外部服务，不替换插件内部模块，也不接触真实生图账号。
const imageCalls = []
let extendedImageSchema = false
let artifactResult = null
const imageModels = Array.from({ length: 37 }, (_, index) => `provider/image-${index}`)
const imageMcp = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(req) {
    const message = await req.json()
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 })
    let result = {}
    if (message.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake-images", version: "1" } }
    if (message.method === "tools/list") result = { tools: [
      { name: "generate_image", description: "Generate an image from a text prompt.", inputSchema: { type: "object", properties: {
        ...(extendedImageSchema ? Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`option_${index}`, { type: "string" }])) : {}),
        prompt: { type: "string" }, model: { type: "string", enum: imageModels },
      }, required: ["prompt"] } },
      { name: "generation_result", description: "Wait for an image generation task.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
      { name: "list_models", description: "List models.", inputSchema: { type: "object", properties: {} } },
    ] }
    if (message.method === "tools/call") {
      imageCalls.push(message.params)
      result = { content: [{ type: "text", text: JSON.stringify({ model: message.params.arguments.model || "provider/default", url: "https://images.invalid/test.png" }) }] }
      if (imageReply === "async" && message.params.name === "generate_image") result = { content: [{ type: "text", text: JSON.stringify({ id: "fake-task", status: "pending" }) }] }
      if (artifactResult) result = artifactResult
    }
    return Response.json({ jsonrpc: "2.0", id: message.id, result })
  },
})
writeFileSync(join(cfg, "library.json"), JSON.stringify({ mcp: [{ name: "images", transport: "http", url: `http://127.0.0.1:${imageMcp.port}/mcp` }] }))
afterAll(() => imageMcp.stop(true))

describe("image generation through the chat API", () => {
  test("preview extraction bounds file sizes and the number of displayed artifacts", async () => {
    const headers = { ...json, origin: "null", "x-magpie-chat-token": token }
    const folder = join(cfg, "magpie-chat", "workspace", "artifacts")
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, "too-large.txt"), Buffer.alloc(8 * 1024 * 1024 + 1))
    const names = ["first.txt", "second.txt", "third.txt", "fourth.txt", "fifth.txt", "sixth.txt", "seventh.txt"]
    for (const name of names) writeFileSync(join(folder, name), "Small artifact")
    artifactResult = { content: [{ type: "text", text: ["artifacts/too-large.txt", ...names.map(name => "artifacts/" + name)].join("\n") }] }
    imageReply = true
    try {
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: true, server: "images", tool: "generate_image", model: "", models: [] } })
      const response = await raw("POST", "/api/chat", headers, { model: "fake/model", messages: [{ role: "user", content: "请生图" }] })
      const results = response.body.split("\n\n").filter(Boolean).map(block => JSON.parse(block.split("\n").find(line => line.startsWith("data: ")).slice(6)))
      expect(results.find(event => event.type === "tool" && event.phase === "result").artifacts.map(item => item.name)).toEqual(["first.txt", "second.txt", "third.txt", "fourth.txt", "fifth.txt", "sixth.txt"])
    } finally {
      imageReply = false
      artifactResult = null
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: false } })
    }
  })

  test("preview extraction rejects outside files, network paths and missing outputs", async () => {
    const headers = { ...json, origin: "null", "x-magpie-chat-token": token }
    const outside = join(cfg, "private-preview.txt")
    writeFileSync(outside, "PRIVATE_FILE_NOT_A_GENERATED_ARTIFACT")
    artifactResult = { content: [{ type: "text", text: [outside, "../private-preview.txt", "//server/share/private.txt", "https://example.invalid/private.png", "generated-images/missing.png"].join("\n") }] }
    imageReply = true
    try {
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: true, server: "images", tool: "generate_image", model: "", models: [] } })
      const response = await raw("POST", "/api/chat", headers, { model: "fake/model", messages: [{ role: "user", content: "请生图" }] })
      const results = response.body.split("\n\n").filter(Boolean).map(block => JSON.parse(block.split("\n").find(line => line.startsWith("data: ")).slice(6)))
      expect(results.find(event => event.type === "tool" && event.phase === "result").artifacts).toEqual([])
      expect(response.body).not.toContain("PRIVATE_FILE_NOT_A_GENERATED_ARTIFACT")
    } finally {
      imageReply = false
      artifactResult = null
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: false } })
    }
  })

  test("structured tool results expose preview files in arbitrary workspace subfolders", async () => {
    const headers = { ...json, origin: "null", "x-magpie-chat-token": token }
    const folder = join(cfg, "magpie-chat", "workspace", "output")
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, "My scene.txt"), "Preview in a folder with spaces")
    artifactResult = { content: [{ type: "text", text: "File created" }], structuredContent: { files: [{ path: "output/My scene.txt" }] } }
    imageReply = true
    try {
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: true, server: "images", tool: "generate_image", model: "", models: [] } })
      const response = await raw("POST", "/api/chat", headers, { model: "fake/model", messages: [{ role: "user", content: "请生图" }] })
      const results = response.body.split("\n\n").filter(Boolean).map(block => JSON.parse(block.split("\n").find(line => line.startsWith("data: ")).slice(6)))
      expect(results.find(event => event.type === "tool" && event.phase === "result").artifacts).toEqual([expect.objectContaining({ kind: "text", name: "My scene.txt", path: "output/My scene.txt", text: "Preview in a folder with spaces" })])
    } finally {
      imageReply = false
      artifactResult = null
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: false } })
    }
  })

  test("scene files become typed preview cards without executing HTML or fetching remote URLs", async () => {
    const headers = { ...json, origin: "null", "x-magpie-chat-token": token }
    const folder = join(cfg, "magpie-chat", "workspace", "artifacts")
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, "scene.html"), '<h1>Scene</h1><script>fetch("https://example.invalid/leak")</script>')
    writeFileSync(join(folder, "notes.md"), "# Scene notes")
    writeFileSync(join(folder, "report.pdf"), "%PDF-1.4\nfixture")
    writeFileSync(join(folder, "slides.pptx"), "fake-office-zip")
    artifactResult = { content: [{ type: "text", text: ["artifacts/scene.html", "artifacts/notes.md", "artifacts/report.pdf", "artifacts/slides.pptx", "https://example.invalid/remote.png"].join("\n") }] }
    imageReply = true
    try {
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: true, server: "images", tool: "generate_image", model: "", models: [] } })
      const response = await raw("POST", "/api/chat", headers, { model: "fake/model", messages: [{ role: "user", content: "请生图" }] })
      const results = response.body.split("\n\n").filter(Boolean).map(block => JSON.parse(block.split("\n").find(line => line.startsWith("data: ")).slice(6)))
      expect(results.find(event => event.type === "tool" && event.phase === "result").artifacts).toEqual([
        expect.objectContaining({ name: "scene.html", kind: "html", text: expect.stringContaining("<h1>Scene</h1>") }),
        expect.objectContaining({ name: "notes.md", kind: "text", text: "# Scene notes" }),
        expect.objectContaining({ name: "report.pdf", kind: "pdf", mimeType: "application/pdf" }),
        expect.objectContaining({ name: "slides.pptx", kind: "file" }),
      ])
    } finally {
      imageReply = false
      artifactResult = null
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: false } })
    }
  })

  test("MCP image content is retained for preview without reaching the chat model", async () => {
    const headers = { ...json, origin: "null", "x-magpie-chat-token": token }
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString("base64")
    artifactResult = { content: [{ type: "image", data: png, mimeType: "image/png" }] }
    imageReply = true
    const before = seen.length
    try {
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: true, server: "images", tool: "generate_image", model: "", models: [] } })
      const response = await raw("POST", "/api/chat", headers, { model: "fake/model", messages: [{ role: "user", content: "请生图" }] })
      const results = response.body.split("\n\n").filter(Boolean).map(block => JSON.parse(block.split("\n").find(line => line.startsWith("data: ")).slice(6)))
      expect(results.find(event => event.type === "tool" && event.phase === "result").artifacts).toEqual([expect.objectContaining({ kind: "image", mimeType: "image/png", data: `data:image/png;base64,${png}` })])
      expect(JSON.stringify(seen.slice(before))).not.toContain(png)
    } finally {
      imageReply = false
      artifactResult = null
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: false } })
    }
  })

  test("generated workspace images appear as preview artifacts, not just local paths", async () => {
    const headers = { ...json, origin: "null", "x-magpie-chat-token": token }
    const folder = join(cfg, "magpie-chat", "workspace", "generated-images")
    mkdirSync(folder, { recursive: true })
    const imagePath = join(folder, "preview-kitten.png")
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString("base64")
    writeFileSync(imagePath, Buffer.from(png, "base64"))
    imageReply = true
    artifactResult = { content: [{ type: "text", text: `Generated image, saved to:\n- ${imagePath}` }] }
    const before = seen.length
    try {
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: true, server: "images", tool: "generate_image", model: "", models: [] } })
      const response = await raw("POST", "/api/chat", headers, { model: "fake/model", messages: [{ role: "user", content: "请生图" }] })
      const events = response.body.split("\n\n").filter(Boolean).map(block => JSON.parse(block.split("\n").find(line => line.startsWith("data: ")).slice(6)))
      const result = events.find(event => event.type === "tool" && event.phase === "result")
      expect(result.artifacts).toEqual([expect.objectContaining({ name: "preview-kitten.png", kind: "image", mimeType: "image/png", data: `data:image/png;base64,${png}` })])
      expect(JSON.stringify(seen.slice(before))).not.toContain(png)
    } finally {
      artifactResult = null
      imageReply = false
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: false } })
    }
  })

  test("private aliases redact advertised models and previously saved tool history", async () => {
    const headers = { ...json, origin: "null", "x-magpie-chat-token": token }
    try {
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: true, server: "images", tool: "generate_image", model: "studio", models: [{ alias: "studio", model: "provider/image-36" }] } })
      await raw("POST", "/api/chat", headers, { model: "fake/model", messages: [
        { role: "user", content: "请生图" },
        { role: "assistant", content: "已使用 provider/image-36", toolCalls: [{ id: "previous-image", name: "images_generate_image", args: { prompt: "a kitten", model: "provider/image-36" }, result: JSON.stringify({ model: "provider/image-36" }) }] },
        { role: "user", content: "刚才使用了什么模型？" },
      ] })
      const payload = seen.at(-1).body
      expect(JSON.stringify(payload)).not.toContain("provider/image-36")
      expect(payload.tools.find(tool => tool.function.name === "images_generate_image").function.parameters.properties.model.enum).toContain("studio")
      expect(payload.messages.find(message => message.role === "tool").content).toBe('{"model":"studio"}')
    } finally {
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: false } })
    }
  })

  test("async generation polls for its result without forcing another image", async () => {
    const headers = { ...json, origin: "null", "x-magpie-chat-token": token }
    const before = seen.length
    imageReply = "async"
    imageCalls.length = 0
    try {
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: true, server: "images", tool: "generate_image", model: "", models: [] } })
      const response = await raw("POST", "/api/chat", headers, { model: "fake/model", messages: [{ role: "user", content: "请生图" }] })
      expect(imageCalls.map(call => call.name)).toEqual(["generate_image", "generation_result"])
      expect(seen[before + 1].body.tools.map(tool => tool.function.name)).toContain("images_generation_result")
      expect(seen[before + 1].body.tool_choice).toBe("auto")
      expect(response.body).toContain("event: done")
    } finally {
      imageReply = false
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: false } })
    }
  })

  test("an unavailable configured image tool reports failure before contacting the chat model", async () => {
    const headers = { ...json, origin: "null", "x-magpie-chat-token": token }
    const before = seen.length
    try {
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: true, server: "images", tool: "missing_tool", model: "", models: [] } })
      const response = await raw("POST", "/api/chat", headers, { model: "fake/model", messages: [{ role: "user", content: "请生图" }] })
      expect(response.body).toContain("指定的生图工具不可用")
      expect(seen.length).toBe(before)
    } finally {
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: false } })
    }
  })

  test("image tool schemas retain model and required fields after the eighth property", async () => {
    const headers = { ...json, origin: "null", "x-magpie-chat-token": token }
    extendedImageSchema = true
    try {
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: true, server: "images", tool: "generate_image", model: "", models: [] } })
      await raw("POST", "/api/chat", headers, { model: "fake/model", messages: [{ role: "user", content: "请生图" }] })
      const schema = seen.at(-1).body.tools.find(tool => tool.function.name === "images_generate_image").function.parameters
      expect(schema.properties.model.enum).toEqual(imageModels)
      expect(schema.properties.prompt.type).toBe("string")
      expect(schema.required).toContain("prompt")
    } finally {
      extendedImageSchema = false
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: false } })
    }
  })

  test("a reply can execute multiple tools and return every result to the chat model", async () => {
    const headers = { ...json, origin: "null", "x-magpie-chat-token": token }
    imageReply = "multiple"
    imageCalls.length = 0
    try {
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: true, server: "images", tool: "generate_image", model: "", models: [] } })
      const response = await raw("POST", "/api/chat", headers, { model: "fake/model", messages: [{ role: "user", content: "请生图" }] })
      expect(response.body).not.toContain("event: error")
      expect(seen.at(-1).body.messages.filter(message => message.role === "tool").map(message => message.tool_call_id)).toEqual(["image-call", "list-call"])
    } finally {
      imageReply = false
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: false } })
    }
  })

  test("image questions and refusals do not force a paid generation", async () => {
    const headers = { ...json, origin: "null", "x-magpie-chat-token": token }
    try {
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: true, server: "images", tool: "generate_image", model: "", models: [] } })
      for (const content of ["生图使用了什么模型？", "不要生图，解释一下画一只猫的提示词", "你能生成图片吗？", "Do not generate an image; explain the options."]) {
        await raw("POST", "/api/chat", headers, { model: "fake/model", messages: [{ role: "user", content }] })
        expect(seen.at(-1).body.tool_choice).toBe("auto")
      }
    } finally {
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: false } })
    }
  })

  test("an empty image model delegates to the MCP default instead of a model guess", async () => {
    const headers = { ...json, origin: "null", "x-magpie-chat-token": token }
    imageReply = true
    imageCalls.length = 0
    try {
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: true, server: "images", tool: "generate_image", model: "", models: [] } })
      await raw("POST", "/api/chat", headers, { model: "fake/model", messages: [{ role: "user", content: "请生图" }] })
      expect(imageCalls[0].arguments).toEqual({ prompt: "a kitten" })
    } finally {
      imageReply = false
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: false } })
    }
  })

  test("private model aliases keep real identifiers out of every chat-model request", async () => {
    const headers = { ...json, origin: "null", "x-magpie-chat-token": token }
    const before = seen.length
    imageReply = true
    imageCalls.length = 0
    try {
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: true, server: "images", tool: "generate_image", model: "studio", models: [{ alias: "studio", model: "private-provider/private-image-model" }] } })
      const response = await raw("POST", "/api/chat", headers, { model: "fake/model", messages: [{ role: "user", content: "请生图" }] })
      expect(imageCalls[0].arguments.model).toBe("private-provider/private-image-model")
      const requests = JSON.stringify(seen.slice(before).map(request => request.body))
      expect(requests).not.toContain("private-provider/private-image-model")
      expect(requests).toContain("studio")
      expect(response.body).toContain('\"model\":\"private-provider/private-image-model\"')
    } finally {
      imageReply = false
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: false } })
    }
  })

  test("drawing uses the selected server and fixed model without a separate MCP selection", async () => {
    const headers = { ...json, origin: "null", "x-magpie-chat-token": token }
    const before = seen.length
    imageReply = true
    imageCalls.length = 0
    try {
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: true, server: "images", tool: "generate_image", model: "provider/image-36", models: [] } })
      const response = await raw("POST", "/api/chat", headers, { model: "fake/model", messages: [{ role: "user", content: "帮我生成一只小猫咪" }] })
      expect(imageCalls[0]).toEqual({ name: "generate_image", arguments: { prompt: "a kitten", model: "provider/image-36" } })
      expect(seen[before].body.tool_choice).toEqual({ type: "function", function: { name: "images_generate_image" } })
      expect(response.body).toContain('\"model\":\"provider/image-36\"')
    } finally {
      imageReply = false
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: false } })
    }
  })

  test("all image model options reach the chat model", async () => {
    const headers = { ...json, origin: "null", "x-magpie-chat-token": token }
    try {
      await raw("POST", "/api/settings", headers, { mcp: ["images"], imageGeneration: { enabled: true, server: "images", tool: "generate_image", model: "", models: [] } })
      await raw("POST", "/api/chat", headers, { model: "fake/model", messages: [{ role: "user", content: "images generate_image" }] })
      const tool = seen.at(-1).body.tools.find(tool => tool.function.name === "images_generate_image")
      expect(tool.function.parameters.properties.model.enum).toEqual(imageModels)
    } finally {
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: false } })
    }
  })

  test("a Chinese drawing request receives the configured image tool", async () => {
    const headers = { ...json, origin: "null", "x-magpie-chat-token": token }
    try {
      await raw("POST", "/api/settings", headers, { mcp: ["images"], imageGeneration: { enabled: true, server: "images", tool: "generate_image", model: "", models: [] } })
      const response = await raw("POST", "/api/chat", headers, { model: "fake/model", messages: [{ role: "user", content: "帮我生成一只小猫咪" }] })
      expect(response.body).toContain('event: done')
      expect(seen.at(-1).body.tools.map(tool => tool.function.name)).toContain("images_generate_image")
    } finally {
      await raw("POST", "/api/settings", headers, { mcp: [], imageGeneration: { enabled: false } })
    }
  })
})

test("the page's HTML carries the token and no CORS header", async () => {
  const res = await raw("GET", "/", { origin: "null" })
  expect(res.status).toBe(200)
  expect(token).toMatch(/^[0-9a-f]{64}$/)
  expect(res.headers["access-control-allow-origin"]).toBeUndefined()
})

test("a page without the token can't chat or read conversations (Origin null, as a sandboxed frame sends)", async () => {
  const before = seen.length
  const chat = await raw("POST", "/api/chat", { ...json, origin: "null" }, chatBody)
  expect(chat.status).toBe(403)
  expect(seen.length).toBe(before) // nothing went to the gateway
  for (const path of ["/api/conversations", "/api/settings", "/api/bootstrap", "/api/library", "/api/mcp/tools"]) {
    expect((await raw("GET", path, { origin: "null" })).status).toBe(403)
    expect((await raw("GET", path)).status).toBe(403) // no Origin at all
  }
  const wrong = await raw("GET", "/api/conversations", { origin: "null", "x-magpie-chat-token": "0".repeat(64) })
  expect(wrong.status).toBe(403)
  expect(JSON.parse(wrong.body).reload).toBe(true)
})

test("another site's Origin is refused even with the token", async () => {
  const res = await raw("GET", "/api/conversations", { origin: "https://evil.example", "x-magpie-chat-token": token })
  expect(res.status).toBe(403)
})

test("a DNS-rebound Host is refused, the page and the API both", async () => {
  for (const path of ["/", "/api/conversations", "/api/ping"]) {
    const res = await raw("GET", path, { host: `evil.example:${port}`, "x-magpie-chat-token": token })
    expect(res.status).toBe(403)
    expect(res.body).not.toContain(token)
  }
  expect((await raw("GET", "/api/ping", { host: `localhost:${port}` })).status).toBe(200)
})

test("a preflight lets the token header through", async () => {
  const res = await raw("OPTIONS", "/api/chat", { origin: "null", "access-control-request-headers": "content-type, x-magpie-chat-token" })
  expect(res.status).toBe(204)
  expect(res.headers["access-control-allow-headers"]).toContain("x-magpie-chat-token")
})

test("with the token, a chat streams from the gateway with the caller key", async () => {
  const before = seen.length
  const res = await raw("POST", "/api/chat", { ...json, origin: "null", "x-magpie-chat-token": token }, chatBody)
  expect(res.status).toBe(200)
  const events = res.body.split("\n\n").filter(Boolean).map((b) => JSON.parse(b.split("\n").find((l) => l.startsWith("data: ")).slice(6)))
  expect(events.filter((e) => e.type === "delta").map((e) => e.text).join("")).toBe("hello")
  expect(events.at(-1).type).toBe("done")
  expect(seen.length).toBe(before + 1)
  const got = seen.at(-1)
  expect(got.auth).toBe("Bearer mk-test-key")
  expect(got.body.model).toBe("fake/model")
  expect(got.body.stream).toBe(true)
  expect(got.body.messages.at(-1)).toEqual({ role: "user", content: "hi" })
})

test("conversations save and list with the token", async () => {
  const h = { ...json, origin: "null", "x-magpie-chat-token": token }
  const saved = JSON.parse((await raw("POST", "/api/conversations", h, { title: "t", messages: [{ role: "user", content: "x" }] })).body)
  expect(saved.id).toBeTruthy()
  const list = JSON.parse((await raw("GET", "/api/conversations", h)).body)
  expect(list.items.some((c) => c.id === saved.id)).toBe(true)
})

test("a remote provider icon redirects with a Location", async () => {
  writeFileSync(join(cfg, "providers.json"), JSON.stringify([{ id: "remote", icon: "https://example.com/i.png" }]))
  const res = await raw("GET", "/api/icon/remote")
  expect(res.status).toBe(302)
  expect(res.headers.location).toBe("https://example.com/i.png")
  const badge = await raw("GET", "/api/icon/nothing-here")
  expect(badge.status).toBe(200)
  expect(badge.headers["content-type"]).toContain("image/svg+xml")
})

test("the launcher page only navigates: no fetch, XHR or socket, scripts from files", () => {
  const boot = readFileSync(join(dir, "page", "boot.js"), "utf8").replace(/^\s*\/\/.*$/gm, "")
  expect(boot).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/)
  expect(boot).toContain("location.replace")
  const html = readFileSync(join(dir, "page", "index.html"), "utf8")
  expect(html).toContain('src="_magpie/bridge.js"')
  expect(html).toContain('src="boot.js"')
  expect(html).not.toMatch(/<script>(?!\s*src)/)
})

test("the launcher page explains the SSH tunnel instead of navigating when magpie web is opened from another machine", () => {
  const boot = readFileSync(join(dir, "page", "boot.js"), "utf8")
  const tail = boot.slice(boot.indexOf("function isLoopback"))
  const { isLoopback } = new Function(tail + "; return { isLoopback }")()
  for (const h of ["127.0.0.1", "localhost", "[::1]", "magpie.localhost", ""]) expect(isLoopback(h)).toBe(true)
  for (const h of ["192.168.1.20", "magpie.example.com", "[2001:db8::1]"]) expect(isLoopback(h)).toBe(false)
  expect(boot).toMatch(/if \(!isLoopback\(location\.hostname\)\)/)
  expect(boot).toContain("ssh -N -L ")
})

test("the chat UI sends the token on every API call", () => {
  const app = readFileSync(join(dir, "chat", "app.js"), "utf8")
  // two calls reach the service: api() with its init, and the chat stream
  const calls = [...app.matchAll(/fetch\(([^,)]+),\s*([^\n]*)/g)].map((m) => m[2])
  expect(calls.length).toBe(2)
  expect(calls[0]).toStartWith("init")
  expect(app).toMatch(/var init = \{[^\n]*headers: authHeaders\(\)/)
  expect(app).toMatch(/fetch\("api\/chat", \{\s*method: "POST",\s*headers: authHeaders\(/)
  expect(app).toContain('meta[name="magpie-chat-token"]')
  expect(app).not.toMatch(/XMLHttpRequest|new WebSocket|EventSource|sendBeacon/)
})

test("the plugin starts nothing on import and serves the option's port", async () => {
  const mod = await import("./index.mjs")
  expect(typeof mod.default.server).toBe("function")
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
  expect(pkg.name).toBe("@magpie-community/page-chat")
  expect(pkg.magpie.page.file).toBe("page/index.html")
  expect(pkg.scripts?.postinstall).toBeUndefined()
  expect(pkg.scripts?.install).toBeUndefined()
  expect(pkg.scripts?.preinstall).toBeUndefined()
})

// aigcfree on Discord: `magpie web` on a server, opened from another
// computer's browser. There 127.0.0.1 is the viewer's own computer, so
// magpie web serves this service under a path of its own address
// (magpie.page.service), and the chat UI has to work from under that path.
test("the chat UI's addresses are relative, so it works under magpie web's path", async () => {
  const app = readFileSync(join(dir, "chat", "app.js"), "utf8").replace(/^\s*\/\/.*$/gm, "")
  expect(app).not.toMatch(/["'`]\/api\//)
  const html = readFileSync(join(dir, "chat", "index.html"), "utf8")
  expect(html).not.toMatch(/(href|src)="\//)
  expect(html).toContain('href="api/fonts.css"')
  // a provider's icon, as the bootstrap hands it to the UI
  writeFileSync(join(cfg, "providers.json"), JSON.stringify([{ id: "remote", icon: "https://example.com/i.png" }]))
  const { providerIcons } = await import("./lib/library.mjs")
  expect((await providerIcons(cfg)).get("remote")).toBe("api/icon/remote")
})

test("the plugin declares its service on the option's port", () => {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
  expect(pkg.magpie.page.service).toEqual({ port: pkg.magpie.options.port, option: "port" })
})

// boot.js run as the page's frame runs it: where it sends the frame
async function boot(magpie, hostname = "127.0.0.1") {
  const src = readFileSync(join(dir, "page", "boot.js"), "utf8")
  let went = ""
  const location = { hostname, replace: (u) => { went = u } }
  const document = { getElementById: () => null }
  await new Function("window", "location", "document", "return " + src.replace(/^\s*\/\/.*$/gm, "").trim().replace(/;\s*$/, ""))({ magpie }, location, document)
  return went
}

test("the launcher goes to magpie web's path when the bridge offers one, else to 127.0.0.1", async () => {
  const ready = Promise.resolve({ dark: true, tokens: { bg: "#000" } })
  const options = { get: async () => ({ port: 3999 }) }
  const svc = "http://server.lan:3430/_magpie/plugin/" + "a".repeat(32) + "/_magpie/service/"
  const remote = await boot({ ready, options, service: svc })
  expect(remote).toStartWith(svc + "?")
  expect(new URL(remote).searchParams.get("theme")).toBe("dark")
  // the desktop window, and a magpie from before magpie.service
  expect(await boot({ ready, options, service: "" })).toStartWith("http://127.0.0.1:3999/?theme=dark")
  expect(await boot({ ready, options })).toStartWith("http://127.0.0.1:3999/?")
  expect(await boot(undefined)).toBe("http://127.0.0.1:3477/?")
  // only an http(s) address is followed
  expect(await boot({ ready, service: "javascript:alert(1)" })).toStartWith("http://127.0.0.1:3477/?")
})

test("opened from another machine, the launcher takes magpie web's path, and explains the tunnel only without one", async () => {
  const ready = Promise.resolve({ dark: false })
  const svc = "http://server.lan:3430/_magpie/plugin/" + "b".repeat(32) + "/_magpie/service/"
  expect(await boot({ ready, service: svc }, "server.lan")).toStartWith(svc + "?")
  // a magpie from before magpie.service: no navigation to a refused 127.0.0.1
  expect(await boot({ ready }, "server.lan")).toBe("")
})


// ---------- added in 0.1.3: renaming / layout sync / empty configDir ----------

test("renaming a conversation via PATCH keeps its messages", async () => {
  const h = { ...json, origin: "null", "x-magpie-chat-token": token }
  const saved = JSON.parse((await raw("POST", "/api/conversations", h, { title: "before", messages: [{ role: "user", content: "hi" }] })).body)
  const renamed = await raw("PATCH", "/api/conversations/" + saved.id, h, { title: "after" })
  expect(renamed.status).toBe(200)
  expect(JSON.parse(renamed.body).title).toBe("after")
  // the rename must not wipe messages: POST overwrites the whole file, PATCH only touches the title
  const got = JSON.parse((await raw("GET", "/api/conversations/" + saved.id, h)).body)
  expect(got.title).toBe("after")
  expect(got.messages.length).toBe(1)
  expect(got.messages[0].content).toBe("hi")
})

test("renaming rejects an empty title, a missing conversation and a missing token", async () => {
  const h = { ...json, origin: "null", "x-magpie-chat-token": token }
  const saved = JSON.parse((await raw("POST", "/api/conversations", h, { title: "x", messages: [] })).body)
  expect((await raw("PATCH", "/api/conversations/" + saved.id, h, { title: "   " })).status).toBe(400)
  expect((await raw("PATCH", "/api/conversations/c_does_not_exist", h, { title: "x" })).status).toBe(404)
  expect((await raw("PATCH", "/api/conversations/" + saved.id, { ...json, origin: "null" }, { title: "x" })).status).toBe(403)
})

test("settings keep syncWidth and clamp composerWidth to 35", async () => {
  const h = { ...json, origin: "null", "x-magpie-chat-token": token }
  const saved = JSON.parse((await raw("POST", "/api/settings", h, { syncWidth: true, composerWidth: 10 })).body)
  expect(saved.syncWidth).toBe(true)
  expect(saved.composerWidth).toBe(35)
  const back = JSON.parse((await raw("GET", "/api/settings", h)).body)
  expect(back.syncWidth).toBe(true)
  expect(back.composerWidth).toBe(35)
})

test("image generation preferences survive saving and reading settings", async () => {
  const headers = { ...json, origin: "null", "x-magpie-chat-token": token }
  const imageGeneration = {
    enabled: true, server: "images", tool: "generate_image", model: "studio",
    models: [{ alias: "studio", model: "private-provider/private-image-model" }],
  }
  try {
    const saved = await raw("POST", "/api/settings", headers, { imageGeneration })
    expect(saved.status).toBe(200)
    const read = await raw("GET", "/api/settings", headers)
    expect(JSON.parse(read.body).imageGeneration).toEqual(imageGeneration)
  } finally {
    await raw("POST", "/api/settings", headers, { imageGeneration: { enabled: false } })
  }
})

test("invalid private aliases are rejected without overwriting saved image preferences", async () => {
  const headers = { ...json, origin: "null", "x-magpie-chat-token": token }
  const imageGeneration = { enabled: true, server: "images", tool: "generate_image", model: "studio", models: [{ alias: "studio", model: "provider/private" }] }
  try {
    await raw("POST", "/api/settings", headers, { imageGeneration })
    const invalid = await raw("POST", "/api/settings", headers, { imageGeneration: { ...imageGeneration, models: [{ alias: "studio", model: "provider/a" }, { alias: "studio", model: "provider/b" }] } })
    expect(invalid.status).toBe(400)
    expect(JSON.parse((await raw("GET", "/api/settings", headers)).body).imageGeneration).toEqual(imageGeneration)
  } finally {
    await raw("POST", "/api/settings", headers, { imageGeneration: { enabled: false } })
  }
})

test("an empty configDir reads the library from the real config folder", async () => {
  mkdirSync(join(cfg, "library", "instructions"), { recursive: true })
  writeFileSync(join(cfg, "library", "instructions", "probe.md"), "be brief")
  const { startServer } = await import("./lib/server.mjs")
  const other = await startServer({ configDir: "", options: { port: 0 } })
  try {
    const got = await new Promise((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port: other.port,
        method: "GET",
        path: "/api/library",
        headers: { host: `127.0.0.1:${other.port}`, origin: "null", "x-magpie-chat-token": token }
      }, (res) => {
        let data = ""
        res.setEncoding("utf8")
        res.on("data", (c) => (data += c))
        res.on("end", () => resolve({ status: res.statusCode, body: data }))
      })
      req.on("error", reject)
      req.end()
    })
    expect(got.status).toBe(200)
    expect(JSON.parse(got.body).instructions.map((i) => i.name)).toContain("probe.md")
  } finally {
    await other?.close()
  }
})

// ---------- added in 0.1.4 ----------

test("composeSystem drops the user prompt when systemEnabled is false", async () => {
  const { composeSystem } = await import("./lib/library.mjs")
  const on = await composeSystem({ system: "PROBE_SYSTEM_TEXT_XYZ", systemEnabled: true })
  const off = await composeSystem({ system: "PROBE_SYSTEM_TEXT_XYZ", systemEnabled: false })
  expect(on).toContain("PROBE_SYSTEM_TEXT_XYZ")
  expect(off).not.toContain("PROBE_SYSTEM_TEXT_XYZ")
})

test("stdio MCP servers get a workspace of their own", async () => {
  const { workspaceDir } = await import("./lib/mcp.mjs")
  const dir = workspaceDir()
  expect(dir).toContain("magpie-chat")
  expect(dir).toContain("workspace")
  expect(existsSync(dir)).toBe(true)
})

test("the gateway candidates include the port from magpie settings.json", async () => {
  const { gatewayCandidates } = await import("./lib/gateway.mjs")
  writeFileSync(join(cfg, "settings.json"), JSON.stringify({ port: 18086 }))
  const list = gatewayCandidates({})
  expect(list.some((u) => u.includes(":18086"))).toBe(true)
})

// ---------- review feedback ----------

test("the chat UI never auto-loads a remote image", () => {
  const app = readFileSync(join(dir, "chat", "app.js"), "utf8")
  const start = app.indexOf("function safeImgSrc")
  const end = app.indexOf("function remoteImgLink")
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  // 把函数抽出来真跑一遍：只扫源码里的字面量，换个写法就能绕过去
  const safeImgSrc = new Function(app.slice(start, end) + "\nreturn safeImgSrc")()
  const png = "data:image/png;base64,iVBORw0KGgo="
  expect(safeImgSrc(png)).toBe(png)
  const svg = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="
  expect(safeImgSrc(svg)).toBe(svg)
  for (const bad of [
    "https://a.png",
    "HTTPS://a.png",
    "http://a.png",
    "//a.png",
    "blob:https://a.png",
    "data:text/html;base64,PHNjcmlwdD4=",
  ]) {
    expect(safeImgSrc(bad)).toBe("")
  }
})

test("finish() renders a reply that arrived in one chunk", () => {
  const app = readFileSync(join(dir, "chat", "app.js"), "utf8")
  // 不能只判 .md-stable：整段一次到达时那个结构根本不存在
  expect(app).toMatch(/else if \(refs\.body && refs\.msg\.content\) renderMarkdown\(refs\.body, refs\.msg\.content\)/)
})
