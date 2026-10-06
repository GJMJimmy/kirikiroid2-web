// VLFS 同步读路径测试（无 JSPI 构建：Android WebView 99 / Chromium < 137）
//
// 验证 platforms/web/vlfs.js 中 readSync / _readSourceSync / _syncRange /
// ensureSizeSync 的行为，以及 registerZipBlob({materialize:true}) 的归档物化。
//
// 关键点：**主线程同步 XHR 不允许 responseType='arraybuffer'**，只能用
// charset=x-user-defined + charCodeAt。而 Blink 按 WHATWG encoding 规范把
// 0x80–0xFF 映射到 U+F780–U+F7FF，因此必须 `& 0xFF` 才能还原原始字节。
// 本测试的 FakeSyncXhr 刻意实现该映射（含断言证明映射确实生效），
// 从而在任何缺少掩码的实现上都会失败。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import {webcrypto} from "node:crypto";
import {fileURLToPath} from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const vlfsSource = fs.readFileSync(
    path.resolve(testDir, "../../platforms/web/vlfs.js"), "utf8");

// ---------------------------------------------------------------------------
// 内存 OPFS（与 vlfs_zip_cache.test.mjs 同构，仅保留本测试需要的部分）
// ---------------------------------------------------------------------------
class MemoryFileHandle {
    constructor(name) {
        this.kind = "file";
        this.name = name;
        this.bytes = new Uint8Array(0);
    }
    async getFile() {
        return new Blob([this.bytes]);
    }
    async createWritable() {
        const chunks = [];
        const handle = this;
        const stream = new WritableStream({
            write: async value => {
                if(typeof value === "string") {
                    chunks.push(new TextEncoder().encode(value));
                } else if(value instanceof Blob) {
                    chunks.push(new Uint8Array(await value.arrayBuffer()));
                } else {
                    chunks.push(new Uint8Array(value));
                }
            },
            close: () => {
                const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
                const bytes = new Uint8Array(size);
                let offset = 0;
                for(const chunk of chunks) {
                    bytes.set(chunk, offset);
                    offset += chunk.length;
                }
                handle.bytes = bytes;
            },
        });
        stream.write = stream.write.bind(stream);
        return stream;
    }
}

class MemoryDirectoryHandle {
    constructor(name) {
        this.kind = "directory";
        this.name = name;
        this.children = new Map();
    }
    async getDirectoryHandle(name, options = {}) {
        const current = this.children.get(name);
        if(current) return current;
        if(!options.create) throw new Error(`missing directory ${name}`);
        const created = new MemoryDirectoryHandle(name);
        this.children.set(name, created);
        return created;
    }
    async getFileHandle(name, options = {}) {
        const current = this.children.get(name);
        if(current) return current;
        if(!options.create) throw new Error(`missing file ${name}`);
        const created = new MemoryFileHandle(name);
        this.children.set(name, created);
        return created;
    }
    async removeEntry(name) {
        this.children.delete(name);
    }
    async *entries() {
        yield* this.children.entries();
    }
}

// ---------------------------------------------------------------------------
// 假同步 XHR：把内存里的"服务器文件"当作 HTTP 资源，模拟真实服务端行为
//   * Range 命中 → 206 + Content-Range + ETag
//   * ignoreRange → 200（服务器忽略 Range）
//   * 二进制经 x-user-defined 映射（Blink 语义）转成 responseText
// ---------------------------------------------------------------------------
const BINARY_TO_USER_DEFINED = bytes => {
    let out = "";
    for(let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        out += String.fromCharCode(b < 0x80 ? b : 0xF780 + (b - 0x80));
    }
    return out;
};

