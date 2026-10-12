// Speakers of DlgSystem dialogue lines (Data/Dialogues/*): a speech node's Text belongs to its OwnerName
// participant, the other texts of the node are its edges (Children) - the player's answer options.
// Cooked assets use unversioned properties, so this reads raw bytes: package header -> exports -> node properties.
import fs from 'fs';
import path from 'path';
import { readFString } from './scan.mjs';

// player participant; the hero comes from the scene number "<act>-<scene>" in the asset name
const PLAYER = 'MyCharacterName';
const HEROES = { 1: 'Clarissa', 2: 'Howard', 3: 'Renee', 4: 'Eli' };
const NOTIFICATION = 'Notification'; // BP_DialogueEvent_NotifyChoice: "You decided not to antagonize Carlo"

// UE 5.1 unversioned package summary -> names and exports
export function readPackage(b) {
    let p = 0;
    const i32 = () => { const v = b.readInt32LE(p); p += 4; return v; };
    const str = () => { const r = readFString(b, p); p = r.end; return r.s; };
    if (i32() >>> 0 !== 0x9E2A83C1) throw new Error('not a uasset');
    const legacy = i32();
    if (legacy !== -4) i32();
    i32(); const ue5 = legacy <= -8 ? i32() : 0; i32();
    const customVersions = i32();
    p += customVersions * 20;
    const totalHeader = i32(); str();
    const flags = i32() >>> 0;
    const nameCount = i32(), nameOffset = i32();
    if (ue5 === 0 || ue5 >= 1008) p += 8; // soft object paths (unversioned cooks are 5.1)
    if (!(flags & 0x80000000)) str(); // LocalizationId, absent with FilterEditorOnly
    p += 8; // gatherable text data
    const exportCount = i32(), exportOffset = i32(), importCount = i32(), importOffset = i32();
    p = nameOffset;
    const names = [];
    for (let i = 0; i < nameCount; i++) { names.push(str()); p += 4; }
    const importSize = (exportOffset - importOffset) / importCount; // 32 in 5.1
    const importName = i => names[b.readInt32LE(importOffset + i * importSize + 20)];
    const exports = [];
    for (let i = 0; i < exportCount; i++) {
        p = exportOffset + i * 96;
        const cls = i32(); p += 12;
        const name = names[i32()]; p += 8;
        const size = Number(b.readBigInt64LE(p)), offset = Number(b.readBigInt64LE(p + 8));
        exports.push({ cls: cls < 0 ? importName(-cls - 1) : '', name, start: offset - totalHeader, size });
    }
    return { names, exports };
}

// FUnversionedHeader: uint16 fragments (skip & 0x7f, has zeroes 0x80, last 0x100, value count >> 9),
// then a zero mask over the values of fragments with zeroes; zero values are not serialized
export function readUnversionedHeader(d) {
    const props = [];
    let p = 0, index = 0, last = false;
    while (!last) {
        const f = d.readUInt16LE(p); p += 2;
        index += f & 0x7f;
        for (let i = 0; i < f >> 9; i++) props.push({ index: index++, masked: !!(f & 0x80), zero: false });
        last = !!(f & 0x100);
    }
    const masked = props.filter(x => x.masked);
    if (masked.length) {
        masked.forEach((x, i) => x.zero = !!(d[p + (i >> 3)] & (1 << (i & 7))));
        p += masked.length <= 8 ? 1 : masked.length <= 16 ? 2 : Math.ceil(masked.length / 32) * 4;
    }
    return { props, start: p };
}

// FText: int32 flags, int8 history; Base (0) = namespace, key, source; None (-1) = optional invariant string
function readText(d, p) {
    const history = d.readInt8(p + 4);
    p += 5;
    if (history === -1) return { end: d.readInt32LE(p) ? readFString(d, p + 4).end : p + 4 };
    if (history !== 0) throw new Error(`text history ${history}`);
    const ns = readFString(d, p), key = readFString(d, ns.end), src = readFString(d, key.end);
    return { key: key.s, end: src.end };
}

// DlgNode_Speech property indices as cooked in this game: 0-1 bools, 2 Text, 3 TextArguments,
// 4 SpeakerState (FName), 5-9 object refs, 10 16-byte struct, 11 OwnerName (UDlgNode props follow)
const SPEECH_SIZES = { 0: 1, 1: 1, 4: 8, 5: 4, 6: 4, 7: 4, 8: 4, 9: 4, 10: 16 };
export function readSpeechNode(d, names) {
    const { props, start } = readUnversionedHeader(d);
    let p = start, key = null;
    for (const x of props) {
        if (x.index > 11) break;
        if (x.index === 11) return { key, owner: x.zero ? names[0] : names[d.readInt32LE(p)] };
        if (x.zero) continue;
        if (x.index === 2) { const t = readText(d, p); key = t.key ?? null; p = t.end; }
        else if (SPEECH_SIZES[x.index]) p += SPEECH_SIZES[x.index];
        else return { key, owner: null }; // TextArguments: not used by line texts here
    }
    return { key, owner: null }; // OwnerName left at default (None)
}

// texts of a node or event export: FText Base history with a 32-hex-digit key
function textKeys(d) {
    const keys = [];
    for (let p = 4; p < d.length - 12; p++) {
        if (d[p] !== 0) continue;
        const ns = readFString(d, p + 1);
        const key = ns && ns.s.length < 64 && readFString(d, ns.end);
        if (!key || !/^[0-9A-F]{32}$/.test(key.s)) continue;
        const src = readFString(d, key.end);
        if (!src) continue;
        keys.push(key.s);
        p = src.end - 1;
    }
    return keys;
}

// uasset path -> Map(key -> speaker), empty for non-dialogue assets
export function dialogueSpeakers(uasset) {
    const result = new Map();
    const uexp = uasset.replace(/\.uasset$/, '.uexp');
    if (!fs.existsSync(uexp)) return result;
    const { names, exports } = readPackage(fs.readFileSync(uasset));
    if (!exports.some(e => e.cls === 'DlgDialogue')) return result;
    const body = fs.readFileSync(uexp);
    const slice = e => body.subarray(e.start, e.start + e.size);
    const hero = HEROES[path.basename(uasset).match(/(\d)-(\d)/)?.[2]] ?? PLAYER;
    const set = (key, who) => { if (!result.has(key)) result.set(key, who); };
    for (const e of exports) {
        if (e.cls === 'BP_DialogueEvent_NotifyChoice_C') textKeys(slice(e)).forEach(k => set(k, NOTIFICATION));
        if (e.cls !== 'DlgNode_Speech') continue;
        const d = slice(e);
        const line = readSpeechNode(d, names);
        if (line.key && line.owner && line.owner !== 'None') set(line.key, line.owner === PLAYER ? hero : line.owner);
        for (const k of textKeys(d)) if (k !== line.key) set(k, hero);
    }
    return result;
}
