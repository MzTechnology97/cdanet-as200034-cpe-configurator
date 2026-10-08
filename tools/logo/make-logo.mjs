// Generates the CDA Net logo (vector) for web (SVG) and Android (VectorDrawable).
// Geometry measured on the reference artwork (2000 x 712 px).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';

// Usage: npm install && node make-logo.mjs [repoRoot]   (FONT_DIR must contain arial.ttf / arialbd.ttf)
const OUT = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const FONT_DIR = process.env.FONT_DIR ?? 'C:/Windows/Fonts';
const COLOR = '#F15A2C';
const bold = opentype.loadSync(join(FONT_DIR, 'arialbd.ttf'));
const regular = opentype.loadSync(join(FONT_DIR, 'arial.ttf'));

// ---- Symbol: central ring + six satellite rings joined by spokes -------------
const rings = [
  { cx: 329, cy: 385, r: 149, w: 24 }, // hub
  { cx: 316.5, cy: 68.5, r: 47.5, w: 14 },
  { cx: 556, cy: 178, r: 77.5, w: 15 },
  { cx: 170, cy: 193, r: 43, w: 14 },
  { cx: 73.5, cy: 373.5, r: 61.5, w: 14 },
  { cx: 198, cy: 587, r: 58, w: 14 },
  { cx: 575.5, cy: 632, r: 70, w: 15 },
];
const spokes = [
  [318, 122, 322, 224],
  [446, 279, 497, 236],
  [201, 231, 231, 260],
  [141, 378, 171, 381],
  [233, 538, 246, 518],
  [437, 502, 522, 578],
];
const SPOKE_W = 11;

// ---- Wordmark "CDA Net": Arial Bold outlines, corners rounded by a round-join stroke
const ROUND = 9; // stroke width used to round the glyph corners
const target = { x0: 683, x1: 1892, top: 283, base: 501 }; // measured box of the letters
function wordmark() {
  const text = 'CDA Net';
  const capH = (bold.tables.os2.sCapHeight || 0.716 * bold.unitsPerEm) / bold.unitsPerEm;
  const size = (target.base - target.top - ROUND) / capH;
  const glyphs = bold.stringToGlyphs(text);
  const scale = size / bold.unitsPerEm;
  // natural advance width, then distribute extra tracking to match the artwork width
  let natural = 0;
  glyphs.forEach((g, i) => {
    natural += g.advanceWidth * scale;
    if (i < glyphs.length - 1) natural += bold.getKerningValue(g, glyphs[i + 1]) * scale;
  });
  const lastBox = glyphs[glyphs.length - 1].getBoundingBox();
  const firstBox = glyphs[0].getBoundingBox();
  const inkWidthNatural = natural - (glyphs[glyphs.length - 1].advanceWidth - lastBox.x2) * scale - firstBox.x1 * scale;
  const wanted = target.x1 - target.x0 - ROUND;
  const tracking = (wanted - inkWidthNatural) / (glyphs.length - 1);
  let x = target.x0 + ROUND / 2 - firstBox.x1 * scale;
  const y = target.base - ROUND / 2;
  const parts = [];
  glyphs.forEach((g, i) => {
    parts.push(g.getPath(x, y, size).toPathData(2));
    x += g.advanceWidth * scale + tracking;
    if (i < glyphs.length - 1) x += bold.getKerningValue(g, glyphs[i + 1]) * scale;
  });
  return parts.filter(Boolean).join(' ');
}
function trademark() {
  // "TM" box 1922..1996 x 208..248
  const size = 40 / 0.716;
  const p = regular.getPath('TM', 0, 0, size);
  const bb = p.getBoundingBox();
  const s = 74 / (bb.x2 - bb.x1);
  const q = regular.getPath('TM', 1922 - bb.x1 * s, 248, size * s);
  return q.toPathData(2);
}
const textPath = wordmark();
const tmPath = trademark();

