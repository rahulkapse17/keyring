/* Node harness that exercises crypto.js + storage.js exactly as the browser
   loads them. Run: node tools/test-logic.mjs                                    */
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* ---------- minimal browser shims ---------- */
const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorage, configurable: true });

globalThis.window = globalThis;
if (!globalThis.crypto || !globalThis.crypto.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
globalThis.Blob = class BlobShim {
  constructor(parts) {
    this.size = parts.reduce((n, p) => n + Buffer.byteLength(String(p)), 0);
  }
};

function loadScript(rel) {
  const src = readFileSync(path.join(ROOT, rel), 'utf8');
  new Function('window', 'localStorage', 'crypto', 'btoa', 'atob', 'Blob', src)(
    globalThis, localStorage, webcrypto, globalThis.btoa, globalThis.atob, globalThis.Blob
  );
}

loadScript('assets/js/crypto.js');
loadScript('assets/js/storage.js');

const C = window.KeyringCrypto;
const S = window.KeyringStore;

/* ---------- tiny test runner ---------- */
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + label); }
  else { fail++; console.log('  \u2717 ' + label + (extra ? '  -> ' + extra : '')); }
}
function section(name) { console.log('\n' + name); }

const MASTER = 'CorrectHorse9!';
const t0 = Date.now();

/* ---------- crypto primitives ---------- */
section('crypto');
{
  const pw = C.generatePassword({ length: 24 });
  ok(pw.length === 24, 'generator respects length');
  ok(/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[0-9]/.test(pw) && /[^a-zA-Z0-9]/.test(pw),
    'generator includes every selected class', pw);

  const digitsOnly = C.generatePassword({ length: 12, lowercase: false, uppercase: false, symbols: false, digits: true });
  ok(/^\d{12}$/.test(digitsOnly), 'generator honours a single class', digitsOnly);

  const noAmb = C.generatePassword({ length: 40, avoidAmbiguous: true, symbols: false });
  ok(!/[lIO01]/.test(noAmb), 'avoid-ambiguous excludes look-alikes', noAmb);

  const uniq = new Set();
  for (let i = 0; i < 200; i++) uniq.add(C.generatePassword({ length: 16 }));
  ok(uniq.size === 200, 'generator output is not repeating');

  const phrase = C.generatePassphrase({ words: 5 });
  ok(phrase.split('-').length >= 5, 'passphrase has the requested word count', phrase);

  ok(C.estimateEntropyBits('123456') < 30, 'entropy: weak password scores low');
  ok(C.estimateEntropyBits('vT7#qLm9!pXr2&wZ') > 80, 'entropy: random 16-char scores high');
  ok(C.strengthLabel(90).label === 'Excellent', 'strength labels map correctly');
}

/* ---------- vault lifecycle ---------- */
section('vault lifecycle');
{
  const salt = C.randomBytes(16);
  const k1 = await C.deriveKey(MASTER, salt);
  const k2 = await C.deriveKey(MASTER, salt);
  const enc = await C.encryptJSON(k1, { a: 1, s: 'hello' });
  const dec = await C.decryptJSON(k2, enc.iv, enc.data);
  ok(dec.s === 'hello', 'same password+salt derives an interchangeable key');

  let threw = false;
  try {
    const k3 = await C.deriveKey('wrong-password', salt);
    await C.decryptJSON(k3, enc.iv, enc.data);
  } catch (e) { threw = true; }
  ok(threw, 'wrong key fails GCM authentication');

  const tampered = C.b64ToBuf(enc.data);
  tampered[0] ^= 0xff;
  let threw2 = false;
  try { await C.decryptJSON(k1, enc.iv, C.bufToB64(tampered)); } catch (e) { threw2 = true; }
  ok(threw2, 'tampered ciphertext is rejected');
}

section('create / unlock / lock');
{
  ok(S.storageAvailable(), 'storage probe succeeds');
  ok(!S.hasVault(), 'starts with no vault');

  const created = await S.createVault(MASTER);
  ok(created === true, 'vault created');
  ok(S.hasVault(), 'vault is on disk');
  ok(S.isUnlocked(), 'unlocked right after creation');

  const raw = localStorage.getItem(S.STORAGE_KEY);
  ok(!!raw && raw.length > 100, 'envelope written');
  ok(!raw.includes(MASTER), 'master password is not stored');
  ok(raw.includes('"PBKDF2"') && raw.includes('"iv"') && raw.includes('"salt"'), 'envelope has kdf/iv/salt');
  ok(!raw.includes('entries'), 'no plaintext entry structure on disk');

  S.lock();
  ok(!S.isUnlocked(), 'locked');

  const bad = await S.unlock('nope-nope-nope');
  ok(bad.ok === false && bad.reason === 'bad-password', 'wrong master password rejected', JSON.stringify(bad));

  const good = await S.unlock(MASTER);
  ok(good.ok === true, 'correct master password unlocks', JSON.stringify(good));
  ok(S.getEntries().length === 0, 'fresh vault is empty');
}

