import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse, stringify } from './csv.mjs';
import { scanBuffer } from './scan.mjs';
import { readLocres, writeLocres, strCrc32 } from './locres.mjs';

const fstr = s => {
    const ansi = /^[\x00-\x7f]*$/.test(s);
    const body = Buffer.from(s + '\0', ansi ? 'latin1' : 'utf16le');
    const len = Buffer.alloc(4); len.writeInt32LE(ansi ? s.length + 1 : -(s.length + 1));
    return Buffer.concat([len, body]);
};

test('csv round-trips quotes, commas, newlines, edge whitespace and backslashes', () => {
    const rows = [
        { source: ' He said "hi", then\r\nleft. ', translation: 'Он сказал «привет»,\nи ушёл', namespace: '', key: 'A' },
        { source: 'C:\path\n', translation: '', namespace: 'DlgSystem', key: 'edge_next' },
    ];
    const text = stringify(['source', 'translation', 'namespace', 'key'], rows);
    assert.equal(text.split('\n').length, 4, 'one line per record');
    assert.deepEqual(parse(text), rows);
    assert.deepEqual(parse(text.replaceAll('\n', '\r\n')), rows, 'CRLF files from Excel');
});

test('scanner finds property texts and bytecode literals, skips culture-invariant', () => {
    const flags = f => Buffer.from([f, 0, 0, 0]);
    const prop = (f, ns, key, src) => Buffer.concat([flags(f), Buffer.from([0]), fstr(ns), fstr(key), fstr(src)]);
    const script = s => Buffer.concat([Buffer.from([0x1f]), Buffer.from(s + '\0', 'latin1')]);
    const buf = Buffer.concat([
        Buffer.from([1, 2, 3, 4, 5]),
        prop(0, '', '74F263B24C34BD6ED96447B344BE02C4', 'You nearly froze my hand off.'),
        prop(2, '', 'INVARIANT', 'Not localizable'),
        prop(0, 'DlgSystem', 'edge_next', 'Next'),
        Buffer.from([0x29, 1]), script('Radio Host'), script('53F76A064B859FB73F69938735721F3A'), script(''),
        Buffer.from([9, 9]),
    ]);
    assert.deepEqual(scanBuffer(buf).map(t => [t.ns, t.key, t.source]), [
        ['', '74F263B24C34BD6ED96447B344BE02C4', 'You nearly froze my hand off.'],
        ['DlgSystem', 'edge_next', 'Next'],
        ['', '53F76A064B859FB73F69938735721F3A', 'Radio Host'],
    ]);
});

test('locres write/read round-trip', () => {
    const file = path.join(os.tmpdir(), 'loc-test.locres');
    const entries = [{ ns: '', key: 'K1', source: 'Fair enough.', text: 'Справедливо.' }, { ns: 'DlgSystem', key: 'edge_next', source: 'Next', text: 'Далее' }];
    writeLocres(file, entries);
    assert.deepEqual(readLocres(file).entries, entries.map(e => ({ ns: e.ns, key: e.key, hash: strCrc32(e.source), text: e.text })));
});

// strongest check: rewriting the game's own native locres must give identical bytes
const LOC = path.resolve(import.meta.dirname, '../../workspace/game/BackboneStories/Content/Localization');
test('locres writer reproduces game files byte-for-byte', { skip: !fs.existsSync(LOC) && 'needs npm run unpack' }, () => {
    for (const t of ['Act1', 'Act2', 'Widgets', 'StringTables']) {
        const src = `${LOC}/${t}/en/${t}.locres`;
        const file = path.join(os.tmpdir(), `loc-test-${t}.locres`);
        writeLocres(file, readLocres(src).entries.map(e => ({ ...e, source: e.text })));
        assert.ok(fs.readFileSync(file).equals(fs.readFileSync(src)), t);
    }
});

