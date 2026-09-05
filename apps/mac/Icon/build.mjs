// Regenerates the Vole app-icon artwork from one geometry definition.
//   node Icon/build.mjs           → Icon/preview/*.png  (treatment contact shots)
//   node Icon/build.mjs --emit    → also writes the real assets:
//                                     Icon/Vole.icns            (for the .app bundle)
//                                     Icon/AppIcon.appiconset/  (if an Xcode project is added later)
//                                     ../Sources/Vole/Resources/AppIcon.png  (runtime Dock icon)
// Needs `sharp` (a workspace dep). SVG uses <path> only; the Y-channels are a <mask> knockout.
import { mkdirSync, writeFileSync, rmSync, globSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

// sharp is a transitive workspace dep, not hoisted — grab it from the pnpm store.
const require = createRequire(import.meta.url);
const root = new URL("../../../", import.meta.url).pathname;
const sharp = require(globSync(`${root}node_modules/.pnpm/sharp@*/node_modules/sharp`)[0]);

const DIR = new URL(".", import.meta.url).pathname;
const CHOICE = "ink"; // the shipped treatment

// --- geometry, 1024 canvas, centred on (512,512) -------------------------------
// Isometric box: top rhombus + two side faces meeting at the centre. Three thin
// channels run out along the seams from a round hub; a dot sits in the hub.
const HEX = "M512,132 L874,332 L874,692 L512,892 L150,692 L150,332 Z";
const ARMS = [
  "M512,512 L512,960", // down     — splits the two lower faces to the bottom point
  "M512,512 L96,305",  // up-left  — seam between top face and left face
  "M512,512 L928,305", // up-right — seam between top face and right face
];
const ARM_W = 104;  // channel width — thin, so the hub reads as a hub
const RING_R = 196; // hub radius (carves the circular bite out of each face)
const DOT_R = 98;   // ink centre dot

/** The mark as a self-contained group, drawn in `ink`, channels cut to `gap`.
 *  gap === "transparent" → real knockout via mask; else a solid fill. */
function mark(ink, gap) {
  const arms = ARMS.map((d) => `<path d="${d}"/>`).join("");
  const id = `m${Math.random().toString(36).slice(2, 7)}`; // unique per instance
  if (gap === "transparent") {
    return `
    <defs><mask id="${id}">
      <path d="${HEX}" fill="#fff"/>
      <g stroke="#000" stroke-width="${ARM_W}" fill="none" stroke-linecap="round">${arms}</g>
      <circle cx="512" cy="512" r="${RING_R}" fill="#000"/>
    </mask></defs>
    <g>
      <path d="${HEX}" fill="${ink}" mask="url(#${id})"/>
      <circle cx="512" cy="512" r="${DOT_R}" fill="${ink}"/>
    </g>`;
  }
  return `
    <defs><clipPath id="${id}"><path d="${HEX}"/></clipPath></defs>
    <g clip-path="url(#${id})">
      <path d="${HEX}" fill="${ink}"/>
      <g stroke="${gap}" stroke-width="${ARM_W}" fill="none" stroke-linecap="round">${arms}</g>
      <circle cx="512" cy="512" r="${RING_R}" fill="${gap}"/>
      <circle cx="512" cy="512" r="${DOT_R}" fill="${ink}"/>
    </g>`;
}

// macOS card: 824 rounded square inside 1024 (100px shadow gutter), glyph at 78 %.
const CARD_FIT = "translate(512 512) scale(0.78) translate(-512 -512)";
function card(bg, ink, gap) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
    <defs>
      <clipPath id="card"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath>
      ${bg.def ?? ""}
    </defs>
    <g clip-path="url(#card)">
      <rect x="100" y="100" width="824" height="824" fill="${bg.fill}"/>
      <g transform="${CARD_FIT}">${mark(ink, gap)}</g>
    </g>
  </svg>`;
}

const grad = (id, a, b) => ({
  fill: `url(#${id})`,
  def: `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`,
});

const TREATMENTS = {
  // transparent master — feed this one into Icon Composer for the Liquid Glass build
  glyph: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${mark("#0A0A0A", "transparent")}</svg>`,
  ink: card(grad("k", "#24252A", "#0B0B0C"), "#F5F5F7", "#141519"),
  light: card(grad("l", "#FDFDFE", "#E9EBEE"), "#0B0B0C", "#FDFDFE"),
  dark: card(grad("d", "#33353A", "#191A1D"), "#F4F4F6", "#212226"),
  blue: card(grad("b", "#3B82F6", "#1D4ED8"), "#FFFFFF", "#2E6BD6"),
};

// --- always: write the SVGs + a preview PNG per treatment ---------------------
mkdirSync(`${DIR}preview`, { recursive: true });
for (const [name, svg] of Object.entries(TREATMENTS)) {
  writeFileSync(`${DIR}${name}.svg`, svg.trim());
  await sharp(Buffer.from(svg)).resize(512, 512).png().toFile(`${DIR}preview/${name}.png`);
}
console.log("previews →", Object.keys(TREATMENTS).join(", "));

// --- --emit: the real assets from CHOICE ------------------------------------
if (process.argv.includes("--emit")) {
  const svg = Buffer.from(TREATMENTS[CHOICE]);
  const png = (s) => sharp(svg).resize(s, s).png().toBuffer();

  // 1. .icns via iconutil
  const set = `${DIR}Vole.iconset`;
  rmSync(set, { recursive: true, force: true });
  mkdirSync(set);
  for (const s of [16, 32, 64, 128, 256, 512, 1024]) {
    const b = await png(s);
    if (s !== 1024) writeFileSync(`${set}/icon_${s}x${s}.png`, b);
    if (s !== 16) writeFileSync(`${set}/icon_${s / 2}x${s / 2}@2x.png`, b);
  }
  execFileSync("iconutil", ["-c", "icns", set, "-o", `${DIR}Vole.icns`]);
  rmSync(set, { recursive: true, force: true });

  // 2. .appiconset (only matters if someone adds an Xcode project)
  const aset = `${DIR}AppIcon.appiconset`;
  rmSync(aset, { recursive: true, force: true });
  mkdirSync(aset);
  writeFileSync(`${aset}/icon_512x512@2x.png`, await png(1024));
  writeFileSync(`${aset}/Contents.json`, JSON.stringify({
    images: [{ filename: "icon_512x512@2x.png", idiom: "mac", scale: "2x", size: "512x512" }],
    info: { author: "xcode", version: 1 },
  }, null, 2));

  // 3. runtime Dock icon (bundled resource, set by VoleApp at launch)
  writeFileSync(`${DIR}../Sources/Vole/Resources/AppIcon.png`, await png(1024));

  // 4. menu-bar glyph — bare mark, tight crop, transparent; AppKit tints it as a
  //    template so it tracks the menu bar's light/dark + highlight state.
  const mb = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="25 25 974 974">${mark("#000", "transparent")}</svg>`;
  writeFileSync(`${DIR}../Sources/Vole/Resources/MenuBarGlyph.png`,
    await sharp(Buffer.from(mb)).resize(36, 36).png().toBuffer());

  console.log(`emitted Vole.icns + AppIcon.appiconset + Resources/{AppIcon,MenuBarGlyph}.png  (treatment: ${CHOICE})`);
}
