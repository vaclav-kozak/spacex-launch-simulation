# UI assets

| File(s) | Source | License |
|---|---|---|
| `public/fonts/D-DIN.woff2`, `D-DIN-Bold.woff2`, `D-DINExp.woff2`, `D-DINExp-Bold.woff2`, `D-DINCondensed.woff2`, `D-DINCondensed-Bold.woff2` | D-DIN by Datto Inc., https://www.datto.com/fonts/d-din, downloaded from Font Library https://fontlibrary.org/en/font/d-din (`d-din.zip`) | SIL Open Font License 1.1 (`public/fonts/D-DIN-OFL.txt`, `D-DIN-FONTLOG.txt`) |
| `public/fonts/HUDFigures-Regular.woff`, `HUDFigures-Bold.woff`, `HUDFiguresExp-Regular.woff`, `HUDFiguresExp-Bold.woff` | Derived from the D-DIN TTFs above by `src/ui/fonts/build_tabular.py`: digits 0–9 subset with equal (tabular) advances, plus a U+2212 minus and U+2009 thin space that D-DIN lacks. Renamed "HUD Figures" because "D-DIN" is a Reserved Font Name. | SIL Open Font License 1.1 (modified version, same license) |

D-DIN is the closest freely licensed match to the DIN-style face used in SpaceX webcast graphics.
All icons (speaker, octaweb, vehicle silhouettes, deck map) are inline SVG drawn in code, except the GitHub and X
marks in the author byline (`src/ui/Controls.ts`), which are Simple Icons, https://simpleicons.org (CC0 1.0).
