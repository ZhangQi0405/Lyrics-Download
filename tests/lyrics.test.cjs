"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const modulePath = path.join(__dirname, "..", "extension", "lyrics.js");
const source = readFileSync(modulePath, "utf8");
const api = require(modulePath);
const {
  normalizePreferences,
  normalizeLyricResponse,
  buildLyricFile,
  sanitizeFilenameBase,
} = api;
const defaults = {
  enabled: true,
  format: "lrc",
  includeTranslation: true,
  includeRomanization: false,
  saveAs: false,
};
const emptyResponse = { original: "", translation: "", romanization: "" };

function assertWellFormed(value) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    assert.ok(character.length === 2 || code < 0xd800 || code > 0xdfff);
  }
}

function assertSafeFilename(value) {
  assert.ok(value.length > 0 && value.length <= 180);
  assert.doesNotMatch(value, /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/);
  assert.doesNotMatch(value, /[\s.]$/u);
  assertWellFormed(value);
}

describe("导出与运行环境", () => {
  test("CommonJS 与 globalThis 导出同一个四方法 API", () => {
    assert.equal(globalThis.HELyrics, api);
    assert.deepEqual(Object.keys(api).sort(), [
      "buildLyricFile",
      "normalizeLyricResponse",
      "normalizePreferences",
      "sanitizeFilenameBase",
    ]);
  });

  test("无 require、module、window、document 时可作为内容脚本加载", () => {
    const sandbox = {};
    vm.runInNewContext(source, sandbox, { filename: modulePath });
    const result = sandbox.HELyrics.buildLyricFile({ lyric: "[00:01]你好" });
    assert.equal(result.text, "[00:01.000]你好");
    assert.equal(result.extension, "lrc");
  });

  test("worker 的 importScripts 可加载并重复加载 IIFE", () => {
    const sandbox = {};
    const context = vm.createContext(sandbox);
    sandbox.importScripts = (url) => {
      assert.equal(url, "lyrics.js");
      vm.runInContext(source, context, { filename: modulePath });
    };
    vm.runInContext('importScripts("lyrics.js"); importScripts("lyrics.js");', context);
    assert.equal(sandbox.HELyrics.buildLyricFile({ lyric: "文字" }).extension, "txt");
    assert.equal(Object.keys(sandbox).length, 2);
  });

  test("独立 CommonJS 环境也同时提供全局导出", () => {
    const sandbox = { module: { exports: {} } };
    vm.runInNewContext(source, sandbox, { filename: modulePath });
    assert.equal(sandbox.module.exports, sandbox.HELyrics);
  });
});

describe("偏好规范化", () => {
  const invalidInputs = [undefined, null, false, 0, "txt", [], () => {}];
  invalidInputs.forEach((value, index) => {
    test(`无效输入 ${index + 1} 使用全部默认值`, () => {
      assert.deepEqual(normalizePreferences(value), defaults);
    });
  });

  test("保留明确的布尔值及 txt 格式", () => {
    const input = {
      enabled: false,
      format: "txt",
      includeTranslation: false,
      includeRomanization: true,
      saveAs: true,
    };
    assert.deepEqual(normalizePreferences(input), input);
  });

  test("不把字符串、数字、空值等强制转换成布尔值", () => {
    assert.deepEqual(normalizePreferences({
      enabled: "false",
      format: "TXT",
      includeTranslation: 0,
      includeRomanization: "true",
      saveAs: null,
    }), defaults);
  });

  test("仅接受指定格式，忽略其他字段且不修改输入", () => {
    const input = Object.freeze({ format: "lrc", unknown: 1 });
    const result = normalizePreferences(input);
    assert.deepEqual(result, defaults);
    assert.notEqual(result, input);
    for (const format of [undefined, null, "", "json", "LRC", 1, {}, []]) {
      assert.equal(normalizePreferences({ format }).format, "lrc");
    }
  });
});

