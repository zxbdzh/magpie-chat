# magpie chat plugin — 运行时契约（唯一事实来源）

插件目录：`F:\Harnes workspace\magpie-chat`（magpie 以文件夹方式加载）

## 进程与端口

- `index.mjs` 是 magpie 的 OpenCode 供应商插件入口，由 magpie 的 Bun 宿主加载。模块加载时启动内置 HTTP 服务（默认 `127.0.0.1:3477`，插件 options.port 可覆盖），并在进程退出时关闭。
- magpie 窗口里的页面 `page/index.html` 由 magpie 托管，运行在 `sandbox="allow-scripts"` 的 iframe 里，**没有网络权限（connect-src 'none'）、不能内嵌 iframe（frame-src 'none'）、不能用 localStorage**。它唯一能做的联网动作是把**自己**导航到我们的服务器：`http://127.0.0.1:<port>/`。
- 导航后文档仍受 iframe 的 sandbox 限制：**origin 为 opaque（Origin: null）**，所以：
  - 服务端所有响应必须带 `Access-Control-Allow-Origin: *`（不能用 `*` + credentials；浏览器一律 `credentials: 'omit'`）。
  - 前端**禁止使用 localStorage / sessionStorage / indexedDB / cookie**，会抛异常。状态全部走服务端 API。
  - 所有渲染都放在一个页面里，不要用 iframe 再套。

## 上游网关

- `http://127.0.0.1:3425`（options.gateway 或 `MAGPIE_ADDR` 可覆盖），OpenAI 兼容。
- `GET /v1/models` → `{data:[{id, display_name, reasoning, reasoning_levels, context_length, max_output_tokens, modalities}]}`
- `POST /v1/chat/completions` 支持 `stream:true`(SSE) / `reasoning_effort` / `tools` / `tool_calls` / 回复里的 `reasoning_content`。
- 可选 `Authorization: Bearer <callerKey>`；不传也能用。浏览器端永不直连网关。

## 后端 HTTP API（全部 JSON；/api/chat 是 SSE）

统一响应头：`Access-Control-Allow-Origin: *`、`Access-Control-Allow-Headers: Content-Type`、`Access-Control-Allow-Methods: GET,POST,DELETE,OPTIONS`。OPTIONS 一律 204。

### GET /api/bootstrap

```json
{
  "port": 3477,
  "version": "0.1.0",
  "gateway": "http://127.0.0.1:3425",
  "settings": { "model": "group/deepseek-v4-1-flash", "effort": "high", "system": "", "instructions": [], "skills": [], "mcp": [], "temperature": 0.7, "maxTokens": 0 },
  "models": [{ "id": "group/deepseek-v4-1-flash", "name": "DeepSeek-V4.1-Flash", "provider": "group", "reasoning": true, "efforts": ["none","low","high","max"], "context": 1000000, "output": 128000, "images": true }],
  "library": {
    "instructions": [{ "id": "dsh", "name": "dsh", "size": 6767 }],
    "skills": [{ "name": "coding-master", "description": "…" }],
    "mcp": [{ "name": "github", "transport": "http", "detail": "https://api.githubcopilot.com/mcp/" }]
  }
}
```

### GET/POST /api/settings

字段同 `bootstrap.settings`：`model`（string）、`effort`（string，空串表示不发）、`system`（string）、`instructions`（string[]，library 里的 id）、`skills`（string[]，技能名）、`mcp`（string[]，服务器名）、`temperature`（number）、`maxTokens`（number，0=不限）。POST body 只需带要改的字段，返回完整 settings。

`imageGeneration` 为可选的生图偏好对象：`{ enabled: false, server: "", tool: "generate_image", model: "", models: [] }`。`models` 存放 `{ alias, model }` 本地映射；别名必须唯一，且不能包含任一真实模型标识，非法映射 POST 返回 400，不覆盖原设置。启用后 `server` 自动加入本轮 MCP 列表；`mcp` 为空且未启用生图才表示不用工具。固定 `model` 可以填写真实模型或别名，空串表示删掉调用中的 `model` 参数，交给 MCP 默认配置。真实标识在发送给聊天模型的工具定义、消息和工具结果中替换为别名，本机 SSE 工具记录保留实际调用参数。

### GET /api/library

`{ instructions:[{id,name,size}], skills:[{name,description}], mcp:[{name,transport,detail}] }`（与 bootstrap 同结构）

### GET /api/mcp/tools

