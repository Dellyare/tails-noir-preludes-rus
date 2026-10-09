// Translation pipeline: unpack game -> extract texts to CSV -> build .locres pak.
// usage: node tools/loc/cli.mjs <unpack|extract|build|status> [options]
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { scanAssets } from './scan.mjs';
import { parse, readCsv, writeCsv } from './csv.mjs';
import { readLocres, writeLocres } from './locres.mjs';
import { pack } from './pack.mjs';
import { decodeTexture, replacePixels, readPng, writePng } from './texture.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const GAME_ASSETS = path.join(ROOT, 'workspace/game');
const TRANSLATION = path.join(ROOT, 'translation');
const TEXTURES = path.join(ROOT, 'textures');
const FONTS = path.join(ROOT, 'fonts');
const CONTENT = 'BackboneStories/Content';
// FuryPlugin loads this string table from <culture>/UI_Fury.csv itself ("Press any key" etc.)
const FURY_TABLE = 'BackboneStories/Plugins/FuryPlugin/Content/Localization';
const BUILD = path.join(ROOT, 'build');
const UNPAK = path.join(ROOT, 'tools/unpak');
const PAK_NAME = 'TailsRUS_P.pak';
// status: ai = machine translation awaiting review, ok = reviewed by a human
const HEADER = ['source', 'translation', 'status', 'namespace', 'key'];

// Localization targets registered by the game (DefaultEngine.ini LocalizationPaths)
const TARGETS = ['Act1', 'Act2', 'Act3', 'Act4', 'Act5', 'Widgets', 'DataTables', 'StringTables'];
const CULTURES = ['en', 'ru']; // the game falls back to en when ru isn't the selected language

const walk = d => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];
const id = r => r.namespace + '\0' + r.key;

function gameDir(arg) {
    const dir = arg ?? process.env.GAME_DIR;
    if (!dir) throw new Error('Укажи папку игры аргументом или в переменной GAME_DIR');
    const paks = path.join(dir, 'BackboneStories/Content/Paks');
    if (!fs.existsSync(paks)) throw new Error(`Не найдено: ${paks}`);
    return paks;
}

// asset path -> CSV path under translation/
function csvPathFor(asset) {
    const rel = asset.replace(/^BackboneStories\/Content\//, '').replace(/^BackboneStories\//, '');
    return path.join(TRANSLATION, rel + '.csv');
}

function unpack(dir) {
    const pak = path.join(gameDir(dir), 'BackboneStories-Windows.pak');
    const exe = path.join(UNPAK, 'bin/unpak.exe');
    if (!fs.existsSync(path.join(UNPAK, 'oo2core_9_win64.dll')))
        throw new Error('Нужен tools/unpak/oo2core_9_win64.dll (см. README)');
    if (!fs.existsSync(exe)) execFileSync('dotnet', ['build', UNPAK, '-c', 'Release', '-o', path.dirname(exe)], { stdio: 'inherit' });
    fs.rmSync(GAME_ASSETS, { recursive: true, force: true });
    execFileSync(exe, [pak, GAME_ASSETS, '.uasset', '.uexp', '.umap', '.locres', '.ufont', '.csv'], { stdio: 'inherit' });
}

function extract() {
    if (!fs.existsSync(GAME_ASSETS)) throw new Error('Сначала npm run unpack');
    const texts = scanAssets(GAME_ASSETS).filter(t => !t.asset.startsWith('Engine/'));

    // key names on button prompts ("Space", "Delete") come from the engine's own localization
    const engineLoc = path.join(GAME_ASSETS, 'Engine/Content/Localization/Engine/en/Engine.locres');
    for (const e of readLocres(engineLoc).entries)
        if (e.ns === 'InputKeys') texts.push({ asset: 'Engine/InputKeys', ns: e.ns, key: e.key, source: e.text });
    for (const r of parse(fs.readFileSync(path.join(GAME_ASSETS, FURY_TABLE, 'en/UI_Fury.csv'), 'utf8')))
        texts.push({ asset: 'Plugins/FuryPlugin/UI_Fury', ns: 'UI_Fury', key: r.Key, source: r.SourceString });

    const old = new Map();
    for (const f of walk(TRANSLATION).filter(f => f.endsWith('.csv')))
        for (const r of readCsv(f)) if (r.translation) old.set(id(r), r);

    // a key can only have one locres entry, so it lives in the first asset that uses it
    const files = new Map(), placed = new Set();
    let changedSource = 0;
    for (const t of texts) {
        const row = { source: t.source, translation: '', status: '', namespace: t.ns, key: t.key };
        if (placed.has(id(row))) continue;
        placed.add(id(row));
        const prev = old.get(id(row));
        if (prev) {
            row.translation = prev.translation;
            row.status = prev.status;
            if (prev.source !== row.source) { changedSource++; row.status = 'ai'; console.warn(`! исходник изменился: ${t.asset} ${t.key}`); }
            old.delete(id(row));
        }
        const file = csvPathFor(t.asset);
        files.set(file, [...(files.get(file) ?? []), row]);
    }

    for (const f of walk(TRANSLATION).filter(f => f.endsWith('.csv') && !files.has(f))) fs.rmSync(f);
    for (const [file, rows] of files) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeCsv(file, HEADER, rows);
    }
    for (const r of old.values()) console.warn(`! перевод потерян (ключа больше нет в игре): ${r.key} ${JSON.stringify(r.source).slice(0, 60)}`);
    console.log(`Текстов: ${placed.size}, файлов: ${files.size}, исходник изменился: ${changedSource}, потеряно переводов: ${old.size}`);
}

