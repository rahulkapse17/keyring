import { readFileSync, existsSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const candidates = [
  process.env.STANDALONE_FILE,
  path.join(ROOT, 'dist', 'Keyring-standalone.html'),
  path.join(ROOT, '..', 'Keyring-standalone.html'),
  path.join(ROOT, 'Keyring-standalone.html'),
  '/home/user/Keyring-standalone.html',
].filter(Boolean);

const targetFile = candidates.find((p) => existsSync(p));
if (!targetFile) {
  console.error('Could not find Keyring-standalone.html. Run `node tools/build-standalone.mjs` first.');
  process.exit(1);
}

const html = readFileSync(targetFile, 'utf8');
const errs = [];
const dom = new JSDOM(html, {
  url: 'https://keyring.test/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(w) {
    Object.defineProperty(w, 'crypto', { value: webcrypto, configurable: true });
    w.TextEncoder = TextEncoder;
    w.TextDecoder = TextDecoder;
    w.matchMedia = () => ({ matches: false, addEventListener(){}, removeEventListener(){} });
    w.Element.prototype.animate = () => ({ finished: Promise.resolve(), cancel(){} });
    w.addEventListener('error', e => errs.push('err: ' + e.message));
  },
});
const { window } = dom;
const d = window.document;
await new Promise(r => setTimeout(r, 300));

const $ = s => d.querySelector(s);
const vis = s => { const e = $(s); return !!e && !e.classList.contains('hidden'); };

console.log('setup form visible:', vis('#setup-form'));
console.log('app hidden:', !vis('#app'));
console.log('standalone flag:', window.KEYRING_STANDALONE);
console.log('scripts inlined:', d.querySelectorAll('script[src]').length === 0);
console.log('css inlined:', d.querySelectorAll('link[rel=stylesheet]').length === 0);
console.log('styles applied:', !!d.querySelector('style'));

$('#setup-password').value = 'CorrectHorse9!';
$('#setup-confirm').value = 'CorrectHorse9!';
$('#setup-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await new Promise(r => setTimeout(r, 1200));
console.log('unlocked after setup:', vis('#app'));

$('#fab').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise(r => setTimeout(r, 150));
console.log('entry form opens:', !!$('#entry-form'));

$('#f-title').value = 'Standalone test';
$('#f-password').value = 'Zx9!mQ2#pL7';
$('#entry-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await new Promise(r => setTimeout(r, 500));
console.log('card rendered:', d.querySelectorAll('.card').length);

// reload persistence check: new JSDOM with same localStorage isn't possible, so check envelope exists
console.log('envelope stored:', !!window.localStorage.getItem('keyring.vault.v1'));
console.log('errors:', errs.length ? errs : 'none');

process.exit(errs.length ? 1 : 0);
