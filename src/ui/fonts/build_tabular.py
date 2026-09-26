#!/usr/bin/env python3
"""Derive tabular-figure digit fonts from D-DIN (SIL OFL 1.1) for jitter-free HUD numbers.

D-DIN ships proportional figures only (no `tnum`). This script subsets each source TTF to the
digits 0-9 (+ U+2212 minus, U+2009 thin space, which D-DIN lacks), gives every digit the same advance (max digit width) with the outline centered,
strips hinting/layout, renames the family (OFL Reserved Font Name "D-DIN" must not be used for
modified versions -> "HUD Figures") and writes WOFF to public/fonts/.

Usage: python3 src/ui/fonts/build_tabular.py <dir-with-D-DIN-ttfs>
"""
import sys, os
from fontTools.ttLib import TTFont
from fontTools import subset

SRC = sys.argv[1] if len(sys.argv) > 1 else '.'
OUT = os.path.join(os.path.dirname(__file__), '..', '..', '..', 'public', 'fonts')
FACES = [('D-DIN.ttf', 'HUDFigures-Regular'), ('D-DIN-Bold.ttf', 'HUDFigures-Bold'),
         ('D-DINExp.ttf', 'HUDFiguresExp-Regular'), ('D-DINExp-Bold.ttf', 'HUDFiguresExp-Bold')]

for src, name in FACES:
    f = TTFont(os.path.join(SRC, src))
    opts = subset.Options()
    opts.hinting = False
    opts.layout_features = []
    opts.name_IDs = ['*']
    opts.notdef_outline = True
    s = subset.Subsetter(opts)
    s.populate(unicodes=[ord(c) for c in '0123456789'])
    s.subset(f)
    cmap = f.getBestCmap()
    glyf, hmtx = f['glyf'], f['hmtx']
    names = [cmap[ord(c)] for c in '0123456789']
    adv = max(hmtx[g][0] for g in names)
    for g in names:
        w, lsb = hmtx[g]
        dx = (adv - w) // 2
        gl = glyf[g]
        if gl.isComposite():
            for c in gl.components:
                c.x += dx
        elif gl.numberOfContours > 0:
            gl.coordinates.translate((dx, 0))
        gl.recalcBounds(glyf)
        hmtx[g] = (adv, getattr(gl, 'xMin', lsb + dx))
    # U+2212 MINUS SIGN (D-DIN lacks it): hyphen's vertical stroke band, digit-width bar, centered
    from fontTools.pens.ttGlyphPen import TTGlyphPen
    hy = TTFont(os.path.join(SRC, src))
    hyg = hy['glyf'][hy.getBestCmap()[ord('-')]]
    y0, y1 = hyg.yMin, hyg.yMax
    pen = TTGlyphPen(None)
    m = int(adv * 0.12)
    pen.moveTo((m, y0)); pen.lineTo((m, y1)); pen.lineTo((adv - m, y1)); pen.lineTo((adv - m, y0)); pen.closePath()
    order = f.getGlyphOrder()
    for gname, glyph, width in (('uni2212', pen.glyph(), adv), ('uni2009', TTGlyphPen(None).glyph(), int(adv * 0.36))):
        order.append(gname)
        glyf.glyphs[gname] = glyph
        glyf.glyphOrder = order
        if glyph.numberOfContours:
            glyph.recalcBounds(glyf)
        hmtx.metrics[gname] = (width, getattr(glyph, 'xMin', 0) if glyph.numberOfContours else 0)
    f.setGlyphOrder(order)
    for tbl in f['cmap'].tables:
        if tbl.isUnicode():
            tbl.cmap[0x2212] = 'uni2212'
            tbl.cmap[0x2009] = 'uni2009'
    f['maxp'].numGlyphs = len(order)
    fam = 'HUD Figures Exp' if 'Exp' in name else 'HUD Figures'
    style = 'Bold' if 'Bold' in name else 'Regular'
    for rec in f['name'].names:
        if rec.nameID in (1, 16):
            rec.string = fam
        elif rec.nameID in (4,):
            rec.string = f'{fam} {style}'
        elif rec.nameID in (6,):
            rec.string = name
        elif rec.nameID == 3:
            rec.string = f'{name};derived-from-D-DIN'
    f.flavor = 'woff'
    out = os.path.join(OUT, name + '.woff')
    f.save(out)
    print(out, 'advance', adv)
