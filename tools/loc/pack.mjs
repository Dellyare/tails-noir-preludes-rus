// Packs a staging dir (mirrors the game root: BackboneStories/Content/...) into a pak via UnrealPak.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const UNREAL_PAK = path.resolve(import.meta.dirname, '../utils/Packer/UnrealPak.exe');

const walk = d => fs.readdirSync(d, { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

export function pack(staging, outPak) {
    const files = walk(staging);
    const list = outPak.replace(/\.pak$/, '.filelist.txt');
    fs.writeFileSync(list, files.map(f => `"${f}" "../../../${path.relative(staging, f).replaceAll('\\', '/')}"`).join('\n') + '\n');
    fs.rmSync(outPak, { force: true });
    execFileSync(UNREAL_PAK, [outPak, `-create=${list}`], { stdio: 'ignore' });
    if (!fs.existsSync(outPak)) throw new Error('UnrealPak did not produce ' + outPak);
    return files.length;
}
