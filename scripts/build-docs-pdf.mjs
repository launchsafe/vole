/**
 * Builds a single self-contained PDF from every markdown document in the repo.
 *
 * Pipeline: markdown -> one HTML file (images inlined as data URIs) -> Chrome headless
 * --print-to-pdf. Chrome is used rather than pandoc/LaTeX because it needs no extra
 * system dependencies, and `--generate-pdf-document-outline` gives the PDF real
 * bookmarks from the heading structure — more useful in a reference document than
 * printed page numbers.
 *
 *   node scripts/build-docs-pdf.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'docs');
const OUT_PDF = join(OUT_DIR, 'Vole-Documentation.pdf');
const TMP_HTML = join(OUT_DIR, '.docs-bundle.html');

/** Order matters: this is the reading order, not the filesystem order. */
const DOCUMENTS = [
  { file: 'README.md',            title: 'Overview',        blurb: 'What Vole is, what is real vs estimated, and how to run it.' },
  { file: 'docs/DECISIONS.md',    title: 'How it was built', blurb: 'The investigation, the five bugs that shaped the architecture, and what was deliberately not built.' },
  { file: 'docs/ARCHITECTURE.md', title: 'Architecture',    blurb: 'Module map, database schema, idempotency contract, and the design system.' },
  { file: 'docs/DATA-SOURCES.md', title: 'Data sources',    blurb: 'What each tool writes to disk, with real samples and the traps in each format.' },
  { file: 'docs/DEVELOPMENT.md',  title: 'Development',     blurb: 'Setup, commands, layering rules, testing philosophy, and debugging recipes.' },
  { file: 'docs/EXTENDING.md',    title: 'Extending',       blurb: 'Complete recipes: add a collector, a rule, a model rate, or a dashboard panel.' },
  { file: 'docs/ROADMAP.md',      title: 'Roadmap',         blurb: 'Ranked next steps, good first issues, and the principles to preserve.' },
];

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.gif': 'image/gif' };

/** Inline images so the PDF is self-contained and paths cannot break. */
function inlineImage(srcPath) {
  if (!existsSync(srcPath)) return null;
  const mime = MIME[extname(srcPath).toLowerCase()];
  if (!mime) return null;
  return `data:${mime};base64,${readFileSync(srcPath).toString('base64')}`;
}

/**
 * The single mermaid block in the README will not render in a print pipeline, so it is
 * replaced with an equivalent hand-authored SVG. Keeping the diagram is worth more than
 * keeping the source syntax.
 */
const DATA_FLOW_SVG = `
<svg viewBox="0 0 760 190" xmlns="http://www.w3.org/2000/svg" class="diagram" role="img"
     aria-label="Data flow: local log files to collectors to SQLite to rules, then API routes to dashboard and widget">
  <defs>
    <marker id="ar" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="#6b7280"/>
    </marker>
  </defs>
  <g font-family="system-ui, sans-serif" font-size="11.5" text-anchor="middle">
    <rect x="6"   y="62" width="120" height="42" rx="5" fill="#eef2f7" stroke="#c8d0dc"/>
    <text x="66"  y="79">Local log files</text><text x="66" y="94" font-size="9.5" fill="#6b7280">4 tools</text>

    <rect x="160" y="62" width="110" height="42" rx="5" fill="#eef2f7" stroke="#c8d0dc"/>
    <text x="215" y="79">Collectors</text><text x="215" y="94" font-size="9.5" fill="#6b7280">normalise</text>

    <rect x="304" y="56" width="132" height="54" rx="5" fill="#e3edfa" stroke="#2a78d6"/>
    <text x="370" y="76">SQLite</text>
    <text x="370" y="92" font-size="9.5" fill="#2a78d6">INSERT OR IGNORE</text>

    <rect x="304" y="6" width="132" height="34" rx="5" fill="#fdf0e8" stroke="#eb6834"/>
    <text x="370" y="27">Anomaly rules</text>

    <rect x="470" y="62" width="112" height="42" rx="5" fill="#eef2f7" stroke="#c8d0dc"/>
    <text x="526" y="79">API routes</text><text x="526" y="94" font-size="9.5" fill="#6b7280">Next.js</text>

    <rect x="620" y="34" width="132" height="38" rx="5" fill="#eef2f7" stroke="#c8d0dc"/>
    <text x="686" y="58">Dashboard</text>

    <rect x="620" y="96" width="132" height="38" rx="5" fill="#eef2f7" stroke="#c8d0dc"/>
    <text x="686" y="120">Menubar widget</text>

    <g stroke="#6b7280" fill="none" marker-end="url(#ar)">
      <path d="M128 83 H156"/>
      <path d="M272 83 H300"/>
      <path d="M352 54 V44"/>
      <path d="M388 44 V54"/>
      <path d="M438 83 H466"/>
      <path d="M584 78 H600 V53 H616"/>
      <path d="M584 88 H600 V115 H616"/>
    </g>
    <text x="370" y="128" font-size="9.5" fill="#6b7280">writes incidents back</text>
    <text x="686" y="150" font-size="9.5" fill="#6b7280">poll every 3s</text>
  </g>
</svg>`;

