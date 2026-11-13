(function (root) {
  "use strict";

  const EMPTY_LYRIC_MESSAGE = "这首歌暂无可下载的歌词";
  const MAX_FILENAME_LENGTH = 180;

  function asRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  }

  function normalizePreferences(value) {
    const input = asRecord(value);
    return {
      enabled: typeof input.enabled === "boolean" ? input.enabled : true,
      format: input.format === "txt" ? "txt" : "lrc",
      includeTranslation:
        typeof input.includeTranslation === "boolean" ? input.includeTranslation : true,
      includeRomanization:
        typeof input.includeRomanization === "boolean" ? input.includeRomanization : false,
      saveAs: typeof input.saveAs === "boolean" ? input.saveAs : false,
    };
  }

  function firstString(values) {
    return values.find((value) => typeof value === "string") ?? "";
  }

  function normalizeLyricResponse(response) {
    const input = asRecord(response);
    const data = asRecord(input.data);
    const read = (name, legacyName) =>
      firstString([
        input[name],
        data[name],
        asRecord(input[legacyName]).lyric,
        asRecord(data[legacyName]).lyric,
      ]);

    // 实际接口字段优先；空字符串也是明确结果，不用旧字段覆盖。
    return {
      original: read("lyric", "lrc"),
      translation: read("trans", "tlyric"),
      romanization: read("roma", "romalrc"),
    };
  }

  function cleanMetadata(value) {
    if (typeof value !== "string") return "";
    return value
      .replace(/[\[\]\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseTimestamp(value) {
    const match = /^(\d+):(\d{1,2})(?:[.:](\d+))?$/.exec(value);
    if (!match || Number(match[2]) > 59) return null;
    const milliseconds = Number((match[3] || "").padEnd(3, "0").slice(0, 3));
    const time = Number(match[1]) * 60000 + Number(match[2]) * 1000 + milliseconds;
    return Number.isSafeInteger(time) ? time : null;
  }

  function parseTrack(value) {
    const rows = [];
    const metadata = {};
    for (const rawLine of value.split(/\r\n?|\n|\u{2028}|\u{2029}/u)) {
      const times = [];
      const text = rawLine
        // 只删除数值型逐字标记，保留歌词中的 <3、<love> 等正常文本。
        .replace(/<\s*-?\d+\s*,\s*\d+\s*>/g, "")
        .replace(/\[([^\]\r\n]*)\]/g, (tag, content) => {
          const time = parseTimestamp(content);
          if (time !== null) {
            times.push(time);
            return "";
          }
          const field = /^([a-z][a-z0-9_-]*)\s*:(.*)$/i.exec(content);
          if (!field) return tag;
          const key = field[1].toLowerCase();
          if (key === "ti" || key === "ar" || key === "al") {
            const cleaned = cleanMetadata(field[2]);
            if (!metadata[key] && cleaned) metadata[key] = cleaned;
          }
          if (key === "offset" && metadata.offset === undefined && /^[+-]?\d+$/.test(field[2].trim()) &&
              Number.isSafeInteger(Number(field[2]))) {
            metadata.offset = String(Number(field[2]));
          }
          // offset 仅作为 LRC 头保留，其他元信息不混入歌词正文。
          return "";
        })
        .trim();
      if (text) {
        rows.push({ text, times: Array.from(new Set(times)).sort((a, b) => a - b) });
      }
    }
    return { rows, metadata };
  }

  function mergeTracks(tracks, useTimeline) {
    if (!useTimeline) {
      // 原文没有时间时按轨保留文本，不根据翻译时间或行号猜测原文时间。
      return tracks.flatMap((track) => track.rows.map((row) => ({ text: row.text, time: null })));
    }

    const entries = [];
    tracks.forEach((track, trackIndex) => {
      const firstTimedRow = track.rows.find((row) => row.times.length > 0);
      const firstTime = firstTimedRow ? firstTimedRow.times[0] : Infinity;
      let previousTime = null;
      track.rows.forEach((row, rowIndex) => {
        if (row.times.length > 0) {
          row.times.forEach((time) => {
            entries.push({
              text: row.text,
              time,
              sortTime: time,
              phase: 1,
              trackIndex,
              rowIndex,
            });
          });
          previousTime = row.times[0];
        } else {
          // 无时间行只借相邻时间排序，输出时仍然不添加时间戳。
          entries.push({
            text: row.text,
            time: null,
            sortTime: previousTime === null ? firstTime : previousTime,
            phase: previousTime === null ? 0 : 2,
            trackIndex,
            rowIndex,
          });
        }
      });
    });
    entries.sort((a, b) => {
      if (a.sortTime !== b.sortTime) return a.sortTime - b.sortTime;
      return a.phase - b.phase || a.trackIndex - b.trackIndex || a.rowIndex - b.rowIndex;
    });
    return entries;
  }

  function formatTimestamp(time) {
    const minutes = String(Math.floor(time / 60000)).padStart(2, "0");
    const seconds = String(Math.floor(time / 1000) % 60).padStart(2, "0");
    const milliseconds = String(time % 1000).padStart(3, "0");
    return `[${minutes}:${seconds}.${milliseconds}]`;
  }

  function buildLyricFile(response, options) {
    const lyrics = normalizeLyricResponse(response);
    const input = asRecord(options);
    const preferences = normalizePreferences(input);
    const original = parseTrack(lyrics.original);
    // 以原文判定歌曲是否有歌词，不能用标题或残留翻译冒充原文。
    if (original.rows.length === 0) throw new Error(EMPTY_LYRIC_MESSAGE);

    const tracks = [original];
    if (preferences.includeTranslation) tracks.push(parseTrack(lyrics.translation));
    if (preferences.includeRomanization) tracks.push(parseTrack(lyrics.romanization));
    const useTimeline = original.rows.some((row) => row.times.length > 0);
    const extension = preferences.format === "lrc" && useTimeline ? "lrc" : "txt";
    const lines = [];
    if (extension === "lrc") {
      const fields = [["ti", "title"], ["ar", "artist"], ["al", "album"]];
      for (const [key, optionName] of fields) {
        // 保留原有的首个有效头；参数只补充缺失项，辅助轨的头不混入原文。
        const value = original.metadata[key] || cleanMetadata(input[optionName]);
        if (value) lines.push(`[${key}:${value}]`);
      }
      if (original.metadata.offset !== undefined) lines.push(`[offset:${original.metadata.offset}]`);
    }
    for (const entry of mergeTracks(tracks, useTimeline)) {
      const prefix = extension === "lrc" && entry.time !== null
        ? formatTimestamp(entry.time)
        : "";
      lines.push(prefix + entry.text);
    }
    return { text: lines.join("\n"), extension };
  }

  function truncateFilename(value) {
    let result = "";
    for (const character of value) {
      const code = character.charCodeAt(0);
      // 按完整码点截断，并替换输入中本来就孤立的代理项。
      const safe = character.length === 1 && code >= 0xd800 && code <= 0xdfff
        ? "_"
        : character;
      if (result.length + safe.length > MAX_FILENAME_LENGTH) break;
      result += safe;
    }
    return result.replace(/[\s.]+$/u, "");
  }

  function sanitizeFilenameBase(value) {
    const input = typeof value === "string" ? value : "";
    let name = truncateFilename(
      input.replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]+/g, "_").replace(/\s+/g, " ").trim(),
    );
    if (!name) return "歌词";

    // Windows 设备名即使带扩展名也保留；上标数字同样属于设备别名。
    const stem = name.split(".")[0].replace(/\s+$/u, "");
    if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)$/i.test(stem)) {
      name = truncateFilename("_" + name);
    }
    return name;
  }

  const api = {
    normalizePreferences,
    normalizeLyricResponse,
    buildLyricFile,
    sanitizeFilenameBase,
  };
  root.HELyrics = api;
  if (typeof module === "object" && module !== null && "exports" in module) {
    module.exports = api;
  }
})(globalThis);