describe("接口响应规范化", () => {
  test("读取实际 lyric、trans、roma 字符串，规范化阶段不改写正文", () => {
    assert.deepEqual(normalizeLyricResponse({ lyric: " 原\r\n文 ", trans: "翻译", roma: "roma" }), {
      original: " 原\r\n文 ", translation: "翻译", romanization: "roma",
    });
  });

  test("兼容 data 包裹一层的实际接口", () => {
    assert.deepEqual(normalizeLyricResponse({ data: { lyric: "原文", trans: "翻译", roma: "罗马音" } }), {
      original: "原文", translation: "翻译", romanization: "罗马音",
    });
  });

  for (const wrapped of [false, true]) {
    test(`${wrapped ? "包装" : "直接"}兼容旧 lrc、tlyric、romalrc 对象`, () => {
      const input = {
        lrc: { lyric: "原文" }, tlyric: { lyric: "翻译" }, romalrc: { lyric: "罗马音" },
      };
      assert.deepEqual(normalizeLyricResponse(wrapped ? { data: input } : input), {
        original: "原文", translation: "翻译", romanization: "罗马音",
      });
    });
  }

  test("实际字段优先于旧字段，包含明确的空字符串", () => {
    assert.deepEqual(normalizeLyricResponse({
      lyric: "", trans: "新译文", roma: "新罗马音",
      lrc: { lyric: "旧原文" }, tlyric: { lyric: "旧译文" }, romalrc: { lyric: "旧罗马音" },
      data: { lyric: "包装原文", trans: "包装译文", roma: "包装罗马音" },
    }), { original: "", translation: "新译文", romanization: "新罗马音" });
  });

  test("包装中的实际字段也优先于外层旧字段", () => {
    assert.equal(normalizeLyricResponse({
      lrc: { lyric: "旧原文" }, data: { lyric: "实际原文" },
    }).original, "实际原文");
  });

  test("非字符串字段不会阻止有效字符串回退", () => {
    assert.deepEqual(normalizeLyricResponse({
      lyric: 7, trans: false, roma: {},
      data: { lyric: "原文", tlyric: { lyric: "翻译" } },
      romalrc: { lyric: "罗马音" },
    }), { original: "原文", translation: "翻译", romanization: "罗马音" });
  });

  test("严格拒绝字段中的对象、数组、装箱字符串且不调用 toString", () => {
    const object = { toString() { throw new Error("不应进行隐式转换"); } };
    assert.deepEqual(normalizeLyricResponse({
      lyric: object, trans: ["翻译"], roma: new String("罗马音"),
      lrc: { lyric: 1 }, tlyric: { lyric: null }, romalrc: "不支持的旧字段字符串",
    }), emptyResponse);
  });

  test("只解包一层 data，拒绝非对象响应和数组", () => {
    for (const value of [undefined, null, false, 1, "歌词", [], { data: [] }, { data: { data: { lyric: "过深" } } }]) {
      assert.deepEqual(normalizeLyricResponse(value), emptyResponse);
    }
  });

  test("不修改冻结的响应", () => {
    const input = Object.freeze({ data: Object.freeze({ lrc: Object.freeze({ lyric: "内容" }) }) });
    assert.equal(normalizeLyricResponse(input).original, "内容");
    assert.equal(input.data.lrc.lyric, "内容");
  });
});

