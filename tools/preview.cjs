"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const base = path.resolve(__dirname, "../extension");
const origin = "https://y.hmusic.top";
const files = new Set(fs.readdirSync(base));
const source = (name) => fs.readFileSync(path.join(base, name), "utf8");
const storageMock = `
const preferencesListeners = [];
let previewPreferences;
const chrome = {
  storage: {
    local: {
      get: async () => ({ preferences: previewPreferences }),
      set: async (value) => {
        const oldValue = previewPreferences;
        previewPreferences = value.preferences;
        preferencesListeners.forEach(fn => fn({ preferences: { oldValue, newValue: previewPreferences } }, 'local'));
      },
    },
    onChanged: { addListener: fn => preferencesListeners.push(fn) },
  },
};`;

function injection() {
  return `(() => {
    if (window.__heLyricsPreview) return;
    const preview = window.__heLyricsPreview = { downloads: [] };
    const style = document.createElement('style');
    style.textContent = ${JSON.stringify(source("content.css"))};
    document.head.append(style);
    ${source("site-adapter.js")}
    ${source("page-bridge.js")}
    ${source("lyrics.js")}
    ${storageMock}
    let backgroundListener;
    const importScripts = () => {};
    chrome.runtime = {
      id: 'he-lyrics-local-preview',
      onMessage: { addListener: fn => { backgroundListener = fn; } },
      sendMessage: message => new Promise(resolve => backgroundListener(message, {
        id: 'he-lyrics-local-preview', tab: { id: 1 }, frameId: 0, url: location.href,
      }, resolve)),
    };
    let determineFilename;
    chrome.downloads = {
      onDeterminingFilename: { addListener: listener => { determineFilename = listener; } },
      onChanged: { addListener: () => {}, removeListener: () => {} },
      search: async () => { throw new Error('临时预览无法查询 Chrome 下载记录'); },
      download: async options => {
        let filename = options.filename;
        determineFilename({ byExtensionId: chrome.runtime.id, url: options.url }, suggestion => {
          if (suggestion?.filename) filename = suggestion.filename;
        });
        preview.downloads.push({ filename, text: decodeURIComponent(options.url.slice(options.url.indexOf(',') + 1)) });
        const link = document.createElement('a');
        link.href = options.url;
        link.download = filename;
        document.body.append(link);
        link.click();
        link.remove();
        return preview.downloads.length;
      },
    };
    (() => { ${source("background.js")} })();
    ${source("content.js")}
    const markPreview = () => document.querySelectorAll('.he-lyrics-badge').forEach(node => {
      if (node.textContent !== '临时预览') node.textContent = '临时预览';
    });
    new MutationObserver(markPreview).observe(document.body, { childList: true, subtree: true });
    markPreview();
  })();`;
}

const server = http.createServer((request, response) => {
  if (request.headers.origin && request.headers.origin !== origin) {
    response.writeHead(403).end("不允许的来源");
    return;
  }
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Private-Network", "true");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
  if (request.method !== "GET") { response.writeHead(405).end(); return; }
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  if (pathname === "/inject.js") {
    response.setHeader("Content-Type", "text/javascript; charset=utf-8");
    response.end(injection());
    return;
  }
  if (pathname === "/popup-mock.js") {
    response.setHeader("Content-Type", "text/javascript; charset=utf-8");
    response.end(`(() => { ${storageMock} window.chrome = chrome; })();`);
    return;
  }
  const filename = pathname.slice(1);
  if (!files.has(filename)) { response.writeHead(404).end("未找到资源"); return; }
  const mime = filename.endsWith(".html") ? "text/html" : filename.endsWith(".css") ? "text/css" : "text/javascript";
  response.setHeader("Content-Type", `${mime}; charset=utf-8`);
  let text = source(filename);
  if (filename === "popup.html") text = text.replace("<head>", '<head><script src="popup-mock.js"></script>');
  response.end(text);
});
server.listen(18765, "127.0.0.1", () => console.log("临时预览服务已启动：http://127.0.0.1:18765（仅本机，Ctrl+C 停止）"));