function build(installDir) {
    const entries = [], seen = new Set();
    for (const f of walk(TRANSLATION).filter(f => f.endsWith('.csv'))) {
        for (const r of readCsv(f)) {
            if (!r.translation || seen.has(id(r))) continue;
            seen.add(id(r));
            entries.push({ ns: r.namespace, key: r.key, source: r.source, text: r.translation });
        }
    }

    // all entries go to one target; the rest get empty locres to shadow the stale ones
    // shipped by the game (they contain the previous game's translation)
    const staging = path.join(BUILD, 'staging');
    fs.rmSync(staging, { recursive: true, force: true });
    for (const target of TARGETS) {
        for (const culture of CULTURES) {
            const dir = path.join(staging, 'BackboneStories/Content/Localization', target, culture);
            fs.mkdirSync(dir, { recursive: true });
            writeLocres(path.join(dir, `${target}.locres`), target === TARGETS[0] ? entries : []);
        }
    }

    // the plugin's string table is a plain CSV, so ship it translated for both cultures
    const fury = readCsv(path.join(TRANSLATION, 'Plugins/FuryPlugin/UI_Fury.csv'));
    const furyCsv = ['Key,SourceString', ...fury.map(r => [r.key, r.translation || r.source].map(v => `"${v.replaceAll('"', '""')}"`).join(','))].join('\r\n') + '\r\n';
    for (const culture of CULTURES) {
        const dir = path.join(staging, FURY_TABLE, culture);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'UI_Fury.csv'), furyCsv);
    }

    // fonts/<asset>.ufont replace the game's font files (the FontFace asset only references the file)
    const ufonts = walk(FONTS).filter(f => f.endsWith('.ufont'));
    for (const font of ufonts) {
        const out = path.join(staging, CONTENT, path.relative(FONTS, font));
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.copyFileSync(font, out);
    }

    // textures/<asset>.png -> pixels baked into a copy of the game's texture
    const pngs = walk(TEXTURES).filter(f => f.endsWith('.png'));
    for (const png of pngs) {
        const asset = path.join(CONTENT, path.relative(TEXTURES, png).replace(/\.png$/, ''));
        const src = path.join(GAME_ASSETS, asset);
        if (!fs.existsSync(src + '.uexp')) throw new Error(`Нет оригинала текстуры ${asset} — сначала npm run unpack`);
        const { w, h, rgba } = readPng(fs.readFileSync(png));
        const out = path.join(staging, asset);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.copyFileSync(src + '.uasset', out + '.uasset');
        try { fs.writeFileSync(out + '.uexp', replacePixels(fs.readFileSync(src + '.uexp'), rgba, w, h)); }
        catch (e) { throw new Error(`${path.relative(ROOT, png)}: ${e.message}`); }
    }

    const pakPath = path.join(BUILD, PAK_NAME);
    pack(staging, pakPath);
    console.log(`Строк в переводе: ${entries.length}, текстур: ${pngs.length}, шрифтов: ${ufonts.length} -> ${path.relative(ROOT, pakPath)}`);

    if (installDir !== undefined) {
        const target = path.join(gameDir(installDir || undefined), PAK_NAME);
        fs.copyFileSync(pakPath, target);
        console.log(`Установлено: ${target}`);
    }
}

