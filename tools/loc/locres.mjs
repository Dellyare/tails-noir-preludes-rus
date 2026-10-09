// Read/write UE .locres (writes version 3 "Optimized_CityHash64_UTF16", as UE 5.1 does)
import fs from 'fs';

const MAGIC = Buffer.from('0e147475674a03fc4a15909dc3377f1b', 'hex');

// --- hashes -------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256).map((_, i) => {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

// FCrc::StrCrc32 — hash of the source string that the engine compares against
export function strCrc32(s) {
    let c = ~0;
    for (let i = 0; i < s.length; i++) {
        let x = s.charCodeAt(i);
        for (let k = 0; k < 4; k++) { c = (c >>> 8) ^ CRC_TABLE[(c ^ x) & 0xff]; x >>>= 8; }
    }
    return ~c >>> 0;
}

const M = (1n << 64n) - 1n;
const k0 = 0xc3a5c85c97cb3127n, k1 = 0xb492b66fbe98f273n, k2 = 0x9ae16a3b2f90404fn;
const rot = (v, s) => s === 0n ? v : ((v >> s) | (v << (64n - s))) & M;
const smix = v => v ^ (v >> 47n);
const bswap = v => { let r = 0n; for (let i = 0; i < 8; i++) { r = (r << 8n) | (v & 0xffn); v >>= 8n; } return r; };
function h16(u, v, mul = 0x9ddfea08eb382d69n) {
    let a = ((u ^ v) * mul) & M; a ^= a >> 47n;
    let b = ((v ^ a) * mul) & M; b ^= b >> 47n;
    return (b * mul) & M;
}

// CityHash64 v1.1 (UE's CityHash.cpp)
export function cityHash64(buf) {
    const f64 = o => buf.readBigUInt64LE(o), f32 = o => BigInt(buf.readUInt32LE(o));
    const len = buf.length, L = BigInt(len);
    if (len <= 16) {
        if (len >= 8) {
            const mul = k2 + L * 2n, a = (f64(0) + k2) & M, b = f64(len - 8);
            const c = (rot(b, 37n) * mul + a) & M, d = ((rot(a, 25n) + b) * mul) & M;
            return h16(c, d, mul);
        }
        if (len >= 4) { const mul = k2 + L * 2n; return h16((L + (f32(0) << 3n)) & M, f32(len - 4), mul); }
        if (len > 0) {
            const y = BigInt(buf[0]) + (BigInt(buf[len >> 1]) << 8n), z = L + (BigInt(buf[len - 1]) << 2n);
            return (smix(((y * k2) ^ (z * k0)) & M) * k2) & M;
        }
        return k2;
    }
    if (len <= 32) {
        const mul = k2 + L * 2n, a = (f64(0) * k1) & M, b = f64(8), c = (f64(len - 8) * mul) & M, d = (f64(len - 16) * k2) & M;
        return h16((rot((a + b) & M, 43n) + rot(c, 30n) + d) & M, (a + rot((b + k2) & M, 18n) + c) & M, mul);
    }
    if (len <= 64) {
        const mul = k2 + L * 2n;
        let a = (f64(0) * k2) & M, b = f64(8);
        const c = f64(len - 24), d = f64(len - 32), e = (f64(16) * k2) & M, f = (f64(24) * 9n) & M, g = f64(len - 8), h = (f64(len - 16) * mul) & M;
        const u = (rot((a + g) & M, 43n) + ((rot(b, 30n) + c) * 9n)) & M;
        const v = ((((a + g) & M) ^ d) + f + 1n) & M;
        const w = (bswap(((u + v) * mul) & M) + h) & M;
        const x = (rot((e + f) & M, 42n) + c) & M;
        const y = ((bswap(((v + w) * mul) & M) + g) * mul) & M;
        const z = (e + f + c) & M;
        a = (bswap(((x + z) * mul + y) & M) + b) & M;
        b = (smix(((z + a) * mul + d + h) & M) * mul) & M;
        return (b + x) & M;
    }
    const weak = (o, a, b) => {
        const w = f64(o), x = f64(o + 8), y = f64(o + 16), z = f64(o + 24);
        a = (a + w) & M; b = rot((b + a + z) & M, 21n);
        const c = a; a = (a + x + y) & M; b = (b + rot(a, 44n)) & M;
        return [(a + z) & M, (b + c) & M];
    };
    let x = f64(len - 40), y = (f64(len - 16) + f64(len - 56)) & M, z = h16((f64(len - 48) + L) & M, f64(len - 24));
    let v = weak(len - 64, L, z), w = weak(len - 32, (y + k1) & M, x);
    x = (x * k1 + f64(0)) & M;
    let n = (len - 1) & ~63, s = 0;
    do {
        x = (rot((x + y + v[0] + f64(s + 8)) & M, 37n) * k1) & M;
        y = (rot((y + v[1] + f64(s + 48)) & M, 42n) * k1) & M;
        x ^= w[1];
        y = (y + v[0] + f64(s + 40)) & M;
        z = (rot((z + w[0]) & M, 33n) * k1) & M;
        v = weak(s, (v[1] * k1) & M, (x + w[0]) & M);
        w = weak(s + 32, (z + w[1]) & M, (y + f64(s + 16)) & M);
        [z, x] = [x, z];
        s += 64; n -= 64;
    } while (n !== 0);
    return h16((h16(v[0], w[0]) + smix(y) * k1 + z) & M, (h16(v[1], w[1]) + x) & M);
}