class FakeSyncXhr {
    constructor(server, log) {
        this._server = server;
        this._log = log;
        this._requestHeaders = {};
        this._responseHeaders = {};
        this.status = 0;
        this.responseText = "";
        this.responseType = "";
        this.mimeType = null;
    }
    open(method, url, async) {
        assert.equal(async, false, "本测试只覆盖同步 XHR");
        this._method = method;
        this._url = String(url);
    }
    overrideMimeType(mime) {
        this.mimeType = mime;
    }
    setRequestHeader(name, value) {
        this._requestHeaders[String(name)] = value;
    }
    getResponseHeader(name) {
        const wanted = String(name).toLowerCase();
        for(const key of Object.keys(this._responseHeaders)) {
            if(key.toLowerCase() === wanted) return this._responseHeaders[key];
        }
        return null;
    }
    send() {
        const resource = this._server.get(this._url);
        this._log.push({
            url: this._url,
            range: this._requestHeaders.Range || null,
        });
        if(!resource) {
            this.status = 404;
            return;
        }
        const bytes = resource.bytes;
        if(resource.ignoreRange) {
            this.status = 200;
            this._responseHeaders = {ETag: resource.etag || ""};
            this.responseText = this._decode(bytes);
            return;
        }
        const range = this._requestHeaders.Range;
        assert.ok(range, "同步读必须带 Range 头");
        const match = /^bytes=(\d+)-(\d+)$/.exec(range);
        assert.ok(match, `非预期的 Range 形式: ${range}`);
        const start = Number(match[1]);
        const end = Math.min(Number(match[2]), bytes.length - 1);
        if(start >= bytes.length) {
            this.status = 416;
            this._responseHeaders = {"Content-Range": `bytes */${bytes.length}`};
            return;
        }
        if(resource.etagMismatch) {
            this._responseHeaders = {ETag: '"changed"',
                "Content-Range": `bytes ${start}-${end}/${bytes.length}`};
        } else {
            this._responseHeaders = {
                ETag: resource.etag || '"test-etag"',
                "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
            };
        }
        this.status = 206;
        this.responseText = this._decode(bytes.subarray(start, end + 1));
    }

