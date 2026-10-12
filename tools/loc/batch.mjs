// Bulk work on translation CSVs (for translators and AI agents).
//   node tools/loc/batch.mjs todo <file.csv> [--from N] [--to M]
//        JSON lines {n, key, source} of untranslated rows (n = 1-based number among them)
//   node tools/loc/batch.mjs apply <translations.json>... [--dry-run] [--status ai|ok] [--force]
//        translations.json: { "<path/to/file.csv>": { "<key>": "<translation>" } }
//        rows get status "ai" unless --status ok; --dry-run only validates
import fs from 'fs';
import { readCsv, writeCsv } from './csv.mjs';

const tokens = (s, re) => (s.match(re) ?? []).sort().join('\u0000');
const PLACEHOLDER = /\{[^{}]*\}/g, TAG = /<[^<>]+>/g;
const TRAIT = /^\s*\([A-Z][A-Z :'-]*\)/; // (CYNIC), (GAIN TRAIT: CARING): brackets stay round

// returns the normalized translation or throws with a reason
export function check(source, text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('пустой перевод');
    if (tokens(source, PLACEHOLDER) !== tokens(text, PLACEHOLDER)) throw new Error(`плейсхолдеры не совпадают: ${source.match(PLACEHOLDER)} / ${text.match(PLACEHOLDER)}`);
    if (tokens(source, TAG) !== tokens(text, TAG)) throw new Error('теги <...> не совпадают');
    if (TRAIT.test(source) && !/^\s*\(/.test(text)) throw new Error('пометка (ЧЕРТА) должна остаться в круглых скобках, как в оригинале');
    const count = (s, c) => s.split(c).length - 1;
    if (count(source, '[') !== count(text, '[') || count(source, ']') !== count(text, ']'))
        throw new Error('квадратные скобки [...] должны остаться как в оригинале');
    if (!/[—–]/.test(source)) text = text.replace(/[—–]/g, '-'); // dashes follow the original: plain hyphen unless the source has a long dash
    if (source.includes('\r\n')) text = text.replace(/\r?\n/g, '\r\n'); // keep the source's line endings
    const lead = source.match(/^\s*/)[0], trail = source.match(/\s*$/)[0];
    return lead + text.trim() + trail;
}

const opt = (args, name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;

if (process.argv[1]?.endsWith('batch.mjs')) {
    const [cmd, ...args] = process.argv.slice(2);
    if (cmd === 'todo') {
        const from = +(opt(args, '--from') ?? 1), to = +(opt(args, '--to') ?? Infinity);
        readCsv(args[0]).filter(r => !r.translation).forEach((r, i) => {
            if (i + 1 >= from && i + 1 <= to) console.log(JSON.stringify({ n: i + 1, key: r.key, speaker: r.speaker, source: r.source }));
        });
    } else if (cmd === 'apply') {
        const dry = args.includes('--dry-run'), force = args.includes('--force');
        const status = opt(args, '--status') ?? 'ai';
        const jsons = args.filter((a, i) => a.endsWith('.json') && !['--status'].includes(args[i - 1]));
        let problems = 0;
        for (const json of jsons) {
            for (const [file, tr] of Object.entries(JSON.parse(fs.readFileSync(json, 'utf8')))) {
                if (!fs.existsSync(file)) { console.log(`! ${json}: нет файла ${file}`); problems++; continue; }
                const rows = readCsv(file);
                const byKey = new Map(rows.map(r => [r.key, r]));
                let applied = 0, same = 0;
                for (const [key, text] of Object.entries(tr)) {
                    const r = byKey.get(key);
                    const fail = msg => { console.log(`! ${file} ${key}: ${msg}`); problems++; };
                    if (!r) { fail('нет такого ключа'); continue; }
                    if (r.translation && !force) { fail('уже переведено (--force, чтобы перезаписать)'); continue; }
                    if (typeof text === 'string' && text.trim() === r.source.trim()) { same++; continue; } // copy of the source = nothing to translate
                    try { r.translation = check(r.source, text); r.status = status; applied++; }
                    catch (e) { fail(e.message); }
                }
                if (!dry) writeCsv(file, Object.keys(rows[0]), rows); // keep the file's columns (speaker is only in dialogues)
                console.log(`${dry ? '[проверка] ' : ''}${file}: ${applied} строк${same ? ` (${same} совпадают с оригиналом — пропущены)` : ''}, без перевода осталось ${rows.filter(r => !r.translation).length}`);
            }
        }
        if (problems) { console.log(`проблем: ${problems}`); process.exitCode = 2; }
    } else {
        console.error('usage: node tools/loc/batch.mjs todo <file.csv> [--from N] [--to M] | apply <translations.json>... [--dry-run] [--status ai|ok] [--force]');
        process.exit(1);
    }
}
