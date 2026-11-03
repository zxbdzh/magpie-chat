# @magpie-community/page-chat

A chat page in [magpie](https://usemagpie.ai)'s window. Talk to magpie's own models with your MCP servers, instructions and skills, with images and LaTeX, without starting an agent.

Made by **Magic_zero** ([Magiczerowxy](https://github.com/Magiczerowxy)), from [Magiczerowxy/magpie-chat](https://github.com/Magiczerowxy/magpie-chat) (0.1.21). This package is that code, with the changes listed under [Changes from the original](#changes-from-the-original).

> 自维护分支：[zxbdzh/magpie-chat](https://github.com/zxbdzh/magpie-chat)。在上游基础上增加 MCP 生图偏好与模型别名、回复内产物预览和移动端适配。下方插件市场安装命令对应上游发布包，自维护改动以本仓库源码为准。

![Chat inside magpie's window](https://raw.githubusercontent.com/Magiczerowxy/magpie-chat/main/screenshots/23-math-and-layout.png)

## Install

From magpie's **Plugins › Discover**, or:

```sh
magpie plugin add @magpie-community/page-chat
```

It then has a tab, **Chat** (对话, 對話, チャット), under Plugins in the sidebar.

## 安装本仓库版本

如果要安装本仓库维护的版本，而不是插件市场里的上游包，请在已安装 Magpie 的终端执行：

```sh
# 如果之前装过上游 Chat，先关掉并移除，避免同一个页面插件重复加载
magpie plugin off "@magpie-community/page-chat@latest"
magpie plugin rm "@magpie-community/page-chat@latest"

# 安装当前已验证的 fork 版本（固定提交，避免后续 main 变化影响安装结果）
magpie plugin add "github:zxbdzh/magpie-chat#61b31d2a776fa2bb20850d9ea99defacd6a4e2af"
```

安装完成后重启 Magpie；插件页面仍显示为 **Chat**。如果你希望跟随 fork 的最新 `main`，可以把最后一行改为：

```sh
magpie plugin add "github:zxbdzh/magpie-chat#main"
```

更新 fork 版本时，先执行 `magpie plugin rm "github:zxbdzh/magpie-chat"`，再重新执行上面的 `magpie plugin add`。当前 fork 不需要发布 npm 包，也不会把本地路径发送给别人。

## What it does

- **magpie's models.** The list comes from the gateway's `/v1/models`. Models with reasoning levels get an effort picker. Each model shows its brand icon (OpenAI, Claude, Gemini, DeepSeek, Qwen, Kimi, GLM, MiniMax and more) in the picker and next to its name in the transcript. The icons come from [@lobehub/icons](https://github.com/lobehub/lobe-icons) (MIT); see `chat/icons/models/NOTICE`.
- **magpie's library.** Tick instructions and skills from `~/.config/magpie/library/` (folded into the system prompt), and MCP servers from `library.json` (their tools run as real `tool_calls`, at most 8 rounds, Streamable HTTP and stdio).
- **Images and files.** Pick, drop or paste them. Images go to the model as `image_url`. Replies can carry base64 data-URI images, which render inline and open full size on click. Remote `![alt](https://…)` images are shown as a link instead of being loaded — fetching them automatically would let a reply make the page request an arbitrary URL.
- **Streaming.** Reasoning unfolds while it arrives, then collapses. While the answer streams, the page follows it down unless you scroll up yourself; scroll back to the bottom and it resumes.
- **Model status.** Every reply ends with a line saying what the model is doing: `Magpie正在觅食ing… · 2s` with a running timer while it generates, green `Magpie找到了食物！ · 2s` when done, red `Magpie没有找到食物` on failure. The elapsed time is kept with the conversation.
- **Math.** `$…$`, `$$…$$`, `\(…\)` and `\[…\]` render with a bundled KaTeX 0.16.11. No CDN.
- **Conversations kept**, pinned, renamed or deleted, under `~/.config/magpie/magpie-chat/`. Clicking "+" starts a draft row in the sidebar; it becomes a real conversation as soon as you send, and disappears if you switch away without writing anything. The pencil button on each row renames it inline.
- **Layout.** Conversation width and composer width are adjustable in the sidebar; a **Sync** switch keeps the two equal — move either one and the other follows.
- **System prompt switch.** The text you write under 系统提示词 can be turned off without deleting it; ticked instructions and skills still apply.
- **Looks like magpie.** Colors and fonts come from the window's theme.

It registers no provider, asks for no sign-in and stores no credentials of its own. Every request goes out through magpie's gateway, so usage, routing and failover are the same as an agent's.

## How it works

A plugin page runs in a sandboxed frame with no network (`connect-src 'none'`). Its only way out is to navigate itself. So this plugin has two parts:

1. `page/index.html` and `page/boot.js`: a launcher magpie hosts. It reads the window's theme and the `port` option through `_magpie/bridge.js`, then sends its frame to `http://127.0.0.1:<port>/`. It makes no request of its own.
2. `index.mjs`: an OpenCode v1 plugin (`export default {id, server}`). When magpie's plugin host calls `server()`, it starts a local service on `127.0.0.1:3477` (the `port` option). `lib/server.mjs` serves the chat UI in `chat/` and `/api/*`, and forwards chat to magpie's gateway.

### What the service reads and sends

- From magpie's config folder (`$XDG_CONFIG_HOME/magpie` or `~/.config/magpie`): `caller-keys.json` (the first gateway key, sent as `Authorization: Bearer` to the gateway, so the chat's usage is counted on that key), `providers.json` and `routing.json` (icons), `settings.json` (fonts, and the gateway `port` when the build writes one there), `library.json` and `library/` (MCP servers, instructions, skills).
- To magpie's gateway: `MAGPIE_CHAT_GATEWAY` if set, else `MAGPIE_ADDR`, else the `port` from magpie's `settings.json` (the portable build writes its real port there, e.g. `18086`), else `http://127.0.0.1:3425`. The key goes there, so set `MAGPIE_CHAT_GATEWAY` only to a gateway you trust.
- To your MCP servers: what the model asks their tools, with the headers you configured for them. A stdio server's command is run as you configured it.

### Who can use the service

Only the chat page it served:

- Every `/api/` route needs `x-magpie-chat-token`, a random token made each time the service starts. The service writes it into the chat page's HTML, which it sends without CORS headers, so another page can't read it. `/api/ping`, `/api/fonts.css` and `/api/icon/*` are open; they give nothing secret.
- `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, so a DNS-rebound page is turned away.
- `Origin` must be `null` (the sandboxed frame) or the service's own.

## Options

```json
{ "port": 3477 }
```

The launcher and the service both read it. Change it if something else holds 3477.

## 移动端

宽度不超过 960px 时，会话列表和设置改为覆盖式抽屉，支持点击遮罩或按 Escape 收起；切换会话、新建对话后自动关闭会话抽屉。触控按钮、输入字号、图片与场景预览适配窄屏，并通过可见视口及安全区处理软键盘、横屏和底部留白。手机端开关抽屉不会覆盖桌面的侧栏偏好。

## 小窗模式

Chat 页面右上角的窗口图标可打开页面内小窗。小窗使用同一份消息流和输入框，不复制会话状态；桌面端可以拖动标题栏，并拖右下角的尺寸柄调整大小，按 `Esc` 或点击关闭按钮收回。`Ctrl+Shift+M`（macOS 为 `⌘+Shift+M`）可快速切换。

这是插件页面内的小窗，不是操作系统级置顶窗口：当前 Magpie 页面桥接只提供主题、服务地址和插件选项，没有暴露原生窗口尺寸或置顶 API。手机端小窗会自动铺满可视区域。

## 生图偏好

在 Chat 的设置栏找到「生图」：

1. 打开「默认使用 MCP 生图」，选择已配置的 MCP 服务器，工具名默认是 `generate_image`。所选服务器会自动用于 Chat，无需在 MCP 列表重复勾选。
2. 点击「加载工具与模型」，从 MCP 的完整模型枚举中选择，或者直接填写服务支持的 `provider/model`。这里只读取工具定义，不生成图片。
3. 「固定模型 / 本地别名」留空时，调用不带 `model` 参数，沿用 magpie／MCP 服务的默认生图模型；填写后由后端固定传入，不接受聊天模型自行改选。
4. 如需隐藏私有模型标识，在「私有模型别名」中每行填写 `别名 = 真实模型`，再把固定模型设为该别名。映射保存在本机 Chat 设置中，工具定义、历史消息及工具结果发送给聊天模型前会替换为别名；本机工具记录仍展示实际参数。生图 MCP／供应商仍会收到真实模型标识，这不是凭据存储或权限绕过机制。

启用后，明确的生图请求首轮会指定该生图工具，后续允许调用 `generation_result` 查询异步任务；普通聊天和询问生图能力、模型的问题不强制生图。意图识别是保守的关键词规则，不保证理解所有表达，其他请求仍由聊天模型决定工具调用。工具不可用时明确报错，不静默切换其他生图服务。

生图工具保留完整参数约束，模型枚举不再只提供前 20 项。真实出图取决于 MCP 服务、账号权限、所选模型及聊天网关是否支持指定工具调用。

## 产物预览

工具生成的图片及场景文件会显示在回复下方的「本次产物」卡片中，不再只能复制本地绝对路径：

- 图片：支持 MCP 直接返回的图片，以及工具结果中的工作区图片路径，点击可放大。
- HTML：显示隔离的静态页面预览，禁用脚本、外部网络、表单及跳转；交互网页暂不执行。
- 文本、Markdown、JSON、CSV、代码：可展开查看原文。PDF：提供按需预览；部分嵌入式浏览器可能不支持 PDF 查看器。
- Word、Excel、PowerPoint、ZIP：显示文件卡片并提供手动保存，不包含 Office 排版渲染。不会自动下载文件。

只读取 Chat 工作区内、工具明确返回且实际存在的文件，拒绝路径越界、符号链接越界及网络文件路径；每次工具结果最多 6 个产物，总预览体积不超过 8 MiB。远程 URL 不自动抓取，现有外链仍由用户主动打开。预览二进制仅交给界面，不进入发给聊天模型的工具历史。重新打开旧会话时，可从仍存在的工作区文件恢复预览。

这不是公网分享功能：不会创建隧道、上传文件或开放 Chat。其他人需要已有的授权访问入口才能查看，预览卡片本身不产生公开链接。

## Starting it without magpie's host

`serve.mjs` (`node serve.mjs`, or `start-server.cmd` / `start-server.vbs` on Windows) starts the same service on its own, and `install-autostart.cmd` puts it in Windows' Startup folder. See [SERVE.md](SERVE.md). None of these runs unless you start it.

## Changes from the original

- The service answered `Origin: null` and requests with no Origin, and didn't check `Host`. Any website's sandboxed iframe sends `Origin: null`, so it could chat on your gateway key, read and change conversations and settings, and drive your MCP tools. A DNS-rebound page could read conversations. The token and the Host check above close it.
- The service started when `index.mjs` was imported, on 3477 whatever the `port` option said, while the launcher went to the option's port. It now starts when the host calls `server()`, on the option's port.
- A remote provider icon answered 302 with no `Location`. It has one.
- `/api/bootstrap` said version `0.1.0` whatever the version. It says the package's.

## Known limits

- The page opens the service on this computer's 127.0.0.1, so `magpie web` used from another machine won't reach it.
- MCP has no legacy GET SSE stream and no reconnect.
- Images go inline as base64, at most 24MB each.
- Built-in provider icons live inside magpie's binary; when one can't be read, the service draws a letter badge.

## Test

```sh
bun test packages/chat
```

The test starts the service on a free port against a fake gateway, in a temporary config folder.

## License

MIT, © 2026 Magiczerowxy. See [LICENSE](LICENSE).

---

中文：Magic_zero（[Magiczerowxy](https://github.com/Magiczerowxy)）做的「对话」页面，来自 [Magiczerowxy/magpie-chat](https://github.com/Magiczerowxy/magpie-chat)。装好后侧栏「插件」里点「对话」，就能用 magpie 自己的模型聊天，带上你的 MCP 服务器、指令和技能，支持图片与 LaTeX。它不注册供应商、不保存凭据，请求都经 magpie 网关发出，用的是 `caller-keys.json` 里第一把网关 key。本地服务只听 127.0.0.1，每个 `/api/` 请求都要带上服务写进对话页里的口令，并检查 `Host`，别的网页用不了它。
