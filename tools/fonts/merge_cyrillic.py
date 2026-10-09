"""Adds Cyrillic to a Latin-only game font.

Cyrillic letters that look like Latin ones reuse the base font's own glyphs (А→A, Р→P, ...);
the rest are copied from a donor font, scaled to the base font's cap/x-height and average width.

usage: py -3 merge_cyrillic.py <base.ttf> <donor.ttf> <out.ttf> [--family NAME]
       py -3 merge_cyrillic.py --info <font.ttf>...
"""
import sys
from fontTools.ttLib import TTFont
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.recordingPen import DecomposingRecordingPen

# Cyrillic -> Latin look-alikes (same outline in a grotesque)
LOOKALIKE = {
    'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X',
    'Ѕ': 'S', 'І': 'I', 'Ј': 'J', 'Ё': 'Ë',
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'ѕ': 's', 'і': 'i', 'ј': 'j', 'ё': 'ë',
}
CYRILLIC = [chr(c) for c in range(0x0400, 0x0460)] + ['№']


def metrics(font):
    cmap, hmtx, os2 = font.getBestCmap(), font['hmtx'], font['OS/2']
    adv = lambda s: sum(hmtx[cmap[ord(c)]][0] for c in s) / len(s)
    return {'cap': os2.sCapHeight, 'x': os2.sxHeight, 'upper': adv('HONEADRT'), 'lower': adv('noeadrt')}


def info(paths):
    for p in paths:
        f = TTFont(p)
        cmap = f.getBestCmap()
        print(p, 'upm', f['head'].unitsPerEm, 'glyf' if 'glyf' in f else 'CFF', metrics(f),
              'cyrillic', sum(1 for c in range(0x410, 0x450) if c in cmap))
        print('  copyright:', f['name'].getDebugName(0))


def merge(base_path, donor_path, out_path, family):
    base, donor = TTFont(base_path), TTFont(donor_path)
    if 'glyf' not in base or 'glyf' not in donor:
        raise SystemExit('both fonts must be TrueType (glyf)')
    bm, dm = metrics(base), metrics(donor)
    # vertical scale matches cap/x-height; horizontal matches the base font's average letter width
    scale = {  # is_upper -> (sx, sy)
        True: (bm['upper'] / dm['upper'], bm['cap'] / dm['cap']),
        False: (bm['lower'] / dm['lower'], bm['x'] / dm['x']),
    }
    base_cmap, donor_cmap = base.getBestCmap(), donor.getBestCmap()
    donor_glyphs = donor.getGlyphSet()
    glyf, hmtx = base["glyf"], base["hmtx"]
    added = {}
    for ch in CYRILLIC:
        cp = ord(ch)
        if cp in base_cmap:
            continue
        twin = LOOKALIKE.get(ch)
        if twin and ord(twin) in base_cmap:
            added[cp] = base_cmap[ord(twin)]
            continue
        if cp not in donor_cmap:
            continue
        sx, sy = scale[ch.isupper() or not ch.isalpha()]
        name = 'uni%04X' % cp
        pen = TTGlyphPen(None)
        rec = DecomposingRecordingPen(donor_glyphs)  # flatten composites (Й = И + breve)
        donor_glyphs[donor_cmap[cp]].draw(rec)
        rec.replay(TransformPen(pen, (sx, 0, 0, sy, 0, 0)))
        glyph = pen.glyph()
        glyph.recalcBounds(glyf)
        glyf[name] = glyph
        hmtx[name] = (round(donor['hmtx'][donor_cmap[cp]][0] * sx), getattr(glyph, 'xMin', 0))
        added[cp] = name
    # Й/й: the donor's breve doesn't match; reuse the base font's own breve placed like on Ă/ă
    for ch, latin in (('Й', 'Abreve'), ('й', 'abreve')):
        letter = added.get(ord(ch.translate({0x419: 0x418, 0x439: 0x438})))
        if not letter or latin not in glyf or not glyf[latin].isComposite():
            continue
        accent = next(c for c in glyf[latin].components if c.glyphName != glyf[latin].components[0].glyphName)
        acc, body = glyf[accent.glyphName], glyf[letter]
        acc.recalcBounds(glyf); body.recalcBounds(glyf)
        dx = round((body.xMin + body.xMax) / 2 - (acc.xMin + acc.xMax) / 2)
        pen = TTGlyphPen(glyf)
        pen.addComponent(letter, (1, 0, 0, 1, 0, 0))
        pen.addComponent(accent.glyphName, (1, 0, 0, 1, dx, accent.y))
        name = 'uni%04X' % ord(ch)
        glyf[name] = pen.glyph()
        hmtx[name] = hmtx[letter]
        added[ord(ch)] = name

    base.setGlyphOrder(glyf.glyphOrder)  # glyf[name] = ... already appended new names
    for table in base['cmap'].tables:
        if table.isUnicode():
            table.cmap.update({cp: g for cp, g in added.items() if table.format != 0 and (cp <= 0xFFFF or table.format == 12)})
    if 'post' in base and base['post'].formatType == 2.0:
        base['post'].extraNames = []
        base['post'].mapping = {}
    base["maxp"].numGlyphs = len(glyf.glyphOrder)
    # OFL: a modified font must not keep the original family name
    for rec in base['name'].names:
        if rec.nameID in (1, 4, 16):
            rec.string = family
        elif rec.nameID == 6:
            rec.string = family.replace(' ', '') + '-Regular'
    base.save(out_path)
    print(f'{out_path}: +{len(added)} Cyrillic glyphs '
          f'({sum(1 for g in added.values() if not g.startswith("uni"))} reused from the base font)')


if __name__ == '__main__':
    args = sys.argv[1:]
    if args and args[0] == '--info':
        info(args[1:])
    elif len(args) >= 3:
        family = args[args.index('--family') + 1] if '--family' in args else 'Game Font RU'
        merge(args[0], args[1], args[2], family)
    else:
        print(__doc__)
        sys.exit(1)
