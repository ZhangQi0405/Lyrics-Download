(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HEMusicSiteAdapter = api;
})(globalThis, function () {
  "use strict";

  const CONTEXT_TTL = 10 * 60 * 1000;
  const MAX_LYRIC_LENGTH = 2 * 1024 * 1024;
  const functionSource = (value) => Function.prototype.toString.call(value);

  function walkComponents(root, visit) {
    const stack = [root];
    const seen = new Set();
    while (stack.length && seen.size < 50000) {
      const vnode = stack.pop();
      if (!vnode || typeof vnode !== "object" || seen.has(vnode)) continue;
      seen.add(vnode);
      if (vnode.component) {
        if (visit(vnode.component)) return vnode.component;
        stack.push(vnode.component.subTree);
      }
      if (Array.isArray(vnode.children)) stack.push(...vnode.children);
      if (vnode.suspense) stack.push(vnode.suspense.activeBranch);
    }
    return null;
  }

  function findLyricRequest(exports) {
    const functions = Object.values(exports).filter((value) => typeof value === "function");
    const direct = functions.find((fn) => /url\s*:\s*["']\/v1\/song\/lyric["']/.test(functionSource(fn)));
    if (direct) return (id, platform) => direct(id, platform);

    // 只定位携带已知歌曲接口地址的实际客户端调用，不要求它位于箭头函数最外层。
    // 网站可能先 await 请求，再对结果做额外处理；不调用歌曲 URL 函数本身。
    const endpointCall = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(\s*\{[^{}]{0,512}?\burl\s*:\s*["']\/v1\/song\/(?:url|detail|lyric\/search)["']/g;
    let client;
    for (const fn of functions) {
      endpointCall.lastIndex = 0;
      for (const match of functionSource(fn).matchAll(endpointCall)) {
        client = functions.find((candidate) => candidate.name === match[1]);
        if (client) break;
      }
      if (client) break;
    }
    if (!client) throw new Error("无法识别网站的歌词请求函数，请更新插件后重试");
    return (id, platform) => client({
      url: "/v1/song/lyric",
      method: "GET",
      params: { id, platform },
      timeout: 15000,
      skipErrorMessage: true,
    });
  }

  function allowLyricFields(response) {
    if (!response || typeof response !== "object") return {};
    const result = {};
    let length = 0;
    function copy(source, target, allowData) {
      for (const key of ["lyric", "trans", "roma", "lrc", "tlyric", "romalrc"]) {
        const value = source[key];
        const text = typeof value === "string" ? value : value && typeof value.lyric === "string" ? value.lyric : null;
        if (text === null) continue;
        length += text.length;
        if (length > MAX_LYRIC_LENGTH) throw new Error("歌词内容过大，已停止处理");
        target[key] = typeof value === "string" ? text : { lyric: text };
      }
      if (allowData && source.data && typeof source.data === "object") {
        target.data = {};
        copy(source.data, target.data, false);
      }
    }
    copy(response, result, true);
    return result;
  }

  function createAdapter({ document, performance, origin, loadModule, now = Date.now }) {
    const contexts = new Map();
    let modulePromise;

    async function siteModule() {
      if (!modulePromise) {
        modulePromise = (async () => {
          const urls = [
            ...Array.from(document.querySelectorAll('link[rel="modulepreload"]'), (node) => node.href),
            ...performance.getEntriesByType("resource").map((entry) => entry.name),
          ];
          const url = urls.reverse().find((value) => {
            try {
              const parsed = new URL(value, origin);
              return parsed.origin === origin && /^\/assets\/stores-[\w-]+\.js$/.test(parsed.pathname);
            } catch {
              return false;
            }
          });
          if (!url) throw new Error("未找到网站的歌曲模块，请刷新网页后重试");
          return loadModule(new URL(url, origin).href);
        })().catch((error) => {
          modulePromise = undefined;
          throw error;
        });
      }
      return modulePromise;
    }

    function capture(token) {
      if (typeof token !== "string" || !/^[\w-]{1,80}$/.test(token)) throw new Error("下载窗口标识无效");
      for (const [key, value] of contexts) {
        if (now() - value.createdAt > CONTEXT_TTL) contexts.delete(key);
      }
      const element = document.querySelector(`.download-song[data-he-lyrics-dialog="${token}"]`);
      const appElement = document.querySelector("#app");
      if (element && appElement) {
        const component = walkComponents(appElement._vnode, (candidate) =>
          (candidate.type?.__name === "DownloadSong" || candidate.type?.name === "DownloadSong") &&
          (candidate.subTree?.el === element || candidate.vnode?.el === element));
        const song = component?.props?.song;
        if (song && song.id != null && typeof song.platform === "string") {
          const value = { song, createdAt: now(), app: appElement.__vue_app__ };
          contexts.set(token, value);
          while (contexts.size > 20) contexts.delete(contexts.keys().next().value);
          return value;
        }
      }
      const cached = contexts.get(token);
      if (cached) return cached;
      throw new Error("无法识别这首歌，请关闭下载窗口后重新打开");
    }

    function describe(captured, exports) {
      const { song, app } = captured;
      const helper = Object.values(exports).find((value) => value && typeof value.getPlayerInfoObj === "function");
      let info;
      try { info = helper?.getPlayerInfoObj(song); } catch { /* 使用歌曲自身的信息兜底。 */ }
      const title = String(info?.name || song.name || "未知歌曲");
      const artist = String(info?.artist || "未知歌手");
      const album = String(info?.album || "");
      const provides = app?._context?.provides;
      const pinia = provides && Reflect.ownKeys(provides).map((key) => provides[key]).find((value) => value?._s instanceof Map);
      const naming = pinia?._s.get("setting")?.fileNameFormat;
      const safeArtist = artist.replace(/[/:*?"<>|]/g, "&");
      const filenameBase = (naming === "artist-title" ? `${safeArtist} - ${title}` :
        naming === "title-artist" ? `${title} - ${safeArtist}` : title).replace(/[/:*?"<>|]/g, "&");
      return { title, artist, album, filenameBase, songId: String(song.id), platform: song.platform };
    }

    return {
      async getContext(token) {
        const captured = capture(token);
        return describe(captured, await siteModule());
      },
      async getLyrics(token) {
        // 在异步请求前保存歌曲对象，避免原站下载成功、关闭弹窗后丢失目标歌曲。
        const captured = capture(token);
        const exports = await siteModule();
        const context = describe(captured, exports);
        const requestLyrics = findLyricRequest(exports);
        let response;
        try {
          response = await requestLyrics(context.songId, context.platform);
        } catch {
          throw new Error("歌词获取失败，请检查网络、登录状态或稍后重试");
        }
        return { context, lyrics: allowLyricFields(response) };
      },
    };
  }

  return { createAdapter, walkComponents, findLyricRequest, allowLyricFields };
});
