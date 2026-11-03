import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml" };
const FILE_TYPES = { ...IMAGE_TYPES, ".pdf": "application/pdf", ".html": "text/html", ".htm": "text/html", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".csv": "text/csv", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".xml": "application/xml", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".zip": "application/zip" };
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

function isWithin(root, target) {
  const path = relative(root, target);
  return Boolean(path && path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
}

function collectPaths(value, paths, depth = 0) {
  if (depth > 8 || paths.size >= 24) return;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || text.length > 100000) return;
    if (text.startsWith("{") || text.startsWith("[")) {
      try { collectPaths(JSON.parse(text), paths, depth + 1); return; } catch { /* 非 JSON 的工具文本继续按行解析。 */ }
    }
    for (const line of text.split(/\r?\n/)) {
      if (paths.size >= 24) break;
      const candidate = line.trim().replace(/^[-*]\s+/, "").replace(/^["'`]+/, "").replace(/[\s"'`,;.)}]+$/, "");
      if (/^(?:https?:|data:|file:|\\\\|\/\/)/i.test(candidate)) continue;
      if (FILE_TYPES[extname(candidate).toLowerCase()]) paths.add(candidate);
    }
  } else if (Array.isArray(value)) {
    for (const item of value.slice(0, 24)) collectPaths(item, paths, depth + 1);
  } else if (value && typeof value === "object") {
    for (const key of ["path", "file", "files", "filePath", "file_path", "output", "outputs", "images", "artifacts"]) {
      if (value[key] !== undefined) collectPaths(value[key], paths, depth + 1);
    }
  }
}

export async function collectArtifacts(result, workspace) {
  const artifacts = [];
  let remaining = MAX_PREVIEW_BYTES;
  for (const item of Array.isArray(result.content) ? result.content : []) {
    if (artifacts.length >= 6) break;
    if (item?.type !== "image" || !/^image\/(?:png|jpe?g|gif|webp|avif|svg\+xml)$/i.test(item.mimeType || "")) continue;
    if (typeof item.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data) || item.data.length > remaining * 4 / 3 + 4) continue;
    const bytes = Buffer.from(item.data, "base64");
    if (!bytes.length || bytes.length > remaining) continue;
    remaining -= bytes.length;
    const extension = Object.entries(IMAGE_TYPES).find(([, mime]) => mime === item.mimeType)?.[0] || ".png";
    artifacts.push({ name: "image-" + (artifacts.length + 1) + extension, kind: "image", mimeType: item.mimeType, size: bytes.length, data: `data:${item.mimeType};base64,${bytes.toString("base64")}` });
  }
  const root = await realpath(workspace).catch(() => null);
  if (!root) return artifacts;
  const paths = new Set();
  collectPaths(String(result.text || ""), paths);
  collectPaths(result.structuredContent, paths);

  const seen = new Set();
  for (const path of paths) {
    if (artifacts.length >= 6) break;
    const candidate = resolve(root, path);
    if (!isWithin(root, candidate)) continue;
    try {
      // 核对符号链接解析后的真实路径，图片预览不读取工作区外文件。
      const actual = await realpath(candidate);
      if (!isWithin(root, actual) || seen.has(actual)) continue;
      const info = await stat(actual);
      const extension = extname(actual).toLowerCase();
      const mimeType = FILE_TYPES[extension];
      if (!mimeType || !info.isFile() || info.size > remaining) continue;
      const bytes = await readFile(actual);
      if (bytes.length > remaining) continue;
      remaining -= bytes.length;
      seen.add(actual);
      const kind = IMAGE_TYPES[extension] ? "image" : extension === ".pdf" ? "pdf" : /^\.html?$/.test(extension) ? "html" : /^(?:text\/|application\/(?:json|xml))/.test(mimeType) ? "text" : "file";
      artifacts.push({ name: basename(actual), kind, mimeType, size: bytes.length, path: relative(root, actual).split(sep).join("/"),
        ...(["html", "text"].includes(kind) ? { text: bytes.toString("utf8") } : { data: `data:${mimeType};base64,${bytes.toString("base64")}` }),
      });
    } catch { /* MCP 可返回尚未落盘或已移走的文件，不能中断聊天。 */ }
  }
  return artifacts;
}
