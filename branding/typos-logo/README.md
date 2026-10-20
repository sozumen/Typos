# Typos logo

The mark is a dark blue capital **T** (also the Greek letter tau) pressed into paper, followed by the
Greek letters **ύπος**, which complete τύπος, "the mark left by a blow; an impression", the root of
"type". The letters are in a contrasting flowing italic in verdigris.

## Colors

| Name | Hex | Use |
|---|---|---|
| Navy | `#14285A` | The T, and one-color versions |
| Verdigris | `#1F6F63` | The Greek letters |
| Paper | `#F3EFE5` | Background of the pressed versions, light icon |
| Cream | `#F3EEE1` | The T on navy (app icon, dark backgrounds) |
| Verdigris, light | `#5FC2AE` | The Greek letters on navy |

Contrast: navy on paper 12.4:1; verdigris on paper 5.2:1 and on white 6.0:1; light verdigris on navy 6.6:1.
Verdigris against navy is only 2.4:1, so use the on-dark version (cream T, light verdigris letters) for dark backgrounds.

## Which file to use

| Need | File |
|---|---|
| Hero use, splash, about box, website header | `typos-wordmark-pressed` (SVG or PNG): navy and verdigris pressed into paper |
| Anywhere on a plain light background | `typos-wordmark-color` (transparent) |
| Dark backgrounds | `typos-wordmark-on-dark` (transparent) |
| One color: stamps, embossing, fax, engraving, watermarks | `typos-wordmark-navy`, `-black`, `-white` |
| The T alone | `typos-mark-navy`, `-white`, `-black`, `-pressed` |
| App icon | `typos-icon` (SVG), `png/typos-icon-<size>.png`, `typos.ico` |
| Platforms that round or mask the icon themselves (macOS, Android) | `png/typos-icon-square.png` (full bleed, T kept inside the safe area) |
| Light icon variant | `typos-icon-light` |
| Browser tab | `typos-favicon.svg`, `favicon.ico` |

The pressed versions use SVG filters (grain, inner shadows). Browsers render them well; Illustrator, Inkscape
and Affinity may not. The PNGs are exact, so use those in tools that mishandle filters. The flat versions are
plain shapes and work everywhere.

## Sizes

- **Wordmark:** at least 120 px wide on screen or 25 mm in print. Smaller than that, use the T alone.
- **The T alone:** at least 16 px. The small app icons (`svg/icon-sizes/`, `png/typos-icon-16` to `-64`) have
  a slightly larger T so they hold up; use them rather than shrinking the large one.
- **Clear space:** keep a space equal to the width of the T's stem (about 6.5% of the wordmark's width) on every side.

## Please don't

- Redraw the T in another typeface, or set the Greek letters in a font. The letters are drawn outlines of Alegreya Italic.
- Put the verdigris letters on navy (use the on-dark version), or the navy T on verdigris.
- Add the pressed effect to a transparent or photographic background; it needs the paper.
- Stretch, rotate, outline, or add a drop shadow.

## Construction notes

- The T is a Roman-style capital drawn for this logo: 144 × 132 units, stem 30, crossbar 16, bracketed foot.
- The letters ύπος are the Alegreya Italic glyphs (weight 600), converted to outlines, set at 23% of the font's
  size against a T 171.6 units high. Letter origins are placed by hand with a small gap after the T; the
  accent over the upsilon stays clear of the T's right serif.
- **Alegreya** is copyright 2011 The Alegreya Project Authors, licensed under the SIL Open Font License 1.1
  (`OFL-Alegreya.txt`). The license allows these outlines to be used in a logo.
- Not included: macOS `.icns` (make it from `png/typos-icon-1024.png` with `iconutil` on a Mac).
- Wired into Typos itself? Not yet: the application's own icons and window branding haven't been replaced.