const TEX = path.resolve(import.meta.dirname, '../../workspace/game/BackboneStories/Content/Widgets/Main_menu/Textures/NEW_Textures');
test('texture codec: BGRA is lossless, DXT1/DXT5 re-encode stays close; png round-trips', { skip: !fs.existsSync(TEX) && 'needs npm run unpack' }, async () => {
    const { decodeTexture, replacePixels, readPng, writePng } = await import('./texture.mjs');
    for (const name of ['YES_A', 'NO_A', 'NO_C']) {
        const uexp = fs.readFileSync(`${TEX}/${name}.uexp`);
        const t = decodeTexture(uexp);
        const png = readPng(writePng(t.w, t.h, t.rgba));
        assert.ok(png.rgba.equals(t.rgba), `${name}: png`);
        const again = replacePixels(uexp, t.rgba, t.w, t.h);
        assert.equal(again.length, uexp.length, `${name}: size kept`);
        if (t.pf === 'PF_B8G8R8A8') assert.ok(again.equals(uexp), `${name}: lossless`);
        const back = decodeTexture(again).rgba;
        // compare premultiplied colour: RGB of fully transparent pixels is irrelevant
        let err = 0;
        for (let i = 0; i < back.length; i += 4) {
            err += (back[i + 3] - t.rgba[i + 3]) ** 2;
            for (let c = 0; c < 3; c++) err += (back[i + c] * back[i + 3] / 255 - t.rgba[i + c] * t.rgba[i + 3] / 255) ** 2;
        }
        assert.ok(Math.sqrt(err / back.length) < 8, `${name}: rmse ${Math.sqrt(err / back.length).toFixed(2)}`);
    }
});

test('batch check keeps placeholders, tags, edge whitespace and CRLF', async () => {
    const { check } = await import('./batch.mjs');
    assert.equal(check(' Time {Hours} h ', 'Время {Hours} ч'), ' Время {Hours} ч ');
    assert.equal(check('a\r\nb', 'а\nб'), 'а\r\nб');
    assert.throws(() => check('Press <img id="A"/>', 'Нажмите'), /теги/);
    assert.throws(() => check('{Act} {Num}', '{Акт} {Num}'), /плейсхолдеры/);
    assert.throws(() => check('Yes', '  '), /пустой/);
});

test('dialogue speech node: Text key and OwnerName from unversioned properties', async () => {
    const { readSpeechNode } = await import('./dialogue.mjs');
    const u16 = v => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
    const i32 = v => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
    const KEY = 'CFE694DF41CAED3806949D851251808E';
    const text = Buffer.concat([i32(0), Buffer.from([0]), fstr(''), fstr(KEY), fstr('Alright, man.')]);
    const names = ['MyCharacterName', 'Larry'];
    // props 2 (Text) and 11 (OwnerName = names[1])
    const owned = Buffer.concat([u16(2 | 1 << 9), u16(8 | 1 << 9 | 0x100), text, i32(1), i32(0)]);
    assert.deepEqual(readSpeechNode(owned, names), { key: KEY, owner: 'Larry' });
    // OwnerName = names[0] is all zeroes: flagged in the zero mask, not serialized
    const zero = Buffer.concat([u16(2 | 1 << 9), u16(8 | 0x80 | 1 << 9 | 0x100), Buffer.from([1]), text]);
    assert.deepEqual(readSpeechNode(zero, names), { key: KEY, owner: 'MyCharacterName' });
});

test('review tool: chunk skips reviewed rows, fixes must belong to the chunk', async () => {
    const { chunkAt, parseFixes } = await import('./review.mjs');
    const rows = [
        { translation: 'Ты пришёл', status: 'ai' },
        { translation: 'Ты пришла', status: 'ok' },
        { translation: '', status: '' },
        { translation: 'Я устал', status: 'ai' },
    ];
    assert.deepEqual(chunkAt(rows, 0), { picked: [0, 3], end: 4 });
    assert.deepEqual([...parseFixes('1|Ты пришла\n4|Я устала\\nвсё', [0, 3])], [[0, 'Ты пришла'], [3, 'Я устала\nвсё']]);
    assert.throws(() => parseFixes('2|x', [0, 3]), /нет в текущем куске/);
    assert.throws(() => parseFixes('Ты|x', [0, 3]), /N\|текст/);
});

test('batch check rejects lost square brackets', async () => {
    const { check } = await import('./batch.mjs');
    assert.throws(() => check('[You look around.]', 'Ты оглядываешься.'), /квадратные скобки/);
    assert.equal(check('[You look around.]', '[Ты оглядываешься.]'), '[Ты оглядываешься.]');
});