describe("时间戳、逐字歌词与合并", () => {
  test("真实接口逐字标记被移除，行级时间戳保留", () => {
    assert.deepEqual(buildLyricFile({ lyric: "[00:14.220]<0,330>慢<330,330>品<660,450>人间" }), {
      text: "[00:14.220]慢品人间", extension: "lrc",
    });
  });

  const times = [
    ["00:02", "00:02.000"],
    ["1:2.3", "01:02.300"],
    ["01:02.34", "01:02.340"],
    ["01:02.345", "01:02.345"],
    ["01:02:34", "01:02.340"],
    ["01:02:345", "01:02.345"],
    ["00:01.23456", "00:01.234"],
    ["123:59.999", "123:59.999"],
    ["000:00.000", "00:00.000"],
  ];
  for (const [input, expected] of times) {
    test(`时间 ${input} 规范化为 ${expected}`, () => {
      assert.deepEqual(buildLyricFile({ lyric: `[${input}]内容` }), {
        text: `[${expected}]内容`, extension: "lrc",
      });
    });
  }

  test("多个时间戳展开并排序，同一行重复时间戳只输出一次", () => {
    assert.equal(buildLyricFile({
      lyric: "[00:03][00:01][00:01.00]回声\n[00:02]中间",
      trans: "[00:01:00][00:03.000]Echo",
    }).text, "[00:01.000]回声\n[00:01.000]Echo\n[00:02.000]中间\n[00:03.000]回声\n[00:03.000]Echo");
  });

  test("默认加入翻译，但不加入罗马音", () => {
    assert.equal(buildLyricFile({
      lyric: "[00:02]原二\n[00:01]原一", trans: "[00:01.00]译一\n[00:02:00]译二", roma: "[00:01]roma",
    }).text, "[00:01.000]原一\n[00:01.000]译一\n[00:02.000]原二\n[00:02.000]译二");
  });

  for (const includeTranslation of [false, true]) {
    for (const includeRomanization of [false, true]) {
      test(`翻译开关 ${includeTranslation}，罗马音开关 ${includeRomanization}`, () => {
        const lines = ["[00:01.000]原文"];
        if (includeTranslation) lines.push("[00:01.000]翻译");
        if (includeRomanization) lines.push("[00:01.000]roma");
        assert.equal(buildLyricFile({
          lyric: "[00:01]原文", trans: "[00:01.0]翻译", roma: "[00:01:00]roma",
        }, { includeTranslation, includeRomanization }).text, lines.join("\n"));
      });
    }
  }

  test("同一时间的多行原文不丢失，原文、翻译、罗马音顺序稳定", () => {
    assert.equal(buildLyricFile({
      lyric: "[00:01]甲\n[00:01]乙", trans: "[00:01]译甲\n[00:01]译乙", roma: "[00:01]roma",
    }, { includeRomanization: true }).text,
    "[00:01.000]甲\n[00:01.000]乙\n[00:01.000]译甲\n[00:01.000]译乙\n[00:01.000]roma");
  });

  test("辅助轨独有时间戳不丢失，也不错误地按行号配对", () => {
    assert.equal(buildLyricFile({
      lyric: "[00:01]原一\n[00:03]原三", trans: "[00:02]译二\n[00:03]译三",
    }).text, "[00:01.000]原一\n[00:02.000]译二\n[00:03.000]原三\n[00:03.000]译三");
  });

  test("无时间的混合文本保留，不编造时间戳", () => {
    assert.equal(buildLyricFile({
      lyric: "[副歌]\n[00:01]歌词\n尾声", trans: "[00:01]翻译", roma: "无时间罗马音",
    }, { includeRomanization: true }).text,
    "[副歌]\n[00:01.000]歌词\n[00:01.000]翻译\n尾声\n无时间罗马音");
  });

  test("保留正常尖括号、方括号及有意义的内部空格", () => {
    assert.equal(buildLyricFile({
      lyric: "[00:01]<0,330>I  love <3 <love> [Chorus] [副歌]",
    }).text, "[00:01.000]I  love <3 <love> [Chorus] [副歌]");
  });

  test("兼容带空白及负起点的数值逐字标记", () => {
    assert.equal(buildLyricFile({ lyric: "[00:01]< -2, 330 >甲<330,0>乙" }).text,
      "[00:01.000]甲乙");
  });

  test("兼容 BOM、CRLF、CR 和 Unicode 换行符", () => {
    assert.equal(buildLyricFile({
      lyric: "\ufeff[00:01]甲\r\n[00:02]乙\r[00:03]丙\u{2028}[00:04]丁\u{2029}[00:05]戊",
    }).text, "[00:01.000]甲\n[00:02.000]乙\n[00:03.000]丙\n[00:04.000]丁\n[00:05.000]戊");
  });

  test("畸形时间及超出安全整数的时间作为原文保留，不伪造合法时间", () => {
    for (const text of ["[00:99]内容", "[9007199254740991:00]内容", "[00:01.]内容"]) {
      assert.deepEqual(buildLyricFile({ lyric: text }), { text, extension: "txt" });
    }
  });
});

