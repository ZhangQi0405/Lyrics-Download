"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const source = path.join(root, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
const table = Array.from({ length: 256 }, (_, number) => {
  for (let bit = 0; bit < 8; bit++) number = (number >>> 1) ^ (number & 1 ? 0xedb88320 : 0);
  return number >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
function collect(directory, prefix = "") {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const name = prefix + entry.name;
    return entry.isDirectory() ? collect(path.join(directory, entry.name), `${name}/`) : [{ name, data: fs.readFileSync(path.join(directory, entry.name)) }];
  });
}
// Chrome 的 ZIP 拖入安装要求 manifest.json 直接位于压缩包根目录。
const entries = collect(source);
entries.push({ name: "README.md", data: fs.readFileSync(path.join(root, "README.md")) });
const localParts = [], centralParts = [];
let offset = 0;
for (const { name, data } of entries) {
  const filename = Buffer.from(name, "utf8");
  const crc = crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0x0021, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(filename.length, 26);
  localParts.push(header, filename, data);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0x0021, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE(offset, 42);
  centralParts.push(central, filename);
  offset += header.length + filename.length + data.length;
}
const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);
const output = path.join(root, "dist");
fs.mkdirSync(output, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const destination = path.join(output, `HE-Music-Lyrics-v${manifest.version}-${stamp}.zip`);
fs.writeFileSync(destination, Buffer.concat([...localParts, ...centralParts, end]), { flag: "wx" });
console.log(`已生成扩展压缩包：${destination}`);
