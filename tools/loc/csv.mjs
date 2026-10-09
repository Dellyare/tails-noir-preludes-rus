// RFC 4180 CSV with one record per line: control chars inside values are escaped (\n, \r, \t, \\)
// so files stay diff-friendly and git eol normalization can't alter in-game strings.
import fs from 'fs';

const BOM = '﻿';

export const escapeValue = s => s.replace(/[\\\r\n\t]/g, c => ({ '\\': '\\\\', '\r': '\\r', '\n': '\\n', '\t': '\\t' })[c]);
export const unescapeValue = s => s.replace(/\\([\\rnt])/g, (_, c) => ({ '\\': '\\', r: '\r', n: '\n', t: '\t' })[c]);

const quote = s => /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;

export function stringify(header, rows) {
    return BOM + [header, ...rows.map(r => header.map(h => escapeValue(r[h] ?? '')))]
        .map(cells => cells.map(quote).join(',')).join('\n') + '\n';
}

export function parse(text) {
    text = text.replace(/^﻿/, '');
    const records = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c !== '"') cell += c;
            else if (text[i + 1] === '"') { cell += '"'; i++; }
            else quoted = false;
        } else if (c === '"') quoted = true;
        else if (c === ',') { row.push(cell); cell = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(cell); records.push(row); row = []; cell = '';
        } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); records.push(row); }
    const [header, ...data] = records;
    if (!header) return [];
    return data.filter(r => r.some(Boolean))
        .map(r => Object.fromEntries(header.map((h, i) => [h, unescapeValue(r[i] ?? '')])));
}

export const readCsv = file => parse(fs.readFileSync(file, 'utf8'));
export const writeCsv = (file, header, rows) => fs.writeFileSync(file, stringify(header, rows), 'utf8');