describe("元信息与 TXT 输出", () => {
  test("原文头去重且只由参数补缺，保留同步偏移而不混入其他元信息", () => {
    const result = buildLyricFile({
      lyric: "[TI:原题]\n[ti:重复标题]\n[ar:]\n[ar:原歌手]\n[by:制作者]\n[offset:500]\n[length:03:20]\n[00:01][re:软件]歌词",
      trans: "[ti:翻译标题]\n[al:翻译专辑]\n[00:01]翻译",
    }, { title: "参数标题", artist: "参数歌手", album: "参数专辑" });
    assert.deepEqual(result, {
      text: "[ti:原题]\n[ar:原歌手]\n[al:参数专辑]\n[offset:500]\n[00:01.000]歌词\n[00:01.000]翻译",
      extension: "lrc",
    });
  });

  test("可补齐全部三个头，拒绝参数换行和括号注入", () => {
    assert.equal(buildLyricFile({ lyric: "[00:01]歌词" }, {
      title: " 歌]\n[00:01.000]伪造 ", artist: "甲\u0000乙", album: " 专辑 ",
    }).text, "[ti:歌 00:01.000 伪造]\n[ar:甲 乙]\n[al:专辑]\n[00:01.000]歌词");
  });

  test("忽略非字符串元信息参数", () => {
    assert.equal(buildLyricFile({ lyric: "[00:01]歌词" }, {
      title: 1, artist: ["歌手"], album: { toString() { throw new Error("不应转换"); } },
    }).text, "[00:01.000]歌词");
  });

  test("TXT 删除所有时间、元信息和逐字标记，按时间保留相邻辅助文本", () => {
    assert.deepEqual(buildLyricFile({
      lyric: "[ti:歌名]\n[ar:歌手]\n[offset:10]\n[00:02.000]<0,100>乙 <3\n[00:01:00]<0,100>甲",
      trans: "[by:译者]\n[00:01]译甲\n[00:02]译乙",
      roma: "[00:01]roma甲\n[00:02]roma乙",
    }, { format: "txt", includeRomanization: true, title: "不应出现的头" }), {
      text: "甲\n译甲\nroma甲\n乙 <3\n译乙\nroma乙", extension: "txt",
    });
  });

  test("TXT 的多个时间戳保留每次演唱，而不是删除后续重复段", () => {
    assert.deepEqual(buildLyricFile({ lyric: "[00:01][00:03]回声\n[00:02]中间" }, { format: "txt" }), {
      text: "回声\n中间\n回声", extension: "txt",
    });
  });

  test("无时间原文请求 LRC 时自动降级 TXT，且不输出头", () => {
    assert.deepEqual(buildLyricFile({ lyric: "[ti:歌名]\n第一行\n第二行", trans: "译文" }, {
      format: "lrc", title: "参数标题", artist: "歌手",
    }), { text: "第一行\n第二行\n译文", extension: "txt" });
  });

  test("辅助轨有时间也不会为无时间原文伪造 LRC", () => {
    assert.deepEqual(buildLyricFile({
      lyric: "原文", trans: "[00:01][00:02]翻译", roma: "[00:01]roma",
    }, { includeRomanization: true }), { text: "原文\n翻译\nroma", extension: "txt" });
  });

  test("空的时间行不能把纯文本变成 LRC", () => {
    assert.deepEqual(buildLyricFile({ lyric: "[00:01]\n[00:02]<0,300>\n纯文本" }), {
      text: "纯文本", extension: "txt",
    });
  });

  test("空白行被忽略，纯文本中的逐字标记同样移除", () => {
    assert.deepEqual(buildLyricFile({ lyric: "\n <0,330>甲 \r\n\t\r\n 乙 <3 \n" }), {
      text: "甲\n乙 <3", extension: "txt",
    });
  });

  test("enabled 与 saveAs 不影响纯构建函数，无 I/O 副作用", () => {
    assert.deepEqual(buildLyricFile({ lyric: "[00:01]歌词" }, { enabled: false, saveAs: true }), {
      text: "[00:01.000]歌词", extension: "lrc",
    });
  });

  test("构建不修改冻结的响应和配置", () => {
    const response = Object.freeze({ data: Object.freeze({ lyric: "[00:01]原文", trans: "[00:01]翻译" }) });
    const options = Object.freeze({ format: "txt", includeTranslation: false });
    assert.deepEqual(buildLyricFile(response, options), { text: "原文", extension: "txt" });
    assert.equal(response.data.trans, "[00:01]翻译");
    assert.equal(options.format, "txt");
  });
});

describe("无有效原文及纯音乐提示", () => {
  const invalidLyrics = [
    undefined, null, false, 0, {}, [], new String("歌词"), "", " \t\r\n\ufeff ",
    "[ti:歌名]\n[ar:歌手]\n[al:专辑]\n[offset:0]\n[length:01:00]\n[by:作者]",
    "[00:01]\n[00:02.000]", "<0,330><330,450>", "[00:01]<0,330>\n[00:02][ti:标题]",
  ];
  invalidLyrics.forEach((lyric, index) => {
    test(`无效原文 ${index + 1} 抛出指定 Error`, () => {
      assert.throws(() => buildLyricFile({ lyric }, { title: "不能冒充歌词" }), {
        name: "Error", message: "这首歌暂无可下载的歌词",
      });
    });
  });

  test("无响应或只有辅助轨时也不能冒充可下载原文", () => {
    for (const response of [undefined, null, "原文", [], { lyric: "", trans: "翻译", roma: "roma" }]) {
      assert.throws(() => buildLyricFile(response, { includeRomanization: true }), {
        name: "Error", message: "这首歌暂无可下载的歌词",
      });
    }
  });

  for (const text of ["纯音乐，请欣赏", "此歌曲为没有填词的纯音乐，请您欣赏", "Instrumental", "暂无歌词"]) {
    test(`不硬编码删除非空正文：${text}`, () => {
      assert.deepEqual(buildLyricFile({ lyric: text }), { text, extension: "txt" });
      assert.deepEqual(buildLyricFile({ lyric: `[00:00]${text}` }), {
        text: `[00:00.000]${text}`, extension: "lrc",
      });
    });
  }
});