const md = new MarkdownIt({ html: true, linkify: false, typographer: false })
  .use(anchor, { slugify: (s) => s.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-') });

let bodies = '';
let toc = '';

for (const [i, doc] of DOCUMENTS.entries()) {
  const abs = join(ROOT, doc.file);
  let src = readFileSync(abs, 'utf8');
  const baseDir = dirname(abs);

  // The mermaid fence cannot render here; substitute the equivalent SVG.
  src = src.replace(/```mermaid[\s\S]*?```/g, '<!--DATAFLOW-->');

  // Cross-document links become in-page anchors, since everything is one file now.
  src = src.replace(/\]\((?:\.\.\/)?(?:docs\/)?([A-Z-]+)\.md(#[^)]*)?\)/g,
                    (_m, name, hash) => `](#${hash ? hash.slice(1) : 'doc-' + name.toLowerCase()})`);
  src = src.replace(/\]\(docs\/README\.md\)/g, '](#contents)');

  let html = md.render(src);
  html = html.replace('<!--DATAFLOW-->', DATA_FLOW_SVG);

  // Inline every image reference, resolved against the document's own directory.
  html = html.replace(/(<img[^>]+src=")([^"]+)(")/g, (m, pre, src2, post) => {
    if (src2.startsWith('data:') || src2.startsWith('http')) return m;
    const data = inlineImage(join(baseDir, src2)) ?? inlineImage(join(ROOT, src2));
    return data ? `${pre}${data}${post}` : m;
  });

  const slug = 'doc-' + doc.file.replace(/^docs\//, '').replace('.md', '').toLowerCase();
  toc += `<li><a href="#${slug}"><span class="n">${String(i + 1).padStart(2, '0')}</span>
          <span class="t">${doc.title}</span><span class="b">${doc.blurb}</span></a></li>`;

  bodies += `<section class="doc" id="${slug}">
      <div class="doc-head"><span class="doc-num">${String(i + 1).padStart(2, '0')}</span>
      <h1 class="doc-title">${doc.title}</h1>
      <span class="doc-src">${doc.file}</span></div>
      ${html}
    </section>`;
}

const built = new Date().toISOString().slice(0, 10);

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Vole — Documentation</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  :root { --ink:#12161c; --dim:#4b5565; --faint:#79839a; --line:#dde2ea; --accent:#2a78d6;
          --code-bg:#f5f7fa; --mono: ui-monospace,"SF Mono",Menlo,Consolas,monospace; }
  * { box-sizing: border-box; }
  body { margin:0; color:var(--ink); background:#fff;
         font-family: system-ui,-apple-system,"Segoe UI",sans-serif;
         font-size: 9.6pt; line-height: 1.55; -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  /* Cover */
  .cover { height: 250mm; display:flex; flex-direction:column; justify-content:center;
           page-break-after: always; }
  .cover .mark { width:52px; height:52px; margin-bottom:22px; }
  .cover h1 { font-size: 34pt; margin:0; letter-spacing:-0.02em; font-weight:700; }
  .cover .sub { font-size: 13pt; color:var(--dim); margin-top:8px; font-weight:400; max-width: 130mm; line-height:1.4; }
  .cover .rule { height:3px; width:60px; background:var(--accent); margin:26px 0; }
  .cover dl { display:grid; grid-template-columns: 26mm 1fr; gap:5px 14px; font-size:9pt; margin:0; }
  .cover dt { color:var(--faint); text-transform:uppercase; letter-spacing:.08em; font-size:7.6pt; padding-top:2px; }
  .cover dd { margin:0; font-family:var(--mono); font-size:8.6pt; }
  .cover .note { margin-top:auto; font-size:8.4pt; color:var(--faint); border-top:1px solid var(--line);
                 padding-top:10px; max-width:150mm; }

  /* Contents */
  .contents { page-break-after: always; }
  .contents h2 { font-size:15pt; margin:0 0 16px; letter-spacing:-0.01em; }
  .contents ol { list-style:none; padding:0; margin:0; }
  .contents li { border-bottom:1px solid var(--line); }
  .contents a { display:grid; grid-template-columns: 12mm 42mm 1fr; gap:8px; align-items:baseline;
                padding:9px 2px; text-decoration:none; color:inherit; }
  .contents .n { font-family:var(--mono); color:var(--accent); font-size:9pt; }
  .contents .t { font-weight:600; font-size:10.5pt; }
  .contents .b { color:var(--dim); font-size:8.6pt; line-height:1.4; }

  /* Document sections */
  .doc { page-break-before: always; }
  .doc-head { border-bottom:2px solid var(--ink); padding-bottom:7px; margin-bottom:18px;
              display:flex; align-items:baseline; gap:10px; }
  .doc-num { font-family:var(--mono); color:var(--accent); font-size:10pt; }
  .doc-title { font-size:19pt; margin:0; letter-spacing:-0.015em; flex:1; }
  .doc-src { font-family:var(--mono); font-size:8pt; color:var(--faint); }

  h1,h2,h3,h4 { line-height:1.25; page-break-after: avoid; letter-spacing:-0.01em; }
  .doc > h1 { font-size:14pt; margin:20px 0 8px; }
  h2 { font-size:12.5pt; margin:18px 0 7px; padding-bottom:4px; border-bottom:1px solid var(--line); }
  h3 { font-size:10.6pt; margin:14px 0 5px; }
  h4 { font-size:9.8pt; margin:12px 0 4px; color:var(--dim); }
  p { margin:0 0 8px; }
  ul,ol { margin:0 0 9px; padding-left:18px; }
  li { margin-bottom:3px; }
  a { color:var(--accent); text-decoration:none; }
  strong { font-weight:600; }
  hr { border:0; border-top:1px solid var(--line); margin:16px 0; }

  code { font-family:var(--mono); font-size:8.3pt; background:var(--code-bg);
         padding:1px 4px; border-radius:3px; }
  pre { background:var(--code-bg); border:1px solid var(--line); border-radius:5px;
        padding:9px 11px; overflow:hidden; margin:0 0 10px; page-break-inside: avoid; }
  pre code { background:none; padding:0; font-size:7.9pt; line-height:1.48; white-space:pre-wrap;
             word-break:break-word; }

  table { border-collapse:collapse; width:100%; margin:0 0 11px; font-size:8.5pt;
          page-break-inside: avoid; }
  th { text-align:left; border-bottom:1.5px solid var(--ink); padding:5px 7px; font-size:7.8pt;
       text-transform:uppercase; letter-spacing:.05em; color:var(--dim); }
  td { border-bottom:1px solid var(--line); padding:5px 7px; vertical-align:top; }
  td code { font-size:7.8pt; }

  blockquote { margin:0 0 10px; padding:7px 12px; border-left:3px solid var(--accent);
               background:#f5f9fe; page-break-inside: avoid; }
  blockquote p { margin:0; }

  img { max-width:100%; height:auto; border:1px solid var(--line); border-radius:5px;
        margin:6px 0 10px; page-break-inside: avoid; }
  .diagram { width:100%; max-width:170mm; height:auto; margin:8px 0 12px; }
</style></head>
<body>

<div class="cover">
  <svg class="mark" viewBox="0 0 16 16">
    <path d="M8 1.5 L14 4.5 V8.5 C14 11.8 11.4 14 8 15 C4.6 14 2 11.8 2 8.5 V4.5 Z"
          fill="none" stroke="#2a78d6" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M5 8.6 L7 6.2 L9 9 L11 6.8" fill="none" stroke="#2a78d6"
          stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
  <h1>Vole</h1>
  <div class="sub">Local-first usage, cost and reliability monitor for AI coding agents — complete documentation</div>
  <div class="rule"></div>
  <dl>
    <dt>Version</dt><dd>0.1.0</dd>
    <dt>Built</dt><dd>${built}</dd>
    <dt>Repository</dt><dd>github.com/jayimf432/vole</dd>
    <dt>Platform</dt><dd>macOS 26.5 (arm64)</dd>
    <dt>Licence</dt><dd>MIT</dd>
  </dl>
  <div class="note">
    Generated from the repository's markdown by <code>scripts/build-docs-pdf.mjs</code>.
    The markdown in the repository is the source of truth; regenerate this file after changing it.
  </div>
</div>

<div class="contents" id="contents">
  <h2>Contents</h2>
  <ol>${toc}</ol>
</div>

${bodies}
</body></html>`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(TMP_HTML, page);

const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

execFileSync(CHROME, [
  '--headless',
  '--disable-gpu',
  '--no-sandbox',
  '--no-pdf-header-footer',
  '--generate-pdf-document-outline',   // real PDF bookmarks from the heading structure
  `--print-to-pdf=${OUT_PDF}`,
  `file://${TMP_HTML}`,
], { stdio: 'pipe' });

const kb = Math.round(readFileSync(OUT_PDF).length / 1024);
console.log(`Built ${OUT_PDF} (${kb} KB) from ${DOCUMENTS.length} documents.`);
