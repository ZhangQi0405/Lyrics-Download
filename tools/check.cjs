"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const extension = path.join(root, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json"), "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ["storage", "downloads"]);
assert.equal(manifest.host_permissions, undefined);
assert.equal(manifest.web_accessible_resources, undefined);
for (const entry of manifest.content_scripts) {
  assert.deepEqual(entry.matches, ["https://y.hmusic.top/*"]);
  for (const filename of [...entry.js, ...(entry.css || [])]) assert.ok(fs.existsSync(path.join(extension, filename)), `缺少 ${filename}`);
}
for (const filename of fs.readdirSync(extension).filter((name) => name.endsWith(".js"))) {
  new vm.Script(fs.readFileSync(path.join(extension, filename), "utf8"), { filename });
}
const popup = fs.readFileSync(path.join(extension, manifest.action.default_popup), "utf8");
assert.doesNotMatch(popup, /<script[^>]*>\s*[^<\s]/i, "MV3 弹窗不可包含内联脚本");
for (const match of popup.matchAll(/(?:src|href)="([^"#]+\.(?:js|css))"/g)) assert.ok(fs.existsSync(path.join(extension, match[1])));
assert.ok(fs.existsSync(path.join(extension, manifest.background.service_worker)));
for (const [size, filename] of Object.entries(manifest.icons || {})) {
  const image = fs.readFileSync(path.join(extension, filename));
  assert.equal(image.subarray(1, 4).toString(), "PNG");
  assert.equal(image.readUInt32BE(16), Number(size));
  assert.equal(image.readUInt32BE(20), Number(size));
}
for (const filename of Object.values(manifest.action.default_icon || {})) assert.ok(fs.existsSync(path.join(extension, filename)));
console.log("扩展清单、最小权限、脚本语法、图标尺寸与资源引用检查通过。");
const files = fs.readdirSync(path.join(root, "tests")).filter((file) => file.endsWith(".test.cjs")).map((file) => path.join(root, "tests", file));
const result = spawnSync(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit" });
process.exitCode = result.status ?? 1;