// TextKeyUtil::HashString: CityHash64 over UTF-16 bytes folded to 32 bits by GetTypeHash(uint64)
export function textKeyHash(s) {
    if (!s) return 0;
    const h = cityHash64(Buffer.from(s, 'utf16le'));
    return Number(((h & 0xffffffffn) + (h >> 32n) * 23n) & 0xffffffffn);
}

// --- io ----------------------------------------------------------------

export function readLocres(file) {
    const b = fs.readFileSync(file);
    let p = 0;
    const i32 = () => { const v = b.readInt32LE(p); p += 4; return v; };
    const u32 = () => { const v = b.readUInt32LE(p); p += 4; return v; };
    const str = () => {
        const n = i32();
        if (!n) return '';
        let s;
        if (n < 0) { s = b.toString('utf16le', p, p - n * 2 - 2); p += -n * 2; }
        else { s = b.toString('latin1', p, p + n - 1); p += n; }
        return s;
    };
    if (!b.subarray(0, 16).equals(MAGIC)) throw new Error(`${file}: legacy locres not supported`);
    p = 16;
    const ver = b[p++];
    const strOff = Number(b.readBigInt64LE(p)); p += 8;
    if (ver >= 3) u32();
    const back = p; p = strOff;
    const strings = [];
    for (let n = i32(); n > 0; n--) { strings.push(str()); if (ver >= 2) i32(); }
    p = back;
    const entries = [];
    for (let nsN = u32(); nsN > 0; nsN--) {
        if (ver >= 2) u32();
        const ns = str();
        for (let kN = u32(); kN > 0; kN--) {
            if (ver >= 2) u32();
            const key = str();
            const hash = u32();
            entries.push({ ns, key, hash, text: strings[i32()] });
        }
    }
    return { version: ver, entries };
}

// entries: [{ns, key, source, text}] — hash is computed from source
export function writeLocres(file, entries) {
    const parts = [];
    const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); parts.push(b); };
    const i32 = v => { const b = Buffer.alloc(4); b.writeInt32LE(v); parts.push(b); };
    // keys/namespaces are FTextKey: an empty one is still written as a lone NUL
    const str = (s, isKey) => {
        if (!s && !isKey) return i32(0);
        if (/^[\x00-\x7f]*$/.test(s)) { i32(s.length + 1); parts.push(Buffer.from(s + '\0', 'latin1')); }
        else { i32(-(s.length + 1)); parts.push(Buffer.from(s + '\0', 'utf16le')); }
    };

    const strings = [], strIndex = new Map(), refs = [];
    const intern = s => {
        if (!strIndex.has(s)) { strIndex.set(s, strings.length); strings.push(s); refs.push(0); }
        const i = strIndex.get(s); refs[i]++; return i;
    };
    const byNs = new Map();
    for (const e of entries) {
        if (!byNs.has(e.ns)) byNs.set(e.ns, new Map());
        byNs.get(e.ns).set(e.key, e);
    }

    parts.push(MAGIC, Buffer.from([3]));
    const offPos = parts.push(Buffer.alloc(8)) - 1;
    u32([...byNs.values()].reduce((n, m) => n + m.size, 0));
    u32(byNs.size);
    for (const [ns, keys] of byNs) {
        u32(textKeyHash(ns)); str(ns, true); u32(keys.size);
        for (const [key, e] of keys) {
            u32(textKeyHash(key)); str(key, true); u32(strCrc32(e.source)); i32(intern(e.text));
        }
    }
    const offset = parts.reduce((n, b) => n + b.length, 0);
    parts[offPos].writeBigInt64LE(BigInt(offset));
    i32(strings.length);
    strings.forEach((s, i) => { str(s); i32(refs[i]); });
    fs.writeFileSync(file, Buffer.concat(parts));
}
