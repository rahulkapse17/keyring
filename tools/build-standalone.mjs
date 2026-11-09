/* Inlines CSS + JS + icons into one self-contained HTML file.
   Run: node tools/build-standalone.mjs  ->  ../Keyring-standalone.html   */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

let html = read('index.html');

const css = read('assets/css/app.css');
const svgIcon = read('icons/icon.svg').trim();
const svgData = 'data:image/svg+xml;base64,' + Buffer.from(svgIcon).toString('base64');

// --- inline stylesheet ---
// NB: use a function replacement — a plain string would let $$ / $& in the
// source code act as special replacement patterns and corrupt the output.
html = html.replace(
  '<link rel="stylesheet" href="assets/css/app.css">',
  () => '<style>\n' + css + '\n</style>'
);

// --- drop manifest / apple icon links, keep a data-URI favicon ---
html = html.replace('<link rel="manifest" href="manifest.webmanifest">\n', '');
html = html.replace(
  '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">\n',
  ''
);
html = html.replace(
  '<link rel="icon" href="icons/icon.svg" type="image/svg+xml">',
  () => '<link rel="icon" href="' + svgData + '" type="image/svg+xml">'
);

// --- inline scripts, in order ---
const scripts = [
  'assets/js/crypto.js',
  'assets/js/storage.js',
  'assets/js/pwa.js',
  'assets/js/app.js',
];

for (const rel of scripts) {
  const tag = '<script src="' + rel + '" defer></script>';
  if (!html.includes(tag)) throw new Error('script tag not found: ' + rel);
  html = html.replace(tag, '');
}

const bundle =
  '<script>window.KEYRING_STANDALONE = true;</script>\n' +
  scripts.map((rel) => '<script>\n/* ==== ' + rel + ' ==== */\n' + read(rel) + '\n</script>').join('\n');

html = html.replace('</body>', () => bundle + '\n</body>');

const distDir = path.join(ROOT, 'dist');
mkdirSync(distDir, { recursive: true });
const distPath = path.join(distDir, 'Keyring-standalone.html');
writeFileSync(distPath, html, 'utf8');
const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
console.log('wrote dist/Keyring-standalone.html (' + kb + ' KB)');

try {
  writeFileSync(path.join(ROOT, '..', 'Keyring-standalone.html'), html, 'utf8');
  console.log('wrote ../Keyring-standalone.html (' + kb + ' KB)');
} catch {
  // Gracefully ignore EPERM or access restrictions outside workspace
}