`{ servers: [{ name, ok, error, tools: [{ name, description, server, inputSchema }] }] }`，列出 settings.mcp 及已启用的 imageGeneration.server；失败不影响其它服务。完整 `inputSchema` 用于本地生图设置加载工具与模型列表，不能调用生图。

### POST /api/mcp/call（调试用，可选）

`{ server, name, args }` → `{ text, isError }`

### POST /api/conversations  /  GET /api/conversations  /  GET|DELETE /api/conversations/:id

```json
{ "id": "c_...", "title": "…", "updated": 1792763180000, "messages": [ { "role": "user|assistant", "content": "…", "reasoning": "…", "toolCalls": [] } ] }
```
POST 是 upsert（带 id 就覆盖），返回保存后的对象。GET 列表返回 `{ items: [{id,title,updated,preview}] }`；为兼容，列表项不返回 messages。

### POST /api/chat  （SSE）

工具完成的 `tool` 事件可附带 `artifacts`：`[{ name, kind, mimeType, size, path?, data?, text? }]`，`kind` 为 `image | html | text | pdf | file`。`path` 是工作区相对路径；二进制预览用 data URL，文本用 `text`。前端在独立产物卡片中渲染，不把预览数据转发为模型工具历史，也不会自动下载。HTML 仅在无脚本、无联网的独立沙箱中展示。每个结果最多 6 项、合计 8 MiB，工作区外或不存在的文件不提供预览。

读取会话时可按工具结果或已存的产物相对路径恢复预览，仅丰富响应、不改写历史文件；本地文件预览数据在前端保存时只保留元数据及相对路径。

请求：

```json
{ "messages": [{ "role": "user", "content": "…" }], "model": "group/…", "effort": "high",
  "system": "…", "temperature": 0.7, "maxTokens": 0, "useTools": true }
```

- 服务端按 settings 组装 system prompt（system + 指令 + 技能 + MCP 工具说明），跑工具循环（最多 8 轮），逐事件下发。
- 事件（`data: <json>\n\n`，事件名放在 JSON 的 `type` 字段里，同时用 `event:` 行做兜底）：

| type | 负载 |
|---|---|
| `start` | `{ model, tools: ["github_x", …] }` |
| `reasoning` | `{ text }` 增量 |
| `delta` | `{ text }` 增量正文 |
| `tool` | `{ phase:"call"\|"result", id, name, args, result }` |
| `usage` | `{ prompt_tokens, completion_tokens, total_tokens }` |
| `error` | `{ message }` |
| `done` | `{ ms }` |

- 客户端断开 → 服务端中止上游请求。
- 额外：`POST /api/chat/stop` `{ "id": "<客户端生成的请求 id>" }` 立刻中止。

## 文件分工（互不重叠，勿改他人文件）

| 文件 | 负责人 | 说明 |
|---|---|---|
| `lib/server.mjs`、`lib/library.mjs`、`lib/gateway.mjs` | Lead | HTTP 路由、SSE、设置与对话持久化、library 读取 |
| `lib/mcp.mjs` | mcp-client | MCP 客户端（http + stdio） |
| `chat/index.html`、`chat/app.js`、`chat/style.css` | chat-ui | 对话界面 |
| `index.mjs`、`package.json`、`page/*` | Lead | 插件入口、清单、桥接页 |

## lib/mcp.mjs 必需导出

```js
export function loadServers()                                   // -> [{name, transport:"http"|"stdio", url?, headers?, command?, args?}]
export async function listTools(server)                         // -> [{name, description, inputSchema, server}]
export async function callTool(server, name, args)              // -> { text: string, isError: boolean }
export async function closeAll()                                // 杀掉 stdio 子进程
```

- 只用 Node/Bun 内置模块 + 全局 `fetch`。
- HTTP（Streamable MCP）：`POST` JSON-RPC，`Accept: application/json, text/event-stream`，处理 JSON 与 SSE 两种响应，保存 `Mcp-Session-Id` 并在后续请求回传；先 `initialize`（protocolVersion `2024-11-05`）再 `notifications/initialized`，然后 `tools/list` / `tools/call`。
- stdio：`child_process.spawn`，换行分隔的 JSON-RPC，同样先 initialize；stderr 不阻塞（inherit 到日志或 ignore），进程缓存复用，退出时清理。
- 任何失败都要 throw 带可读信息的 Error，由调用方包成 `{ok:false,error}`。