    // 与真实浏览器一致：只有 x-user-defined 才逐字节映射；否则按 UTF-8 解码
    // （后者会让高字节被多字节序列吞掉，从而暴露"忘记 overrideMimeType"）。
    _decode(bytes) {
        const mime = this.mimeType || "";
        if(mime.indexOf("x-user-defined") >= 0) {
            return BINARY_TO_USER_DEFINED(bytes);
        }
        return new TextDecoder("utf-8").decode(bytes);
    }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function crc32(bytes) {
    let crc = 0xffffffff;
    for(const byte of bytes) {
        crc ^= byte;
        for(let bit = 0; bit < 8; bit++)
            crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;
    for(const spec of entries) {
        const name = Buffer.from(spec.name, "utf8");
        const plain = Buffer.from(spec.data);
        const method = spec.method;
        const compressed = method === 8 ? zlib.deflateRawSync(plain) : plain;
        const checksum = crc32(plain);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(plain.length, 22);
        local.writeUInt16LE(name.length, 26);
        localParts.push(local, name, compressed);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(plain.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(localOffset, 42);
        centralParts.push(central, name);
        localOffset += local.length + name.length + compressed.length;
    }
    const central = Buffer.concat(centralParts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(localOffset, 16);
    return new Blob([...localParts, central, end]);
}

function pattern(size) {
    const bytes = new Uint8Array(size);
    for(let i = 0; i < size; i++) bytes[i] = i & 0xff;
    return bytes;
}

function bytesEqual(actual, expected) {
    if(actual.length !== expected.length)
        return `长度不同: ${actual.length} != ${expected.length}`;
    for(let i = 0; i < actual.length; i++) {
        if(actual[i] !== expected[i])
            return `第 ${i} 字节不同: ${actual[i]} != ${expected[i]}`;
    }
    return null;
}

function loadVLFS(server, xhrLog, storageRoot) {
    const context = vm.createContext({
        Blob,
        DecompressionStream,
        Headers,
        ReadableStream,
        TextDecoder,
        TextEncoder,
        URL,
        Uint8Array,
        WritableStream,
        console,
        crypto: webcrypto,
        performance: {now: () => Date.now()},
        navigator: {storage: {getDirectory: async () => storageRoot}},
        location: {href: "https://game.test/index.html"},
        XMLHttpRequest: function () {
            return new FakeSyncXhr(server, xhrLog);
        },
        window: {},
    });
    vm.runInContext(vlfsSource, context, {filename: "vlfs.js"});
    return context.window.VLFS;
}

function readAllSync(vlfs, filePath, chunk = 1 << 20) {
    const fd = vlfs.open(filePath, 0);
    assert.notEqual(fd, -1, `cannot open ${filePath}`);
    const parts = [];
    let total = 0;
    for(;;) {
        const data = vlfs.readSync(fd, chunk);
        if(data.length === 0) break;
        parts.push(data);
        total += data.length;
        assert.ok(total <= (64 << 20), "读取长度异常，疑似死循环");
    }
    vlfs.close(fd);
    const out = new Uint8Array(total);
    let offset = 0;
    for(const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

// ===========================================================================
// 用例
// ===========================================================================
const PATTERN = pattern(1 << 20);           // 1 MiB, byte[i] = i & 0xFF
const ARCHIVE_URL = "https://game.test/data.xp3";
const server = new Map([
    [ARCHIVE_URL, {bytes: PATTERN, etag: '"pattern-v1"'}],
    ["https://game.test/no-range.bin",
        {bytes: PATTERN, ignoreRange: true}],
    ["https://game.test/etag.bin",
        {bytes: PATTERN, etag: '"v1"', etagMismatch: true}],
]);
const xhrLog = [];
const storageRoot = new MemoryDirectoryHandle("root");
const vlfs = loadVLFS(server, xhrLog, storageRoot);
await vlfs.init();

// --- 1. 远端登记 + 同步读 256 KiB -----------------------------------------
vlfs.registerRemote("/data.xp3", ARCHIVE_URL, PATTERN.length, true, null);
assert.equal(vlfs.ensureSizeSync(vlfs.open("/data.xp3", 0)), PATTERN.length,
    "ensureSizeSync 应返回已知尺寸");

{
    const fd = vlfs.open("/data.xp3", 0);
    assert.notEqual(fd, -1);
    const got = vlfs.readSync(fd, 256 * 1024);
    assert.equal(got.length, 256 * 1024, "同步读长度不对");
    const diff = bytesEqual(got, PATTERN.subarray(0, 256 * 1024));
    assert.equal(diff, null, `同步读 256 KiB 内容不符: ${diff}`);
    vlfs.close(fd);

    // 掩码有效性证据：假 XHR 确实按 Blink 的 x-user-defined 映射产生高码点，
    // 若实现缺少 `& 0xFF`，上面的逐字节比较必然失败。
    const last = xhrLog[xhrLog.length - 1];
    assert.equal(last.range, "bytes=0-262143", "Range 头不正确");
    assert.equal(last.url, ARCHIVE_URL);
}

// --- 2. 块缓存：重复小读不再发 XHR ----------------------------------------
{
    const before = xhrLog.length;
    const fd = vlfs.open("/data.xp3", 0);
    for(let i = 0; i < 8; i++) {
        const got = vlfs.readSync(fd, 64);
        const diff = bytesEqual(got, PATTERN.subarray(i * 64, i * 64 + 64));
        assert.equal(diff, null, `第 ${i} 次 64B 读内容不符: ${diff}`);
    }
    vlfs.close(fd);
    assert.equal(xhrLog.length, before,
        "同一块内的后续小读不应再发同步 XHR（块缓存未生效）");
}

// --- 3. 大读（≥ DIRECT_READ_THRESHOLD）直读源 -----------------------------
{
    const fd = vlfs.open("/data.xp3", 0);
    const got = vlfs.readSync(fd, 600 * 1024);
    assert.equal(got.length, 600 * 1024);
    const diff = bytesEqual(got, PATTERN.subarray(0, 600 * 1024));
    assert.equal(diff, null, `大读内容不符: ${diff}`);
    vlfs.close(fd);
}

// --- 4. 磁盘上的"物化"ZIP：store 条目可同步读 ------------------------------
{
    const archive = makeZip([
        {name: "game/ui/frame.csb", data: PATTERN.subarray(0, 4096), method: 0},
    ]);
    const registered = await vlfs.registerZipBlob(archive, {
        stripPrefix: "game/",
        eagerDeflate: false,
        materialize: true,
    });
    assert.deepEqual(Array.from(registered.paths), ["/ui/frame.csb"]);
    const got = readAllSync(vlfs, "/ui/frame.csb", 1024);
    const diff = bytesEqual(got, PATTERN.subarray(0, 4096));
    assert.equal(diff, null, `物化 ZIP 的 store 条目内容不符: ${diff}`);
}

// --- 5. 未物化的本地 ZIP：必须给出可读错误 ---------------------------------
{
    const archive = makeZip([
        {name: "game/loose.bin", data: "abc", method: 0},
    ]);
    const registered = await vlfs.registerZipBlob(archive, {
        stripPrefix: "game/",
        eagerDeflate: false,
    });
    assert.deepEqual(Array.from(registered.paths), ["/loose.bin"]);
    const fd = vlfs.open("/loose.bin", 0);
    assert.throws(() => vlfs.readSync(fd, 3), /not materialized/,
        "未物化的本地 ZIP 应抛出明确错误");
    vlfs.close(fd);
}

// --- 6. deflate 条目：必须给出可读错误（Chrome 103+ 才有的能力）-----------
{
    const archive = makeZip([
        {name: "game/deflated.bin", data: "deflate-me-".repeat(64), method: 8},
    ]);
    const registered = await vlfs.registerZipBlob(archive, {
        stripPrefix: "game/",
        eagerDeflate: false,
        materialize: true,
    });
    assert.deepEqual(Array.from(registered.paths), ["/deflated.bin"]);
    const fd = vlfs.open("/deflated.bin", 0);
    assert.throws(() => vlfs.readSync(fd, 16), /deflate/,
        "deflate 条目应抛出说明性错误");
    vlfs.close(fd);
}

// --- 7. 服务器忽略 Range（200）→ 必须报错而不是返回错数据 -----------------
{
    vlfs.registerRemote("/no-range.bin", "https://game.test/no-range.bin",
        PATTERN.length, true, null);
    const fd = vlfs.open("/no-range.bin", 0);
    assert.throws(() => vlfs.readSync(fd, 1024), /ignored Range/,
        "服务器返回 200 时应报错");
    vlfs.close(fd);
}

// --- 8. ETag 变化（同步路径）→ 必须报错 -----------------------------------
{
    vlfs.registerRemote("/etag.bin", "https://game.test/etag.bin",
        PATTERN.length, true, null);
    const entry = vlfs._entries.get("/etag.bin");
    entry.zipSource = null;
    // 直接驱动 _syncRange 的 ETag 校验分支
    assert.throws(
        () => vlfs._syncRange("https://game.test/etag.bin", 0, 16, null, '"v1"'),
        /ZIP changed/,
        "ETag 变化时应报错");
}

// --- 9. 未知尺寸：ensureSizeSync 返回 -1（无 JSPI 无法补全 FSA 元数据）----
{
    vlfs.registerFSAFile("/unknown-size.bin", {});
    assert.equal(vlfs.ensureSizeSync(vlfs.open("/unknown-size.bin", 0)), -1,
        "未知尺寸应返回 -1");
}

// --- 10. Blob/FSA 条目在同步路径下必须给出可读错误 ------------------------
{
    vlfs.registerBlobFile("/local.bin", new Blob([PATTERN.subarray(0, 128)]));
    const fd = vlfs.open("/local.bin", 0);
    assert.throws(() => vlfs.readSync(fd, 16), /no synchronous read path/,
        "Blob 条目应抛出说明性错误");
    vlfs.close(fd);
}

console.log("VLFS synchronous read path verified (no-JSPI build)");
