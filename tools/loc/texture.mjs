// Cooked UTexture2D with inline single-mip data (B8G8R8A8 / DXT1 / DXT5) <-> RGBA, plus minimal PNG io.
// Replacing pixels keeps the .uexp byte size, so no package headers need patching.
import zlib from 'zlib';

const BLOCK_BYTES = { PF_DXT1: 8, PF_DXT5: 16 };
const dataSize = (pf, w, h) => pf === 'PF_B8G8R8A8' ? w * h * 4 : Math.ceil(w / 4) * Math.ceil(h / 4) * BLOCK_BYTES[pf];

// FTexturePlatformData: SizeX, SizeY, PackedData, FString PixelFormat, FirstMip, NumMips,
// then per mip: BulkDataFlags, ElementCount, SizeOnDisk, int64 Offset, <data>
export function parseTexture(uexp) {
    const p = uexp.indexOf('PF_');
    if (p < 16) throw new Error('pixel format not found');
    const w = uexp.readInt32LE(p - 16), h = uexp.readInt32LE(p - 12);
    const pfEnd = uexp.indexOf(0, p), pf = uexp.toString('latin1', p, pfEnd);
    const numMips = uexp.readInt32LE(pfEnd + 5), size = uexp.readInt32LE(pfEnd + 17);
    if (!(pf in BLOCK_BYTES) && pf !== 'PF_B8G8R8A8') throw new Error(`unsupported format ${pf}`);
    if (numMips !== 1 || size !== dataSize(pf, w, h)) throw new Error(`only single-mip inline textures are supported (${pf} ${w}x${h}, mips ${numMips})`);
    return { w, h, pf, dataAt: pfEnd + 29, size };
}

const unpack565 = v => [((v >> 11) & 31) * 255 / 31 | 0, ((v >> 5) & 63) * 255 / 63 | 0, (v & 31) * 255 / 31 | 0];
const pack565 = ([r, g, b]) => ((r * 31 / 255 + 0.5) << 11) | ((g * 63 / 255 + 0.5) << 5) | (b * 31 / 255 + 0.5);
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function colorPalette(c0, c1, fourColor) {
    const p0 = unpack565(c0), p1 = unpack565(c1);
    return fourColor ? [p0, p1, mix(p0, p1, 1 / 3), mix(p0, p1, 2 / 3)] : [p0, p1, mix(p0, p1, 0.5), [0, 0, 0]];
}

export function decodeTexture(uexp) {
    const t = parseTexture(uexp);
    const { w, h, pf } = t, d = uexp.subarray(t.dataAt, t.dataAt + t.size), rgba = Buffer.alloc(w * h * 4);
    if (pf === 'PF_B8G8R8A8') {
        for (let i = 0; i < w * h; i++) rgba.set([d[i * 4 + 2], d[i * 4 + 1], d[i * 4], d[i * 4 + 3]], i * 4);
        return { ...t, rgba };
    }
    const bs = BLOCK_BYTES[pf];
    let o = 0;
    for (let by = 0; by < h; by += 4) for (let bx = 0; bx < w; bx += 4, o += bs) {
        const c = o + bs - 8, c0 = d.readUInt16LE(c), c1 = d.readUInt16LE(c + 2), bits = d.readUInt32LE(c + 4);
        const pal = colorPalette(c0, c1, pf === 'PF_DXT5' || c0 > c1);
        let alpha = null;
        if (pf === 'PF_DXT5') {
            const a0 = d[o], a1 = d[o + 1];
            const ap = a0 > a1 ? [a0, a1, ...[1, 2, 3, 4, 5, 6].map(k => Math.round(((7 - k) * a0 + k * a1) / 7))]
                : [a0, a1, ...[1, 2, 3, 4].map(k => Math.round(((5 - k) * a0 + k * a1) / 5)), 0, 255];
            const ab = d.readUIntLE(o + 2, 6);
            alpha = i => ap[Math.floor(ab / 2 ** (3 * i)) & 7];
        }
        for (let i = 0; i < 16; i++) {
            const x = bx + (i & 3), y = by + (i >> 2);
            if (x >= w || y >= h) continue;
            const idx = (bits >>> (2 * i)) & 3;
            const a = alpha ? alpha(i) : (c0 <= c1 && idx === 3 ? 0 : 255);
            rgba.set([...pal[idx], a], (y * w + x) * 4);
        }
    }
    return { ...t, rgba };
}

