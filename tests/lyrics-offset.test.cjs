"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildLyricFile } = require("../extension/lyrics.js");

for (const offset of ["0", "500", "-250"]) {
  test(`LRC 保留原始同步偏移 ${offset}，不擅自改变行时间轴`, () => {
    const result = buildLyricFile({ lyric: `[offset:${offset}]\n[00:01]歌词` });
    assert.equal(result.text, `[offset:${offset}]\n[00:01.000]歌词`);
    assert.equal(result.extension, "lrc");
  });
}

test("LRC 偏移去重、拒绝无效值，TXT 不包含偏移头", () => {
  const lyric = "[offset:无效]\n[offset:+20]\n[offset:99]\n[00:01]歌词";
  assert.equal(buildLyricFile({ lyric }).text, "[offset:20]\n[00:01.000]歌词");
  assert.equal(buildLyricFile({ lyric }, { format: "txt" }).text, "歌词");
  assert.equal(buildLyricFile({ lyric: "[offset:999999999999999999999]\n[00:01]歌词" }).text, "[00:01.000]歌词");
});
