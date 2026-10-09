// Finds localizable texts (namespace/key/source) in cooked UE assets by binary pattern, so it works
// for any export, including Blueprint classes that UAssetGUI can't parse without schemas.
import fs from 'fs';
import path from 'path';

const MAX_STR = 1 << 20;

// FString at p -> {s, end} or null. ANSI (len>0) must be 7-bit, UTF-16 (len<0); both NUL-terminated.
export function readFString(b, p) {
    if (p + 4 > b.length) return null;
    const n = b.readInt32LE(p);
    if (n === 0) return { s: '', end: p + 4 };
    if (n > 0) {
        if (n > MAX_STR || p + 4 + n > b.length || b[p + 3 + n] !== 0) return null;
        for (let i = p + 4; i < p + 3 + n; i++) if (b[i] === 0 || b[i] > 0x7f) return null;
        return { s: b.toString('latin1', p + 4, p + 3 + n), end: p + 4 + n };
    }
    const len = -n * 2;
    if (-n > MAX_STR || p + 4 + len > b.length || b.readUInt16LE(p + 2 + len) !== 0) return null;
    for (let i = p + 4; i < p + 2 + len; i += 2) if (b.readUInt16LE(i) === 0) return null;
    return { s: b.toString('utf16le', p + 4, p + 2 + len), end: p + 4 + len };
}

// Kismet script string: EX_StringConst (0x1F, ANSI) or EX_UnicodeStringConst (0x34, UTF-16), NUL-terminated
function readScriptString(b, p) {
    if (b[p] === 0x1f) {
        const e = b.indexOf(0, p + 1);
        return e < 0 || e - p > MAX_STR ? null : { s: b.toString('latin1', p + 1, e), end: e + 1 };
    }
    if (b[p] === 0x34) {
        let e = p + 1;
        while (e + 1 < b.length && b.readUInt16LE(e) !== 0) e += 2;
        return e + 1 >= b.length || e - p > MAX_STR ? null : { s: b.toString('utf16le', p + 1, e), end: e + 2 };
    }
    return null;
}

const isKey = s => s.length > 0 && s.length <= 256 && /^[\x21-\x7e]+$/.test(s);
const isNamespace = s => s.length <= 256 && /^[\x20-\x7e]*$/.test(s);
const isText = s => /\S/.test(s) && !/[\x00-\x08\x0b\x0c\x0e-\x1f�]/.test(s);

// TextProperty with HistoryType Base: int32 Flags, int8 0, FString Namespace, FString Key, FString Source
function scanTextProperties(b, out) {
    for (let p = 4; p < b.length - 12; p++) {
        if (b[p] !== 0 || b[p - 1] !== 0 || b[p - 2] !== 0 || b[p - 3] !== 0) continue; // history byte + flags high bytes
        if (b[p - 4] & 0x2) continue; // ETextFlag::CultureInvariant — never localized
        const ns = readFString(b, p + 1);
        if (!ns || !isNamespace(ns.s)) continue;
        const key = readFString(b, ns.end);
        if (!key || !isKey(key.s)) continue;
        const src = readFString(b, key.end);
        if (!src || !isText(src.s)) continue;
        out.push({ ns: ns.s, key: key.s, source: src.s });
        p = src.end - 1;
    }
}

// Blueprint bytecode literal: EX_TextConst (0x29), LocalizedText (1), source, key, namespace
function scanBytecodeTexts(b, out) {
    for (let p = b.indexOf(0x29); p >= 0 && p < b.length - 4; p = b.indexOf(0x29, p + 1)) {
        if (b[p + 1] !== 1) continue;
        const src = readScriptString(b, p + 2);
        if (!src || !isText(src.s)) continue;
        const key = readScriptString(b, src.end);
        if (!key || !isKey(key.s)) continue;
        const ns = readScriptString(b, key.end);
        if (!ns || !isNamespace(ns.s)) continue;
        out.push({ ns: ns.s, key: key.s, source: src.s });
        p = ns.end - 1;
    }
}

// StringTable export: FString TableNamespace, int32 Count, Count x (FString Key, FString Source)
function scanStringTable(b, out) {
    for (let p = 0; p < Math.min(64, b.length); p++) {
        const ns = readFString(b, p);
        if (!ns || !ns.s || !isNamespace(ns.s) || ns.end + 4 > b.length) continue;
        const count = b.readInt32LE(ns.end);
        if (count <= 0 || count > 100000) continue;
        const rows = [];
        let q = ns.end + 4;
        for (let i = 0; i < count; i++) {
            const key = readFString(b, q);
            const src = key && readFString(b, key.end);
            if (!src) break;
            rows.push({ ns: ns.s, key: key.s, source: src.s });
            q = src.end;
        }
        if (rows.length === count) { out.push(...rows.filter(r => isText(r.source))); return; }
    }
}

export function scanBuffer(b, { stringTable = false } = {}) {
    const out = [];
    if (stringTable) scanStringTable(b, out);
    scanTextProperties(b, out);
    scanBytecodeTexts(b, out);
    return out;
}

const walk = dir => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);

// -> [{asset, ns, key, source}] in file order; first occurrence wins per asset
export function scanAssets(root) {
    const result = [];
    const files = walk(root).filter(f => /\.(uasset|umap|uexp)$/.test(f)).sort();
    const byAsset = new Map();
    for (const f of files) {
        const asset = path.relative(root, f).replaceAll('\\', '/').replace(/\.\w+$/, '');
        byAsset.set(asset, [...(byAsset.get(asset) ?? []), f]);
    }
    for (const [asset, parts] of byAsset) {
        const header = parts.find(f => !f.endsWith('.uexp'));
        const stringTable = !!header && fs.readFileSync(header).includes('StringTable');
        const seen = new Set();
        for (const f of parts) {
            for (const t of scanBuffer(fs.readFileSync(f), { stringTable: stringTable && f.endsWith('.uexp') })) {
                const id = t.ns + '\0' + t.key;
                if (!seen.has(id)) { seen.add(id); result.push({ asset, ...t }); }
            }
        }
    }
    return result;
}