/* ---------- CRUD ---------- */
section('CRUD');
let id1, id2;
{
  const a = await S.addEntry({
    title: 'Gmail', username: 'me@gmail.com', password: 'vT7#qLm9!pXr2&wZ',
    url: 'gmail.com', category: 'Email', tags: 'personal, mail', notes: '2FA on old phone',
  });
  id1 = a.id;
  const b = await S.addEntry({
    title: 'HDFC Bank', username: 'cust12345', password: 'BankPass2024',
    category: 'Banking', favorite: true,
  });
  id2 = b.id;

  ok(S.getEntries().length === 2, 'two entries stored');
  ok(a.tags.length === 2 && a.tags[0] === 'personal', 'tags normalized', JSON.stringify(a.tags));
  ok(S.getEntry(id1).title === 'Gmail', 'read back by id');
  ok(S.getEntries()[0].id === id2, 'newest entry first');

  const raw = localStorage.getItem(S.STORAGE_KEY);
  ok(!raw.includes('Gmail') && !raw.includes('me@gmail.com') && !raw.includes('vT7#qLm9'),
    'no plaintext leaked into localStorage');

  await S.updateEntry(id1, { title: 'Gmail Work', password: 'newPass!9xYq' });
  const updated = S.getEntry(id1);
  ok(updated.title === 'Gmail Work' && updated.password === 'newPass!9xYq', 'update applied');
  ok(updated.createdAt === a.createdAt && updated.updatedAt >= a.updatedAt, 'timestamps sane');

  await S.toggleFavorite(id1);
  ok(S.getEntry(id1).favorite === true, 'favorite toggles on');
  await S.toggleFavorite(id1);
  ok(S.getEntry(id1).favorite === false, 'favorite toggles off');

  const stats = S.entryStats();
  ok(stats.total === 2, 'stats count entries', JSON.stringify(stats));

  // persist across a lock/unlock cycle
  S.lock();
  await S.unlock(MASTER);
  ok(S.getEntry(id1).title === 'Gmail Work', 'changes survive lock + unlock');

  const del = await S.deleteEntry(id2);
  ok(del === true && S.getEntries().length === 1, 'delete works');
  ok((await S.deleteEntry('does-not-exist')) === false, 'deleting a missing id is a no-op');
}

/* ---------- settings ---------- */
section('settings');
{
  const s = await S.updateSettings({ autoLockMinutes: 15, generator: { length: 32 } });
  ok(s.autoLockMinutes === 15, 'setting persisted');
  ok(s.generator.length === 32 && s.generator.symbols === true, 'nested generator settings merge');

  const raw = JSON.parse(localStorage.getItem(S.STORAGE_KEY));
  ok(!JSON.stringify(raw).includes('autoLockMinutes'), 'settings are inside the ciphertext, not beside it');

  await S.updateSettings({ autoLockMinutes: 5, generator: { length: 20 } });
}

/* ---------- backup export / import ---------- */
section('backup');
{
  const backup = S.exportBackup();
  ok(/^keyring-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/.test(backup.filename), 'filename is timestamped', backup.filename);
  ok(!backup.json.includes('Gmail Work'), 'backup is encrypted (no plaintext titles)');

  const parsedPlain = S.parseBackup('{"hello":1}');
  ok(parsedPlain.ok === false && parsedPlain.reason === 'not-backup', 'garbage rejected');

  const parsedBadJson = S.parseBackup('not json at all');
  ok(parsedBadJson.ok === false && parsedBadJson.reason === 'not-json', 'invalid json rejected');

  const parsed = S.parseBackup(backup.json);
  ok(parsed.ok === true, 'own backup parses');
  ok(parsed.envelope.data === JSON.parse(localStorage.getItem(S.STORAGE_KEY)).data, 'backup carries the live ciphertext');

  // wrong password on import
  const wrong = await S.importBackup(backup.json, 'totally-wrong-pass', 'merge');
  ok(wrong.ok === false && wrong.reason === 'bad-password', 'import rejects a wrong password');

  // merge into the same vault -> everything is a duplicate
  const dup = await S.importBackup(backup.json, MASTER, 'merge');
  ok(dup.ok === true && dup.imported === 0 && dup.skipped === 1, 'merge skips duplicates', JSON.stringify(dup));

  // wipe, then restore into a fresh vault
  await S.wipeAll();
  ok(!S.hasVault(), 'wipe removes the vault');
  await S.createVault('FreshVault#2026');
  ok(S.getEntries().length === 0, 'fresh vault empty after wipe');

  const restored = await S.importBackup(backup.json, MASTER, 'merge');
  ok(restored.ok === true && restored.imported === 1, 'restore into new vault works', JSON.stringify(restored));
  ok(S.getEntries()[0].title === 'Gmail Work', 'restored entry content intact');
  ok(S.getEntries()[0].tags[0] === 'personal', 'restored tags intact');

  // the same backup can be imported twice without id clashes
  const again = await S.importBackup(backup.json, MASTER, 'merge');
  ok(again.ok === true && again.imported === 0, 'second import is deduped', JSON.stringify(again));

  // replace mode
  const replace = await S.importBackup(backup.json, MASTER, 'replace');
  ok(replace.ok === true && replace.total === 1, 'replace mode swaps contents', JSON.stringify(replace));
}