// ---- SVG -----------------------------------------------------------------------
// weight > 1 thickens strokes for small renderings (favicon, launcher icon).
const symbolSvg = (weight = 1) =>
  [
    ...rings.map((c) => `<circle cx="${c.cx}" cy="${c.cy}" r="${c.r}" fill="none" stroke-width="${(c.w * weight).toFixed(1)}"/>`),
    ...spokes.map(([x1, y1, x2, y2]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke-width="${(SPOKE_W * weight).toFixed(1)}" stroke-linecap="round"/>`),
  ].join('');
const ICON_WEIGHT = 1.8;
// Square box around the symbol (ink spans x 5..653, y 14..710) with room for the thicker icon strokes.
const ICON_BOX = { x: -36, y: -3, size: 730 };

const full = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2000 712" role="img" aria-label="CDA Net">
<g fill="none" stroke="${COLOR}">${symbolSvg()}</g>
<path d="${textPath}" fill="${COLOR}" stroke="${COLOR}" stroke-width="${ROUND}" stroke-linejoin="round"/>
<path d="${tmPath}" fill="${COLOR}"/>
</svg>
`;
// Symbol only, square, for favicons and app icons (symbol spans x 5..653, y 14..709).
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${ICON_BOX.x} ${ICON_BOX.y} ${ICON_BOX.size} ${ICON_BOX.size}" role="img" aria-label="CDA Net">
<g fill="none" stroke="${COLOR}">${symbolSvg(ICON_WEIGHT)}</g>
</svg>
`;
mkdirSync(join(OUT, 'web/assets'), { recursive: true });
writeFileSync(join(OUT, 'web/assets/cda-net-logo.svg'), full);
writeFileSync(join(OUT, 'web/assets/icon.svg'), icon);

// ---- Android VectorDrawable ---------------------------------------------------------
const circlePath = (c) => `M${c.cx - c.r},${c.cy} a${c.r},${c.r} 0 1,0 ${2 * c.r},0 a${c.r},${c.r} 0 1,0 ${-2 * c.r},0`;
const symbolVector = (color) =>
  [
    ...rings.map((c) => `        <path android:pathData="${circlePath(c)}" android:strokeColor="${color}" android:strokeWidth="${c.w}" android:fillColor="#00000000" />`),
    ...spokes.map(
      ([x1, y1, x2, y2]) =>
        `        <path android:pathData="M${x1},${y1} L${x2},${y2}" android:strokeColor="${color}" android:strokeWidth="${SPOKE_W}" android:strokeLineCap="round" />`,
    ),
  ].join('\n');

const res = join(OUT, 'android/app/src/main/res/drawable');
mkdirSync(res, { recursive: true });
// Launcher foreground: adaptive icons are masked to (at least) the 66dp safe-zone circle,
// so fit the symbol's minimal enclosing circle (rings include half their stroke) in 64dp.
const discs = [
  ...rings.map((c) => ({ x: c.cx, y: c.cy, r: c.r + (c.w * ICON_WEIGHT) / 2 })),
  ...spokes.flatMap(([x1, y1, x2, y2]) => [{ x: x1, y: y1, r: (SPOKE_W * ICON_WEIGHT) / 2 }, { x: x2, y: y2, r: (SPOKE_W * ICON_WEIGHT) / 2 }]),
];
let best = { x: 0, y: 0, R: Infinity };
for (let x = 250; x <= 450; x += 1) {
  for (let y = 280; y <= 480; y += 1) {
    const R = Math.max(...discs.map((d) => Math.hypot(d.x - x, d.y - y) + d.r));
    if (R < best.R) best = { x, y, R };
  }
}
const s = 32 / best.R;
writeFileSync(
  join(res, 'ic_launcher_foreground.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<!-- CDA Net symbol on the 108dp adaptive-icon canvas (generated by tools/logo/make-logo.mjs). -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <group
        android:scaleX="${s.toFixed(5)}"
        android:scaleY="${s.toFixed(5)}"
        android:translateX="${(54 - best.x * s).toFixed(3)}"
        android:translateY="${(54 - best.y * s).toFixed(3)}">
${symbolVector('#F15A2C', ICON_WEIGHT)}
    </group>
</vector>
`,
);
writeFileSync(
  join(res, 'cda_net_logo.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<!-- Full CDA Net logo (generated by tools/logo/make-logo.mjs). -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="300dp"
    android:height="107dp"
    android:viewportWidth="2000"
    android:viewportHeight="712">
${symbolVector('#F15A2C')}
    <path android:pathData="${textPath}" android:fillColor="#F15A2C" android:strokeColor="#F15A2C" android:strokeWidth="${ROUND}" android:strokeLineJoin="round" />
    <path android:pathData="${tmPath}" android:fillColor="#F15A2C" />
</vector>
`,
);
console.log('text path length', textPath.length, 'launcher circle', best);
