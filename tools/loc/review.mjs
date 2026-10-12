// Review tool for dialogue translations, built for an AI agent: compact chunks with speakers and their
// genders, no text in shell arguments (fixes go through a file), progress kept between runs.
//   node tools/loc/review.mjs next              show the current chunk
//   node tools/loc/review.mjs done [fixes.txt]  apply fixes to the current chunk, then show the next one
//   node tools/loc/review.mjs status
//   --task <name>  separate progress and log per review pass (gender by default, e.g. style)
//   --act <folder> (Act_I, Act_II, ...) to review one act with separate progress,
//   --only-ok to review the human-reviewed rows instead of the machine-translated ones
// fixes.txt: one fix per line "N|new translation" (N = row number shown in the chunk; \n as in the chunk)
import fs from 'fs';
import path from 'path';
import { readCsv, writeCsv, escapeValue, unescapeValue } from './csv.mjs';
import { check } from './batch.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DIALOGUES = path.join(ROOT, 'translation/Data/Dialogues');
const opt = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : '';
const STATE_DIR = path.join(ROOT, 'workspace', opt('--task') || 'gender');
// --act Act_I limits the review to one folder of Data/Dialogues, with its own progress (agents can run in parallel)
const ACT = opt('--act');
// --only-ok reviews just the human-reviewed rows (skipped by default), with its own progress
const ONLY_OK = process.argv.includes('--only-ok');
const PROGRESS = path.join(STATE_DIR, `progress${ACT ? '-' + ACT : ''}${ONLY_OK ? '-ok' : ''}.json`);
const LOG = path.join(STATE_DIR, 'log.jsonl');
const CHUNK = 60;

// м = male, ж = female; objects and groups get a hint instead
export const GENDER = {
    Clarissa: 'ж', Howard: 'м', Renee: 'ж', Eli: 'м',
    Larry: 'м', Lukas: 'м', 'The Visitor': 'м', Jorge: 'м', Wisconsin: 'м', Freja: 'ж', 'Uncle Clemence': 'м',
    Uncle: 'м, дядя Клеменс', Niles: 'м', Clarence: 'м, дедушка Клариссы', Carlo: 'м, отец Клариссы', Lincoln: 'м', Andrina: 'ж',
    May: 'ж', 'Man Covered in Snow': 'м', Bocco: 'м', 'Father Ioseph': 'м', 'Grandfather Steam': 'паровые часы, м',
    'Radio Host': 'м', Geezers: 'гуси, мн. ч.', Crowd: 'толпа', You: 'внутренний голос героя',
    Notification: 'уведомление, обращается к герою',
};
const HEROES = ['Clarissa', 'Howard', 'Renee', 'Eli'];
const g = name => `${name} (${GENDER[name] ?? 'предмет'})`;

const walk = d => fs.readdirSync(d, { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.csv') ? [path.join(d, e.name)] : []);
const files = () => walk(ACT ? path.join(DIALOGUES, ACT) : DIALOGUES).sort();

// rows worth checking: machine-translated, with Russian text long enough to carry gender
const reviewable = r => (r.status === 'ok') === ONLY_OK && /[а-яё]{2}/i.test(r.translation) && r.translation.length > 3;

const load = () => { try { return JSON.parse(fs.readFileSync(PROGRESS, 'utf8')); } catch { return { file: 0, row: 0 }; } };
const save = s => { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(PROGRESS, JSON.stringify(s)); };

// current chunk: up to CHUNK reviewable rows starting at data row s.row (0-based) of file s.file
export function chunkAt(rows, start) {
    const picked = [];
    let i = start;
    for (; i < rows.length && picked.length < CHUNK; i++) if (reviewable(rows[i])) picked.push(i);
    return { picked, end: i };
}

function current() {
    const list = files();
    const s = load();
    while (s.file < list.length) {
        const rows = readCsv(list[s.file]);
        const c = chunkAt(rows, s.row);
        if (c.picked.length) return { s, file: list[s.file], rows, ...c, total: list.length };
        s.file++; s.row = 0;
    }
    return null;
}

function show() {
    const c = current();
    if (!c) return console.log('ВСЁ ГОТОВО');
    const speakers = [...new Set(c.rows.map(r => r.speaker).filter(Boolean))];
    const hero = speakers.find(n => HEROES.includes(n));
    console.log(`ФАЙЛ ${c.s.file + 1}/${c.total} ${path.relative(ROOT, c.file).replaceAll('\\', '/')} строки ${c.picked[0] + 1}-${c.picked.at(-1) + 1} из ${c.rows.length}`);
    console.log(`Герой: ${hero ? g(hero) : '?'}. Остальные: ${speakers.filter(n => n !== hero).map(g).join(', ') || '-'}`);
    for (const i of c.picked) {
        const r = c.rows[i];
        console.log(`${i + 1} ${r.speaker || '?'}: ${escapeValue(r.source)} ⇒ ${escapeValue(r.translation)}`);
    }
}

// "N|text" lines -> Map(rowIndex -> text); throws on lines outside the chunk
export function parseFixes(text, picked) {
    const fixes = new Map();
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const m = line.match(/^\s*(\d+)\s*\|(.*)$/);
        if (!m) throw new Error(`строка не в формате N|текст: ${line.slice(0, 60)}`);
        const i = +m[1] - 1;
        if (!picked.includes(i)) throw new Error(`строки ${m[1]} нет в текущем куске`);
        fixes.set(i, unescapeValue(m[2]));
    }
    return fixes;
}

function done(fixFile) {
    const c = current();
    if (!c) return console.log('ВСЁ ГОТОВО');
    if (fixFile) {
        const fixes = parseFixes(fs.readFileSync(fixFile, 'utf8'), c.picked);
        const log = [];
        for (const [i, text] of fixes) {
            const r = c.rows[i];
            let fixed;
            try { fixed = check(r.source, text); } // placeholders, tags, edge whitespace, dashes
            catch (e) { throw new Error(`строка ${i + 1}: ${e.message}`); }
            if (fixed === r.translation) continue;
            log.push(JSON.stringify({ file: path.relative(ROOT, c.file).replaceAll('\\', '/'), row: i + 1, key: r.key, speaker: r.speaker, before: r.translation, after: fixed }));
            r.translation = fixed;
        }
        writeCsv(c.file, Object.keys(c.rows[0]), c.rows);
        if (log.length) fs.appendFileSync(LOG, log.join('\n') + '\n');
        fs.rmSync(fixFile); // a stale fix file must not hit the next chunk
        console.log(`Исправлено: ${log.length}`);
    }
    save({ file: c.s.file, row: c.end });
    show();
}

function status() {
    const s = load(), list = files();
    const fixed = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    console.log(`Файл ${Math.min(s.file + 1, list.length)}/${list.length}, строка ${s.row}; исправлений всего: ${fixed}`);
}

if (process.argv[1]?.endsWith('review.mjs')) {
    const [cmd, arg] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !['--act', '--task'].includes(all[i - 1]));
    try {
        if (cmd === 'next') show();
        else if (cmd === 'done') done(arg);
        else if (cmd === 'status') status();
        else console.log('usage: node tools/loc/review.mjs next | done [fixes.txt] | status  [--task style] [--act Act_I] [--only-ok]');
    } catch (e) {
        console.log(`ОШИБКА: ${e.message}. Ничего не записано, исправь файл и повтори done.`);
        process.exitCode = 1;
    }
}