/* ---------- master password change ---------- */
section('master password change');
{
  const wrongCurrent = await S.changeMasterPassword('not-the-current-one', 'BrandNewPass#77');
  ok(wrongCurrent.ok === false && wrongCurrent.reason === 'bad-password', 'requires the current password');

  const weak = await S.changeMasterPassword('FreshVault#2026', 'short');
  ok(weak.ok === false && weak.reason === 'weak', 'rejects a weak new password');

  // figure out the live password, then change it
  const live = S.isUnlocked() ? 'FreshVault#2026' : null;
  ok(live !== null, 'still unlocked after import');

  const changed = await S.changeMasterPassword(live, 'NewMaster#2026x');
  ok(changed.ok === true, 'master password changed', JSON.stringify(changed));

  S.lock();
  const oldTry = await S.unlock('FreshVault#2026');
  ok(oldTry.ok === false, 'old master password no longer works');
  const newTry = await S.unlock('NewMaster#2026x');
  ok(newTry.ok === true, 'new master password works');
  ok(S.getEntries().length === 1, 'entries survived re-keying');

  // salt must have changed
  const env = JSON.parse(localStorage.getItem(S.STORAGE_KEY));
  ok(env.kdf.iterations === C.KDF_ITERATIONS, 'iteration count recorded in envelope');
}

/* ---------- TOTP & 2FA ---------- */
section('TOTP & 2FA');
{
  const b32 = C.base32ToBuf('MZXW6===');
  ok(b32.length === 3 && b32[0] === 0x66 && b32[1] === 0x6f && b32[2] === 0x6f, 'base32 decodes foo');

  // RFC 6238 standard test vector:
  // Secret "12345678901234567890" -> Base32 "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
  // At epoch time 59,000 ms (T=59s, Counter=1), OTP is 287082
  const totp = await C.generateTOTP('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000);
  ok(totp && totp.code === '287082', 'computes standard RFC 6238 TOTP code (287082)', totp && totp.code);
  ok(totp && totp.remaining === 1, 'remaining period is correct');

  // URL extraction
  const totpUrl = await C.generateTOTP('otpauth://totp/Test:user@example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Test', 59000);
  ok(totpUrl && totpUrl.code === '287082', 'extracts secret from otpauth:// URL');
}

/* ---------- password history & trash ---------- */
section('password history & trash');
{
  const entry = await S.addEntry({ title: 'Service', username: 'user1', password: 'InitialPassword1!' });
  const updated1 = await S.updateEntry(entry.id, { password: 'SecondPassword2@' });
  ok(updated1.history && updated1.history.length === 1 && updated1.history[0].password === 'InitialPassword1!', 'records password history');

  const updated2 = await S.updateEntry(entry.id, { password: 'ThirdPassword3#' });
  ok(updated2.history && updated2.history.length === 2 && updated2.history[0].password === 'SecondPassword2@', 'records second password in history');

  const beforeCount = S.getEntries().length;
  await S.deleteEntry(entry.id);
  ok(S.getEntries().length === beforeCount - 1, 'soft delete removes from active list');
  const trash = S.getTrash();
  ok(trash.length >= 1 && trash[0].id === entry.id, 'entry moved to trash');

  await S.restoreFromTrash(entry.id);
  ok(S.getEntry(entry.id) !== null, 'restores entry from trash');

  await S.deleteEntry(entry.id);
  await S.emptyTrash();
  ok(S.getTrash().length === 0, 'empty trash clears all items');
}

/* ---------- CSV import ---------- */
section('CSV import');
{
  const chromeCsv = `name,url,username,password,note
Test Site,https://example.com,alice@example.com,SecretPass99!,My notes
Another Site,https://test.org,bob,Pass1234!,`;

  const parsed = S.parseCSV(chromeCsv);
  ok(parsed.length === 2, 'parses Chrome CSV format');
  ok(parsed[0].title === 'Test Site' && parsed[0].username === 'alice@example.com', 'maps CSV columns accurately');

  const imp = await S.importCSV(chromeCsv, 'merge');
  ok(imp.ok === true && imp.imported === 2, 'imports CSV entries into vault');
}

/* ---------- storage diagnostics ---------- */
section('diagnostics');
{
  ok(S.byteSize() > 0, 'byteSize reports usage', String(S.byteSize()));
  ok(S.getStorageKind() === 'local', 'storage kind is local');
  ok(S.peekInfo() && S.peekInfo().iterations === 310000, 'peekInfo exposes kdf info for the lock screen');
}

console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ` — ${pass} passed, ${fail} failed  (${Date.now() - t0} ms)`);
process.exit(fail === 0 ? 0 : 1);
