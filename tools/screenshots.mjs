/* Real-browser smoke test + screenshots. Run: node tools/screenshots.mjs */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'shots');
mkdirSync(OUT, { recursive: true });

const BASE = process.env.BASE || 'http://127.0.0.1:8899/';
const MASTER = 'CorrectHorse9!';

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];

const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const page = await ctx.newPage();
page.on('pageerror', (e) => { errors.push('pageerror: ' + e.message); console.log('  !! PAGEERROR:', e.message); console.log((e.stack||'').split('\n').slice(0,5).join('\n')); });
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); else if (m.type() === 'warning') console.log('  warn:', m.text()); });

const shot = async (name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(OUT, name), fullPage: false });
  console.log('  shot: ' + name);
};

console.log('gate');

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('#setup-form:not(.hidden)');
await shot('01-setup.png');

// show the strength meter with a demo value, then switch to the real master password
await page.fill('#setup-password', 'Tr0ubad0ur&3');
await page.fill('#setup-confirm', 'Tr0ubad0ur&3');
await shot('02-setup-strength.png');

await page.fill('#setup-password', MASTER);
await page.fill('#setup-confirm', MASTER);
await page.click('#setup-submit');
await page.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
await shot('03-empty-vault.png');

// seed a realistic set of entries
const seed = [
  { title: 'Gmail', username: 'ananya.rao@gmail.com', password: 'vT7#qLm9!pXr2&wZ', url: 'mail.google.com', category: 'Email', tags: 'personal, mail', favorite: true, notes: 'Recovery codes are in the drawer at home.' },
  { title: 'HDFC Bank', username: 'ananya.rao', password: 'BankPass2024', url: 'hdfcbank.com', category: 'Banking', favorite: true },
  { title: 'GitHub', username: 'ananyarao', password: 'gH!7#kLq2zP9wRt4', url: 'github.com', category: 'Dev', tags: 'work, code' },
  { title: 'Netflix', username: 'family@rao.in', password: 'netflix123', url: 'netflix.com', category: 'Other' },
  { title: 'Amazon', username: 'ananya.rao@gmail.com', password: 'Am@zon#shop77!', url: 'amazon.in', category: 'Shopping', tags: 'personal' },
  { title: 'Office VPN', username: 'a.rao', password: 'Vpn#Access2026!', category: 'Work', notes: 'Token on the company phone.' },
  { title: 'Instagram', username: '@ananya', password: 'Insta!Gram2020', url: 'instagram.com', category: 'Social' },
];
await page.evaluate(async (entries) => {
  for (const e of entries) await window.KeyringStore.addEntry(e);
  window.KeyringApp.refresh();
}, seed);
await page.waitForTimeout(400);
await shot('04-list.png');

console.log('search');
await page.fill('#search', 'bank');
await page.waitForTimeout(300);
await shot('05-search.png');
await page.click('#search-clear');

console.log('detail');
await page.click('.card-main');
await page.waitForTimeout(400);
await shot('06-detail.png');
await page.click('#d-reveal');
await page.waitForTimeout(200);
await shot('07-detail-revealed.png');
await page.click('#sheet [data-close]');
await page.waitForTimeout(350);

console.log('generator');
await page.click('#btn-generator');
await page.waitForTimeout(400);
await shot('08-generator.png');
await page.click('#sheet [data-close]');
await page.waitForTimeout(300);

console.log('entry form');
await page.click('#fab');
await page.waitForTimeout(350);
await page.fill('#f-title', 'Swiggy');
await page.fill('#f-username', 'ananya.rao@gmail.com');
await page.click('#f-generate');
await page.waitForTimeout(350);
await shot('09-generator-in-form.png');
await page.click('#gen-use');
await page.waitForTimeout(350);
await shot('10-entry-form.png');
await page.click('#entry-form [data-close]');
await page.waitForTimeout(300);

console.log('settings');
await page.click('#btn-settings');
await page.waitForTimeout(400);
await shot('11-settings.png');
await page.locator('#sheet').evaluate((el) => { el.scrollTop = el.scrollHeight; });
await shot('12-settings-bottom.png');
await page.click('#set-export');
await page.waitForTimeout(400);
await shot('13-export.png');
await page.click('#sheet [data-close]');
await page.waitForTimeout(300);

console.log('import');
await page.click('#btn-settings');
await page.waitForTimeout(300);
await page.click('#set-import');
await page.waitForTimeout(350);
await shot('14-import.png');
await page.click('#sheet [data-close]');
await page.waitForTimeout(300);

console.log('delete confirm');
await page.click('.card [data-action="delete"]');
await page.waitForTimeout(350);
await shot('15-delete.png');
await page.click('#confirm-delete');
await page.waitForTimeout(500);

console.log('lock screen');
await page.click('#btn-lock');
await page.waitForTimeout(400);
await shot('16-unlock.png');

console.log('bad password');
await page.fill('#unlock-password', 'wrong-password');
await page.click('#unlock-submit');
await page.waitForTimeout(900);
await shot('17-unlock-error.png');

console.log('unlock again');
await page.fill('#unlock-password', MASTER);
await page.click('#unlock-submit');
try {
  await page.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
} catch (err) {
  const diag = await page.evaluate(() => ({
    unlocked: window.KeyringStore.isUnlocked(),
    appClass: document.querySelector('#app').className,
    err: document.querySelector('#unlock-error').textContent,
  }));
  console.log('  DIAG:', JSON.stringify(diag));
  throw err;
}
await page.waitForTimeout(400);
await shot('18-unlocked.png');

// desktop layout — same origin/storage, so reuse the context
const dpage = await ctx.newPage();
await dpage.setViewportSize({ width: 1280, height: 900 });
await dpage.goto(BASE, { waitUntil: 'networkidle' });
await dpage.waitForSelector('#unlock-form:not(.hidden)', { timeout: 10000 });
await dpage.fill('#unlock-password', MASTER);
await dpage.click('#unlock-submit');
await dpage.waitForSelector('#app:not(.hidden)', { timeout: 20000 });
await dpage.waitForTimeout(600);
await dpage.screenshot({ path: path.join(OUT, '19-desktop.png') });
console.log('  shot: 19-desktop.png');
await dpage.close();

const checklist = await page.evaluate(() => ({
  entries: document.querySelectorAll('.card').length,
  hasServiceWorker: 'serviceWorker' in navigator,
  swControlled: !!navigator.serviceWorker.controller,
}));
console.log('\nstate:', JSON.stringify(checklist));

console.log('\nerrors:', errors.length ? errors.join('\n  ') : 'none');
await browser.close();
process.exit(errors.length ? 1 : 0);
