(() => {
  "use strict";
  if (window.__heLyricsBridgeInstalled) return;
  window.__heLyricsBridgeInstalled = true;
  const channel = "he-music-lyrics/v1";
  const adapter = HEMusicSiteAdapter.createAdapter({
    document,
    performance,
    origin: location.origin,
    loadModule: (url) => import(url),
  });
  const pending = new Set();

  window.addEventListener("message", async (event) => {
    const message = event.data;
    if (event.source !== window || event.origin !== location.origin ||
        message?.channel !== channel || message.kind !== "request" ||
        typeof message.id !== "string" || !/^[\w-]{1,80}$/.test(message.id) ||
        !["get-context", "get-lyrics"].includes(message.method)) return;
    if (pending.has(message.id) || pending.size >= 8) return;
    pending.add(message.id);
    try {
      const result = message.method === "get-context" ?
        await adapter.getContext(message.token) : await adapter.getLyrics(message.token);
      window.postMessage({ channel, kind: "response", id: message.id, ok: true, result }, location.origin);
    } catch (error) {
      window.postMessage({ channel, kind: "response", id: message.id, ok: false,
        error: error instanceof Error ? error.message : "歌词读取失败，请刷新网页后重试" }, location.origin);
    } finally {
      pending.delete(message.id);
    }
  });
})();