// game texture -> textures/<asset>.png to be redrawn
function textureExport(asset) {
    if (!asset) throw new Error('Укажи путь ассета от Content, например Widgets/Main_menu/Textures/NEW_Textures/YES_A');
    asset = asset.replaceAll('\\', '/').replace(/^\/?(Game|BackboneStories\/Content)\//, '').replace(/\.\w+$/, '');
    const src = path.join(GAME_ASSETS, CONTENT, asset + '.uexp');
    if (!fs.existsSync(src)) throw new Error(`Не найдено: ${src}`);
    const t = decodeTexture(fs.readFileSync(src));
    const out = path.join(TEXTURES, asset + '.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, writePng(t.w, t.h, t.rgba));
    console.log(`${path.relative(ROOT, out)} (${t.w}x${t.h}, ${t.pf})`);
}

// textures/redraw.json -> originals decoded to workspace -> tools/redraw typesets the translation -> textures/*.png
function redraw() {
    const specFile = path.join(TEXTURES, 'redraw.json');
    const spec = JSON.parse(fs.readFileSync(specFile, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
    const srcDir = path.join(ROOT, 'workspace/redraw-src');
    for (const asset of Object.keys(spec)) {
        const src = path.join(GAME_ASSETS, CONTENT, asset + '.uexp');
        if (!fs.existsSync(src)) throw new Error(`Нет оригинала ${asset} — сначала npm run unpack`);
        const t = decodeTexture(fs.readFileSync(src));
        fs.mkdirSync(path.dirname(path.join(srcDir, asset)), { recursive: true });
        fs.writeFileSync(path.join(srcDir, asset + '.png'), writePng(t.w, t.h, t.rgba));
    }
    const tool = path.join(ROOT, 'tools/redraw');
    const exe = path.join(tool, 'bin/redraw.exe');
    if (!fs.existsSync(exe)) execFileSync('dotnet', ['build', tool, '-c', 'Release', '-o', path.dirname(exe)], { stdio: 'inherit' });
    execFileSync(exe, [specFile, srcDir, TEXTURES, path.join(GAME_ASSETS, CONTENT, 'Fonts')], { stdio: 'inherit' });
}

// game fonts without Cyrillic -> fonts/<asset>.ufont with Cyrillic glyphs added (tools/fonts/merge_cyrillic.py)
const FONT_MERGES = [
    { asset: 'Fonts/Anton-Regular', donor: 'tools/fonts/FiraSansExtraCondensed-Black.ttf', family: 'Anton RU' },
];
function fonts() {
    for (const { asset, donor, family } of FONT_MERGES) {
        const base = path.join(GAME_ASSETS, CONTENT, asset + '.ufont');
        if (!fs.existsSync(base)) throw new Error(`Нет шрифта ${asset} — сначала npm run unpack`);
        const out = path.join(FONTS, asset + '.ufont');
        fs.mkdirSync(path.dirname(out), { recursive: true });
        execFileSync('py', ['-3', path.join(ROOT, 'tools/fonts/merge_cyrillic.py'), base, path.join(ROOT, donor), out, '--family', family], { stdio: 'inherit' });
    }
}

// groups for the progress table: Data/Dialogues/Act_I, Data/Datatables, Maps/Act1, Widgets, ...
function group(file) {
    const parts = path.relative(TRANSLATION, file).split(path.sep);
    const depth = parts[0] === 'Data' ? (parts[1] === 'Dialogues' ? 3 : 2) : parts[0] === 'Maps' ? 2 : 1;
    return parts.slice(0, Math.min(depth, parts.length - 1)).join('/') || parts[0];
}

function status() {
    const stats = new Map();
    for (const f of walk(TRANSLATION).filter(f => f.endsWith('.csv'))) {
        const s = stats.get(group(f)) ?? { done: 0, ok: 0, total: 0 };
        for (const r of readCsv(f)) { s.total++; if (r.translation) s.done++; if (r.translation && r.status === 'ok') s.ok++; }
        stats.set(group(f), s);
    }
    const all = [...stats.values()].reduce((a, s) => ({ done: a.done + s.done, ok: a.ok + s.ok, total: a.total + s.total }), { done: 0, ok: 0, total: 0 });
    console.log('| Раздел | Переведено | Проверено | Всего | % |\n|---|---:|---:|---:|---:|');
    for (const [g, s] of [...stats].sort(([a], [b]) => a.localeCompare(b)).concat([['**Всего**', all]]))
        console.log(`| ${g} | ${s.done} | ${s.ok} | ${s.total} | ${Math.floor(100 * s.done / s.total)}% |`);
}

const [cmd, ...args] = process.argv.slice(2);
const commands = {
    unpack: () => unpack(args[0]),
    extract,
    build: () => build(args[0] === '--install' ? (args[1] ?? '') : undefined),
    status,
    'texture-export': () => args.forEach(textureExport),
    redraw,
    fonts,
};
if (!commands[cmd]) { console.error('usage: node tools/loc/cli.mjs <unpack [gameDir]|extract|build [--install [gameDir]]|status|texture-export <asset...>>'); process.exit(1); }
try { commands[cmd](); } catch (e) { console.error(e.message); process.exit(1); }