// simple range-fit DXT block encoder: endpoints = min/max along the luminance axis
function encodeColorBlock(px, forceFour) {
    const lum = p => p[0] * 0.299 + p[1] * 0.587 + p[2] * 0.114;
    const visible = px.filter(p => p[3] >= 128);
    if (!forceFour && visible.length === 0) return Buffer.from([0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]);
    const src = visible.length ? visible : px;
    let lo = src[0], hi = src[0];
    for (const p of src) { if (lum(p) < lum(lo)) lo = p; if (lum(p) > lum(hi)) hi = p; }
    let c0 = pack565(hi), c1 = pack565(lo);
    const transparent = !forceFour && visible.length < px.length;
    if (transparent ? c0 > c1 : c0 < c1) [c0, c1] = [c1, c0];
    if (!transparent && c0 === c1) c1 = c0 > 0 ? c0 - 1 : (c0 = 1, 0);
    const pal = colorPalette(c0, c1, !transparent);
    let bits = 0;
    px.forEach((p, i) => {
        let best = 0, bestD = Infinity;
        for (let k = 0; k < (transparent ? 3 : 4); k++) {
            const dd = (p[0] - pal[k][0]) ** 2 + (p[1] - pal[k][1]) ** 2 + (p[2] - pal[k][2]) ** 2;
            if (dd < bestD) { bestD = dd; best = k; }
        }
        if (transparent && p[3] < 128) best = 3;
        bits |= best << (2 * i);
    });
    const b = Buffer.alloc(8);
    b.writeUInt16LE(c0); b.writeUInt16LE(c1, 2); b.writeUInt32LE(bits >>> 0, 4);
    return b;
}

function encodeAlphaBlock(px) {
    const as = px.map(p => p[3]);
    const a0 = Math.max(...as), a1 = Math.min(...as);
    const pal = a0 > a1 ? [a0, a1, ...[1, 2, 3, 4, 5, 6].map(k => Math.round(((7 - k) * a0 + k * a1) / 7))] : [a0, a1, a0, a0, a0, a0, a0, a0];
    let bits = 0;
    as.forEach((a, i) => {
        let best = 0;
        pal.forEach((v, k) => { if (Math.abs(v - a) < Math.abs(pal[best] - a)) best = k; });
        bits += best * 2 ** (3 * i);
    });
    const b = Buffer.alloc(8);
    b[0] = a0; b[1] = a1; b.writeUIntLE(bits, 2, 6);
    return b;
}

export function encodeTexture(pf, w, h, rgba) {
    if (pf === 'PF_B8G8R8A8') {
        const out = Buffer.alloc(w * h * 4);
        for (let i = 0; i < w * h; i++) out.set([rgba[i * 4 + 2], rgba[i * 4 + 1], rgba[i * 4], rgba[i * 4 + 3]], i * 4);
        return out;
    }
    const blocks = [];
    for (let by = 0; by < h; by += 4) for (let bx = 0; bx < w; bx += 4) {
        const px = [];
        for (let i = 0; i < 16; i++) {
            const x = Math.min(bx + (i & 3), w - 1), y = Math.min(by + (i >> 2), h - 1), o = (y * w + x) * 4;
            px.push([rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]]);
        }
        if (pf === 'PF_DXT5') blocks.push(encodeAlphaBlock(px), encodeColorBlock(px, true));
        else blocks.push(encodeColorBlock(px, false));
    }
    return Buffer.concat(blocks);
}

export function replacePixels(uexp, rgba, w, h) {
    const t = parseTexture(uexp);
    if (w !== t.w || h !== t.h) throw new Error(`PNG is ${w}x${h}, texture is ${t.w}x${t.h}`);
    const out = Buffer.from(uexp);
    encodeTexture(t.pf, w, h, rgba).copy(out, t.dataAt);
    return out;
}

// --- PNG (8-bit RGBA / RGB, non-interlaced) ---------------------------------

const CRC_TABLE = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = b => { let c = -1; for (const x of b) c = CRC_TABLE[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };

export function writePng(w, h, rgba) {
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
        return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    const raw = Buffer.alloc(h * (w * 4 + 1));
    for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function readPng(buf) {
    let p = 8, w, h, bpp, idat = [];
    while (p < buf.length) {
        const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
        if (type === 'IHDR') {
            w = data.readUInt32BE(0); h = data.readUInt32BE(4);
            if (data[8] !== 8 || ![2, 6].includes(data[9]) || data[12]) throw new Error('PNG must be 8-bit RGB/RGBA, non-interlaced');
            bpp = data[9] === 6 ? 4 : 3;
        } else if (type === 'IDAT') idat.push(data);
        p += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, px = Buffer.alloc(h * stride), rgba = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
        const f = raw[y * (stride + 1)];
        for (let x = 0; x < stride; x++) {
            const r = raw[y * (stride + 1) + 1 + x], a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
            const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
            px[y * stride + x] = (r + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 255;
        }
    }
    for (let i = 0; i < w * h; i++) rgba.set([px[i * bpp], px[i * bpp + 1], px[i * bpp + 2], bpp === 4 ? px[i * bpp + 3] : 255], i * 4);
    return { w, h, rgba };
}
