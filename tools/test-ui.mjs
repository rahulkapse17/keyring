/* Drives the real index.html + app.js inside jsdom to catch UI wiring bugs.
   Run: node tools/test-ui.mjs                                                  */
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0, fail = 0;
const errors = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + label); }
  else { fail++; console.log('  \u2717 ' + label + (extra ? '  -> ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, {
  url: 'https://keyring.test/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;
const { document } = window;

/* ---------- browser features jsdom lacks ---------- */
Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
window.TextEncoder = TextEncoder;
window.TextDecoder = TextDecoder;
window.matchMedia = () => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
window.Element.prototype.animate = function () { return { finished: Promise.resolve(), cancel() {}, onfinish: null }; };
Object.defineProperty(window.navigator, 'clipboard', {
  value: { writeText: async () => {} },
  configurable: true,
});
window.URL.createObjectURL = () => 'blob:keyring-test';
window.URL.revokeObjectURL = () => {};

window.addEventListener('error', (e) => errors.push('window error: ' + e.message));
const origError = console.error;
console.error = (...args) => { errors.push('console.error: ' + args.join(' ')); origError(...args); };

/* ---------- load the app the way index.html does ---------- */
for (const rel of ['assets/js/crypto.js', 'assets/js/storage.js', 'assets/js/pwa.js', 'assets/js/app.js']) {
  window.eval(readFileSync(path.join(ROOT, rel), 'utf8'));
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const visible = (sel) => { const el = $(sel); return !!el && !el.classList.contains('hidden'); };

function fill(sel, value) {
  const el = $(sel);
  el.value = value;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  return el;
}
function submit(sel) {
  $(sel).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}
function click(target) {
  const el = typeof target === 'string' ? $(target) : target;
  if (!el) throw new Error('click target missing: ' + target);
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

const MASTER = 'CorrectHorse9!';

async function run() {
  console.log('\nboot');
  await sleep(80);
  ok(visible('#gate'), 'lock screen is shown on first run');
  ok(visible('#setup-form') && !visible('#unlock-form'), 'setup form shown when no vault exists');
  ok(!visible('#app'), 'app shell hidden while locked');

  console.log('\nvault creation');
  fill('#setup-password', 'short');
  fill('#setup-confirm', 'short');
  submit('#setup-form');
  await sleep(60);
  ok(visible('#setup-error'), 'rejects a short master password', $('#setup-error').textContent);

  fill('#setup-password', MASTER);
  fill('#setup-confirm', 'mismatch123!');
  submit('#setup-form');
  await sleep(60);
  ok(/do not match/i.test($('#setup-error').textContent), 'rejects mismatched confirmation');

  fill('#setup-password', MASTER);
  fill('#setup-confirm', MASTER);
  submit('#setup-form');
  await sleep(900);
  ok(visible('#app'), 'app unlocked after creating the vault', $('#setup-error').textContent);
  ok(!visible('#gate'), 'gate hidden after creation');
  ok(visible('#empty'), 'empty state shown for a fresh vault');
  ok(!!window.localStorage.getItem('keyring.vault.v1'), 'encrypted envelope persists');
  ok(!window.localStorage.getItem('keyring.vault.v1').includes(MASTER), 'master password never stored');

  console.log('\nadd entry');
  click('#fab');
  await sleep(120);
  ok(!!$('#entry-form'), 'entry sheet opens');
  fill('#f-title', 'Gmail');
  fill('#f-username', 'me@gmail.com');
  fill('#f-password', 'vT7#qLm9!pXr2&wZ');
  fill('#f-url', 'gmail.com');
  fill('#f-category', 'Email');
  fill('#f-tags', 'personal, mail');
  submit('#entry-form');
  await sleep(400);
  ok(!$('#entry-form'), 'sheet closes after saving');
  ok($$('.card').length === 1, 'one card rendered', String($$('.card').length));
  ok($('.card-title').textContent === 'Gmail', 'card shows the title');
  ok($('.card-user').textContent === 'me@gmail.com', 'card shows the username');
  ok(!!$('.card-pass') && $('.card-pass').textContent.includes('•'), 'password is masked in the list');
  ok(!document.body.innerHTML.includes('vT7#qLm9'), 'plaintext password is not in the DOM');

  console.log('\nsearch + filters');
  const chips = $$('#chips .chip').map((c) => c.textContent.trim());
  ok(chips.some((c) => c.startsWith('All')), 'All chip present', chips.join(' | '));
  ok(chips.some((c) => c.startsWith('Email')), 'category chip appears after adding an entry', chips.join(' | '));

  fill('#search', 'nothing-matches-this');
  await sleep(30);
  ok(visible('#empty') && /matches/i.test($('#empty-title').textContent), 'no-results state for a bad search');
  click('#search-clear');
  await sleep(30);
  ok($$('.card').length === 1, 'clearing search restores the list');

  fill('#search', 'gmail');
  await sleep(30);
  ok($$('.card').length === 1, 'search matches by title');
  fill('#search', 'me@gmail');
  await sleep(30);
  ok($$('.card').length === 1, 'search matches by username');
  fill('#search', '');
  await sleep(30);

  console.log('\ndetail sheet');
  click($('.card-main'));
  await sleep(120);
  ok(!!$('#d-pass'), 'detail opens with a password row');
  ok($('#d-pass').textContent.includes('•'), 'password starts masked');
  click('#d-reveal');
  await sleep(30);
  ok($('#d-pass').textContent === 'vT7#qLm9!pXr2&wZ', 'reveal shows the real password', $('#d-pass').textContent);
  click('#d-reveal');
  await sleep(30);
  ok($('#d-pass').textContent.includes('•'), 'reveal toggles back to masked');

  console.log('\nfavorite');
  click('#d-fav');
  await sleep(250);
  const favChip = $$('#chips .chip').find((c) => c.textContent.includes('Favorites'));
  ok(!!favChip, 'favorites chip appears once an entry is starred');

  console.log('\nedit');
  click('#d-edit');
  await sleep(120);
  ok($('#f-title').value === 'Gmail', 'edit form is prefilled');
  fill('#f-title', 'Gmail Work');
  fill('#f-password', 'AnotherStrong#42pq');
  submit('#entry-form');
  await sleep(450);
  ok($('.card-title').textContent === 'Gmail Work', 'edited title shows in the list', $('.card-title').textContent);
  click($('.card-main'));
  await sleep(120);
  click('#d-reveal');
  await sleep(30);
  ok($('#d-pass').textContent === 'AnotherStrong#42pq', 'edited password persisted');
  click('#sheet [data-close]');
  await sleep(240);

  console.log('\ngenerator');
  click('#btn-generator');
  await sleep(120);
  const first = $('#gen-value').textContent;
  ok(first.length === 20, 'generator default length is 20', String(first.length));
  ok(/[a-z]/.test(first) && /[A-Z]/.test(first) && /\d/.test(first), 'generated value mixes classes', first);
  click('#gen-refresh');
  await sleep(40);
  ok($('#gen-value').textContent !== first, 'refresh produces a new value');
  click('#gen-tab-phrase');
  await sleep(40);
  ok($('#gen-value').textContent.split('-').length >= 4, 'passphrase mode works', $('#gen-value').textContent);
  click('#sheet [data-close]');
  await sleep(220);

  console.log('\nadd from entry form + generator');
  click('#fab');
  await sleep(100);
  fill('#f-title', 'GitHub');
  fill('#f-username', 'octocat');
  click('#f-generate');
  await sleep(120);
  ok(!!$('#gen-value'), 'generator opens from the entry form');
  click('#gen-use');
  await sleep(200);
  ok(!!$('#entry-form'), 'entry form is restored after using a generated password');
  ok($('#f-title').value === 'GitHub', 'draft title preserved', $('#f-title').value);
  ok($('#f-password').value.length >= 8, 'generated password landed in the form');
  submit('#entry-form');
  await sleep(450);
  ok($$('.card').length === 2, 'second entry saved', String($$('.card').length));

  console.log('\nregression: sheet close buttons never submit forms');
  click('#fab');
  await sleep(140);
  fill('#f-title', 'Should Not Save');
  fill('#f-password', 'SomePassword!42');
  click('#entry-form [data-close]');   // header X — used to be a submit button
  await sleep(400);
  ok(!$('#entry-form'), 'header X closes the entry form');
  ok($$('.card').length === 2, 'header X did not save a new entry', String($$('.card').length));
  ok(!document.body.innerHTML.includes('Should Not Save'), 'abandoned draft is not persisted');

  click('#fab');
  await sleep(140);
  fill('#f-title', 'Also Not Saved');
  fill('#f-password', 'AnotherPass!42');
  const cancelBtn = $$('#entry-form [data-close]').find((b) => /cancel/i.test(b.textContent));
  click(cancelBtn);
  await sleep(400);
  ok(!$('#entry-form'), 'Cancel closes the entry form');
  ok($$('.card').length === 2, 'Cancel did not save either', String($$('.card').length));

  console.log('\nregression: stale sheet listeners do not leak');
  click('#fab');
  await sleep(150);
  fill('#f-title', 'Listener Check');
  click('#f-generate');         // generator opened from inside the entry form
  await sleep(200);
  click('#gen-use');            // hands the value back and re-opens the form
  await sleep(320);
  ok(!!$('#entry-form'), 'generator hands off to the entry form');
  fill('#f-username', 'listener@test.dev');
  await sleep(150);
  ok(errors.filter((e) => /null|undefined is not|cannot read/i.test(e)).length === 0,
    'editing after the generator closed throws nothing',
    errors.filter((e) => /cannot read/i.test(e)).join(' ; '));
  const cancel2 = $$('#entry-form [data-close]').find((b) => /cancel/i.test(b.textContent));
  click(cancel2);
  await sleep(300);

  console.log('\nsettings');
  click('#btn-settings');
  await sleep(120);
  ok(!!$('#set-autolock') && !!$('#set-clip') && !!$('#set-export') && !!$('#set-import') && !!$('#set-wipe'),
    'settings sheet exposes all controls');
  ok(/AES-256-GCM/.test($('#sheet').textContent), 'settings shows the encryption in use');
  click('#sheet [data-close]');
  await sleep(220);

  console.log('\nexport sheet');
  click('#btn-settings');
  await sleep(120);
  click('#set-export');
  await sleep(150);
  ok(!!$('#exp-download'), 'export sheet offers a download');
  ok(/keyring-backup-/.test($('#sheet').textContent), 'export shows the filename');
  click('#exp-download');
  await sleep(80);
  click('#sheet [data-close]');
  await sleep(200);

  console.log('\nimport validation');
  click('#btn-settings');
  await sleep(120);
  click('#set-import');
  await sleep(150);
  ok(!!$('#imp-form'), 'import sheet opens');
  fill('#imp-text', '{"nope":true}');
  fill('#imp-pass', 'whatever');
  submit('#imp-form');
  await sleep(200);
  ok(visible('#imp-error'), 'invalid backup text is rejected', $('#imp-error').textContent);
  click('#imp-form [data-close]');
  await sleep(220);

  console.log('\ndelete');
  const delBtn = $$('.card [data-action="delete"]')[0];
  click(delBtn);
  await sleep(120);
  ok(!!$('#confirm-delete'), 'delete asks for confirmation');
  click('#confirm-delete');
  await sleep(450);
  ok($$('.card').length === 1, 'entry deleted', String($$('.card').length));

  console.log('\nlock + unlock');
  click('#btn-lock');
  await sleep(150);
  ok(visible('#gate') && visible('#unlock-form'), 'lock returns to the unlock screen');
  ok(!visible('#app'), 'app hidden while locked');

  fill('#unlock-password', 'definitely-wrong');
  submit('#unlock-form');
  await sleep(700);
  ok(visible('#unlock-error') && /wrong/i.test($('#unlock-error').textContent), 'wrong password message shown', $('#unlock-error').textContent);

  fill('#unlock-password', MASTER);
  submit('#unlock-form');
  await sleep(800);
  ok(visible('#app'), 'correct password unlocks');
  ok($$('.card').length === 1, 'entries restored after unlock');

  console.log('\nsearch + sort + filters');
  click('#sort-btn');
  await sleep(40);
  ok(['A–Z', 'Category', 'Recent'].includes($('#sort-btn').textContent), 'sort cycles', $('#sort-btn').textContent);

  console.log('\nauto-lock helpers');
  ok(typeof window.KeyringApp.lock === 'function', 'KeyringApp api exposed');
  ok(window.KeyringApp.isStandalone() === false, 'standalone detection works in a tab');

  console.log('\nerrors captured during the run');
  const realErrors = errors.filter((e) => !/Not implemented|Could not parse CSS/.test(e));
  ok(realErrors.length === 0, 'no uncaught JS errors', realErrors.join(' ; '));
  if (realErrors.length) realErrors.forEach((e) => console.log('    ! ' + e));

  console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ` — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('\nHARNESS CRASH:', err);
  process.exit(1);
});