describe("Windows 安全文件名", () => {
  test("保留可读 Unicode 和正常标点", () => {
    const text = "周杰伦 - 夜曲（现场）🎵 한국어";
    assert.equal(sanitizeFilenameBase(text), text);
    assertSafeFilename(sanitizeFilenameBase(text));
  });

  test("替换全部 Windows 禁止字符", () => {
    const result = sanitizeFilenameBase('a/b\\c:d*e?f"g<h>i|j');
    assert.equal(result, "a_b_c_d_e_f_g_h_i_j");
    assertSafeFilename(result);
  });

  test("替换 C0、DEL、C1 控制字符", () => {
    const codes = [...Array.from({ length: 32 }, (_, i) => i), ...Array.from({ length: 33 }, (_, i) => i + 127)];
    for (const code of codes) {
      const result = sanitizeFilenameBase("甲" + String.fromCharCode(code) + "乙");
      assert.equal(result, "甲_乙");
      assertSafeFilename(result);
    }
  });

  test("去除头尾空白与尾随空点，统一内部换行空白", () => {
    assert.equal(sanitizeFilenameBase("  歌曲 . .  "), "歌曲");
    assert.equal(sanitizeFilenameBase("甲\u{2028}乙\u{2029}丙"), "甲 乙 丙");
  });

  test("空值、纯空点及非字符串使用可读后备名，不隐式转换", () => {
    for (const value of [undefined, null, false, 0, {}, [], "", " . . ", "   ", {
      toString() { throw new Error("不应转换"); },
    }]) {
      assert.equal(sanitizeFilenameBase(value), "歌词");
    }
  });

  const reserved = [
    "CON", "PRN", "AUX", "NUL", "conin$", "conout$",
    ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
    ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
    "COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³",
  ];
  for (const name of reserved) {
    test(`设备名 ${name} 及带扩展名的变体不会原样输出`, () => {
      for (const value of [name, name.toLowerCase(), `${name}.lrc`, `${name} .歌词.txt`]) {
        const result = sanitizeFilenameBase(value);
        assert.equal(result, "_" + value);
        assertSafeFilename(result);
      }
    });
  }

  test("普通名称不能被误判为设备名", () => {
    for (const name of ["COM0", "COM10", "LPT0", "LPT10", "CONSOLE", "auxiliary", "PRNews", "控制台"]) {
      assert.equal(sanitizeFilenameBase(name), name);
    }
  });

  test("路径分隔符被替换，不能保留路径跳转", () => {
    assert.equal(sanitizeFilenameBase("../../etc/passwd"), ".._.._etc_passwd");
    assert.equal(sanitizeFilenameBase("C:\\folder\\song.mp3"), "C_folder_song.mp3");
  });

  test("长 ASCII 文件名限制为 180 个 UTF-16 单元", () => {
    assert.equal(sanitizeFilenameBase("a".repeat(1000)), "a".repeat(180));
  });

  test("长 emoji 按完整代理对截断", () => {
    const result = sanitizeFilenameBase("🎵".repeat(200));
    assert.equal(result, "🎵".repeat(90));
    assertSafeFilename(result);
  });

  test("边界只剩一个单元时不保留半个 emoji", () => {
    const result = sanitizeFilenameBase("甲".repeat(179) + "🎵结尾");
    assert.equal(result, "甲".repeat(179));
    assertSafeFilename(result);
  });

  test("修复原始字符串中孤立的高低代理项", () => {
    const value = "甲" + String.fromCharCode(0xd800) + "乙" + String.fromCharCode(0xdc00) + "🎵";
    assert.equal(sanitizeFilenameBase(value), "甲_乙_🎵");
    assertSafeFilename(sanitizeFilenameBase(value));
  });

  test("截断后再次去空点并检查设备名", () => {
    assert.equal(sanitizeFilenameBase("CON" + ".".repeat(177) + "song"), "_CON");
    assert.equal(sanitizeFilenameBase("a".repeat(179) + ".end"), "a".repeat(179));
    const result = sanitizeFilenameBase("CON." + "🎵".repeat(200));
    assertSafeFilename(result);
    assert.ok(result.startsWith("_CON."));
  });

  test("清洗结果具有幂等性", () => {
    for (const value of ["CON.txt", "../甲?乙. ", "🎵".repeat(200), " . ", "甲\u0000乙", "正常歌名"]) {
      const result = sanitizeFilenameBase(value);
      assert.equal(sanitizeFilenameBase(result), result);
    }
  });
});
