/* ============================================================
   Keyring — storage layer
   Owns the encrypted envelope in localStorage, the in-memory
   decrypted vault while unlocked, settings, and backups.

   Design notes
   ------------
   * Nothing sensitive is ever written unencrypted. The only
     localStorage key holds {v, kdf, salt, iv, data}.
   * Settings live *inside* the encrypted payload, so they can't
     be used to fingerprint the vault before unlocking.
   * The AES key lives only in this closure's memory and is
     dropped on lock(). It is non-extractable, so it cannot be
     read back out of the CryptoKey object.
   ============================================================ */

const KeyringStore = (() => {
  'use strict';

  const STORAGE_KEY = 'keyring.vault.v1';
  const APP_ID = 'keyring-password-vault';
  const C = window.KeyringCrypto;

  const DEFAULT_SETTINGS = {
    autoLockMinutes: 5,
    clipboardClearSeconds: 30,
    sortMode: 'recent',          // recent | az | category
    generator: {
      length: 20,
      lowercase: true,
      uppercase: true,
      digits: true,
      symbols: true,
      avoidAmbiguous: false,
      mode: 'password',          // password | passphrase
      words: 4,
    },
    installBannerDismissed: false,
  };

  const CATEGORIES = [
    'General', 'Email', 'Banking', 'Social', 'Work', 'Shopping', 'Dev', 'Other',
  ];

  /* -------------------- runtime state -------------------- */
  let unlockSeq = 0;           // guards against overlapping unlock attempts
  let key = null;              // CryptoKey while unlocked
  let envelope = null;         // raw envelope object as stored
  let vault = null;            // decrypted { entries, settings, ... }
  let storageKind = 'checking';

  /* -------------------- storage backend --------------------
     Prefer localStorage. Some contexts (sandboxed iframes, hard
     private-mode lockdowns) block it — in that case fall back to
     memory so the app is still demo-able, and report the mode so
     the UI can warn that nothing will be saved.
     ---------------------------------------------------------- */
  const memoryBackend = (function () {
    const map = new Map();
    return {
      getItem: function (k) { return map.has(k) ? map.get(k) : null; },
      setItem: function (k, v) { map.set(k, String(v)); },
      removeItem: function (k) { map.delete(k); },
      keys: function () { return Array.from(map.keys()); },
    };
  })();

  let backend = null;

  function probeStorage() {
    // Secure context is required for WebCrypto; check it first
    if (!(window.crypto && window.crypto.subtle)) {
      storageKind = 'no-crypto';
      backend = memoryBackend;
      return false;
    }

    try {
      const t = '__keyring_probe__';
      localStorage.setItem(t, '1');
      localStorage.removeItem(t);
      backend = localStorage;
      storageKind = 'local';
      return true;
    } catch (err) {
      backend = memoryBackend;
      storageKind = 'memory';
      return false;
    }
  }

  function storageAvailable() {
    if (storageKind === 'checking') probeStorage();
    return storageKind === 'local' || storageKind === 'memory';
  }

  function getStorageKind() {
    if (storageKind === 'checking') probeStorage();
    return storageKind;
  }

  function isPersistent() {
    return getStorageKind() === 'local';
  }

  /* -------------------- envelope io -------------------- */
  function readEnvelope() {
    try {
      ensureBackend();
      const raw = backend.getItem(STORAGE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object' || !obj.data || !obj.salt || !obj.iv) return null;
      return obj;
    } catch (err) {
      console.error('[keyring] failed to read envelope', err);
      return null;
    }
  }

  function writeEnvelope(obj) {
    ensureBackend();
    backend.setItem(STORAGE_KEY, JSON.stringify(obj));
    envelope = obj;
  }

  function ensureBackend() {
    if (!backend) probeStorage();
  }

  function hasVault() {
    if (!storageAvailable()) return false;
    return readEnvelope() !== null;
  }

  function isUnlocked() {
    return key !== null && vault !== null;
  }

  function peekInfo() {
    const env = envelope || readEnvelope();
    if (!env) return null;
    return {
      version: env.v || 1,
      createdAt: env.createdAt || null,
      iterations: env.kdf ? env.kdf.iterations : C.KDF_ITERATIONS,
    };
  }

  /* -------------------- normalization -------------------- */
  function str(v) {
    if (v === null || v === undefined) return '';
    return String(v);
  }

  function normalizeTags(input) {
    if (Array.isArray(input)) {
      return [...new Set(input.map((t) => str(t).trim().toLowerCase()).filter(Boolean))].slice(0, 12);
    }
    return [...new Set(str(input).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 12);
  }

  function normalizeEntry(e) {
    const now = Date.now();
    return {
      id: str(e.id) || C.uid(),
      title: str(e.title).trim() || 'Untitled',
      username: str(e.username),
      password: str(e.password),
      url: str(e.url).trim(),
      notes: str(e.notes),
      category: CATEGORIES.includes(e.category) ? e.category : 'Other',
      tags: normalizeTags(e.tags),
      favorite: !!e.favorite,
      totp: str(e.totp).trim(),
      history: Array.isArray(e.history) ? e.history.slice(0, 5) : [],
      deletedAt: e.deletedAt ? Number(e.deletedAt) : null,
      createdAt: Number(e.createdAt) || now,
      updatedAt: Number(e.updatedAt) || now,
    };
  }

  function emptyVault() {
    return {
      entries: [],
      trash: [],
      settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
      createdAt: Date.now(),
      vaultId: C.uid(),
    };
  }

  /* -------------------- persistence -------------------- */
  async function persist() {
    if (!isUnlocked()) throw new Error('Vault is locked');
    const { iv, data } = await C.encryptJSON(key, vault);
    writeEnvelope({
      v: 1,
      app: APP_ID,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: C.KDF_ITERATIONS },
      salt: envelope.salt,
      iv,
      data,
      updatedAt: Date.now(),
    });
  }

  /* -------------------- lifecycle -------------------- */
  async function createVault(masterPassword) {
    ensureBackend();
    if (storageKind === 'no-crypto') {
      throw new Error('This page is not a secure context, so encryption is unavailable. Open it over https (or the installed app).');
    }
    if (!storageAvailable()) throw new Error('This browser is blocking local storage.');
    if (hasVault()) throw new Error('A vault already exists on this device.');
    if (!masterPassword || masterPassword.length < 8) {
      throw new Error('Master password must be at least 8 characters.');
    }

    const saltBytes = C.randomBytes(C.SALT_BYTES);
    key = await C.deriveKey(masterPassword, saltBytes);
    vault = emptyVault();

    const { iv, data } = await C.encryptJSON(key, vault);
    writeEnvelope({
      v: 1,
      app: APP_ID,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: C.KDF_ITERATIONS },
      salt: C.bufToB64(saltBytes),
      iv,
      data,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return true;
  }

  async function unlock(masterPassword) {
    if (!storageAvailable()) return { ok: false, reason: 'storage' };
    const env = readEnvelope();
    if (!env) return { ok: false, reason: 'no-vault' };

    const seq = ++unlockSeq;

    try {
      const saltBytes = C.b64ToBuf(env.salt);
      const iterations = (env.kdf && env.kdf.iterations) || C.KDF_ITERATIONS;
      const derived = await C.deriveKey(masterPassword, saltBytes, iterations);
      const payload = await C.decryptJSON(derived, env.iv, env.data);

      if (!payload || !Array.isArray(payload.entries)) {
        return { ok: false, reason: 'corrupt' };
      }

      // A newer attempt started while we were deriving — let that one win
      if (seq !== unlockSeq) return { ok: false, reason: 'superseded' };

      key = derived;
      envelope = env;
      vault = {
        entries: payload.entries.map(normalizeEntry),
        trash: Array.isArray(payload.trash) ? payload.trash.map(normalizeEntry) : [],
        settings: Object.assign({}, DEFAULT_SETTINGS, payload.settings || {}, {
          generator: Object.assign({}, DEFAULT_SETTINGS.generator, (payload.settings || {}).generator || {}),
        }),
        createdAt: payload.createdAt || env.createdAt || Date.now(),
        vaultId: payload.vaultId || C.uid(),
      };

      return { ok: true, entries: vault.entries.length };
    } catch (err) {
      // GCM auth failure means wrong password (or tampering / corruption).
      // Do not clobber a vault that a newer attempt successfully opened.
      if (window.KeyringDebug) console.warn('[keyring] unlock failed:', err && err.name, err && err.message);
      if (seq === unlockSeq) {
        key = null;
        vault = null;
      }
      return { ok: false, reason: 'bad-password' };
    }
  }

  function lock() {
    key = null;
    vault = null;
  }

  /* -------------------- entries -------------------- */
  function getEntries() {
    return isUnlocked() ? vault.entries.slice() : [];
  }

  function getEntry(id) {
    if (!isUnlocked()) return null;
    const found = vault.entries.find((e) => e.id === id);
    return found ? Object.assign({}, found) : null;
  }

  async function addEntry(data) {
    if (!isUnlocked()) throw new Error('Vault is locked');
    const entry = normalizeEntry(Object.assign({}, data, {
      id: C.uid(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
    vault.entries.unshift(entry);
    await persist();
    return Object.assign({}, entry);
  }

  async function updateEntry(id, patch) {
    if (!isUnlocked()) throw new Error('Vault is locked');
    const idx = vault.entries.findIndex((e) => e.id === id);
    if (idx === -1) throw new Error('Entry not found');
    const existing = vault.entries[idx];
    const history = Array.isArray(existing.history) ? existing.history.slice() : [];
    if (patch.password !== undefined && patch.password !== existing.password && existing.password) {
      history.unshift({
        password: existing.password,
        changedAt: Date.now(),
      });
    }
    const merged = normalizeEntry(Object.assign({}, existing, patch, {
      id: existing.id,
      history: history.slice(0, 5),
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    }));
    vault.entries[idx] = merged;
    await persist();
    return Object.assign({}, merged);
  }

  async function deleteEntry(id, permanent = false) {
    if (!isUnlocked()) throw new Error('Vault is locked');
    const idx = vault.entries.findIndex((e) => e.id === id);
    if (idx === -1) {
      if (permanent && Array.isArray(vault.trash)) {
        const tIdx = vault.trash.findIndex((e) => e.id === id);
        if (tIdx !== -1) {
          vault.trash.splice(tIdx, 1);
          await persist();
          return true;
        }
      }
      return false;
    }
    const [removed] = vault.entries.splice(idx, 1);
    if (!permanent) {
      if (!Array.isArray(vault.trash)) vault.trash = [];
      vault.trash.unshift(Object.assign({}, removed, { deletedAt: Date.now() }));
    }
    await persist();
    return true;
  }

  function getTrash() {
    if (!isUnlocked()) return [];
    return Array.isArray(vault.trash) ? vault.trash.slice() : [];
  }

  async function restoreFromTrash(id) {
    if (!isUnlocked()) throw new Error('Vault is locked');
    if (!Array.isArray(vault.trash)) return false;
    const idx = vault.trash.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    const [entry] = vault.trash.splice(idx, 1);
    delete entry.deletedAt;
    vault.entries.unshift(normalizeEntry(entry));
    await persist();
    return true;
  }

  async function emptyTrash() {
    if (!isUnlocked()) throw new Error('Vault is locked');
    vault.trash = [];
    await persist();
    return true;
  }

  async function toggleFavorite(id) {
    const entry = getEntry(id);
    if (!entry) return null;
    return updateEntry(id, { favorite: !entry.favorite });
  }

  /* -------------------- settings -------------------- */
  function getSettings() {
    if (!isUnlocked()) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    return JSON.parse(JSON.stringify(vault.settings));
  }

  async function updateSettings(patch) {
    if (!isUnlocked()) throw new Error('Vault is locked');
    vault.settings = Object.assign({}, vault.settings, patch, {
      generator: Object.assign({}, vault.settings.generator, patch.generator || {}),
    });
    await persist();
    return getSettings();
  }

  /* -------------------- master password change -------------------- */
  async function changeMasterPassword(currentPassword, newPassword) {
    if (!isUnlocked()) return { ok: false, reason: 'locked' };
    if (!newPassword || newPassword.length < 8) {
      return { ok: false, reason: 'weak' };
    }

    // Verify the current password against the stored envelope first
    const env = readEnvelope();
    if (!env) return { ok: false, reason: 'no-vault' };
    try {
      const oldKey = await C.deriveKey(currentPassword, C.b64ToBuf(env.salt), (env.kdf && env.kdf.iterations) || C.KDF_ITERATIONS);
      await C.decryptJSON(oldKey, env.iv, env.data);
    } catch (err) {
      return { ok: false, reason: 'bad-password' };
    }

    const saltBytes = C.randomBytes(C.SALT_BYTES);
    const newKey = await C.deriveKey(newPassword, saltBytes);
    key = newKey;
    envelope = { salt: C.bufToB64(saltBytes) };
    const { iv, data } = await C.encryptJSON(key, vault);
    writeEnvelope({
      v: 1,
      app: APP_ID,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: C.KDF_ITERATIONS },
      salt: envelope.salt,
      iv,
      data,
      createdAt: vault.createdAt,
      updatedAt: Date.now(),
    });
    return { ok: true };
  }

  /* -------------------- backup: export -------------------- */
  function exportBackup() {
    if (!isUnlocked()) throw new Error('Vault is locked');
    const env = readEnvelope();
    const backup = {
      format: 'keyring-backup',
      formatVersion: 1,
      app: 'Keyring Password Vault',
      exportedAt: new Date().toISOString(),
      entries: vault.entries.length,
      envelope: {
        v: env.v,
        kdf: env.kdf,
        salt: env.salt,
        iv: env.iv,
        data: env.data,
      },
    };
    const d = new Date();
    const stamp = [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    ].join('-') + '-' + [
      String(d.getHours()).padStart(2, '0'),
      String(d.getMinutes()).padStart(2, '0'),
    ].join('');

    return {
      filename: `keyring-backup-${stamp}.json`,
      json: JSON.stringify(backup, null, 2),
      entryCount: vault.entries.length,
    };
  }

  /* -------------------- backup: import -------------------- */
  function parseBackup(jsonText) {
    let obj;
    try {
      obj = JSON.parse(jsonText);
    } catch (err) {
      return { ok: false, reason: 'not-json' };
    }

    // Accept either a full backup wrapper or a bare envelope
    let env = null;
    if (obj && obj.format === 'keyring-backup' && obj.envelope) env = obj.envelope;
    else if (obj && obj.data && obj.salt && obj.iv) env = obj;

    if (!env || !env.data || !env.salt || !env.iv) {
      return { ok: false, reason: 'not-backup' };
    }
    if (env.v && env.v > 1) {
      return { ok: false, reason: 'version' };
    }
    return { ok: true, envelope: env, exportedAt: obj.exportedAt || null };
  }

  async function decryptBackupEnvelope(env, password) {
    const saltBytes = C.b64ToBuf(env.salt);
    const iterations = (env.kdf && env.kdf.iterations) || C.KDF_ITERATIONS;
    const derived = await C.deriveKey(password, saltBytes, iterations);
    const payload = await C.decryptJSON(derived, env.iv, env.data);
    if (!payload || !Array.isArray(payload.entries)) throw new Error('Malformed backup payload');
    return payload;
  }

  /**
   * Import entries from a backup.
   * mode: 'merge' keeps existing entries and adds new ones,
   *       'replace' overwrites the current vault entirely.
   */
  async function importBackup(jsonText, password, mode = 'merge') {
    if (!isUnlocked()) return { ok: false, reason: 'locked' };

    const parsed = parseBackup(jsonText);
    if (!parsed.ok) return parsed;

    let payload;
    try {
      payload = await decryptBackupEnvelope(parsed.envelope, password);
    } catch (err) {
      return { ok: false, reason: 'bad-password' };
    }

    const incoming = payload.entries.map(normalizeEntry);
    let imported = 0;
    let skipped = 0;

    if (mode === 'replace') {
      vault.entries = incoming;
      imported = incoming.length;
      if (payload.settings) {
        vault.settings = Object.assign({}, DEFAULT_SETTINGS, payload.settings, {
          generator: Object.assign({}, DEFAULT_SETTINGS.generator, (payload.settings || {}).generator || {}),
        });
      }
    } else {
      const existingIds = new Set(vault.entries.map((e) => e.id));
      const existingSigs = new Set(
        vault.entries.map((e) => `${e.title}\u0000${e.username}\u0000${e.password}`)
      );
      const toAdd = [];
      for (const e of incoming) {
        const sig = `${e.title}\u0000${e.username}\u0000${e.password}`;
        if (existingIds.has(e.id) || existingSigs.has(sig)) {
          skipped++;
          continue;
        }
        // Fresh id so the same backup can be imported twice without clashing
        toAdd.push(Object.assign({}, e, { id: C.uid() }));
        existingSigs.add(sig);
      }
      vault.entries = toAdd.concat(vault.entries);
      imported = toAdd.length;
    }

    await persist();
    return { ok: true, imported, skipped, total: vault.entries.length, mode };
  }

  /* -------------------- CSV import -------------------- */
  function parseCSV(text) {
    const rows = [];
    let currentRow = [];
    let currentCell = '';
    let insideQuotes = false;
    const str = String(text || '');

    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      const nextChar = str[i + 1];

      if (insideQuotes) {
        if (char === '"') {
          if (nextChar === '"') {
            currentCell += '"';
            i++;
          } else {
            insideQuotes = false;
          }
        } else {
          currentCell += char;
        }
      } else {
        if (char === '"') {
          insideQuotes = true;
        } else if (char === ',') {
          currentRow.push(currentCell.trim());
          currentCell = '';
        } else if (char === '\r') {
          // ignore CR
        } else if (char === '\n') {
          currentRow.push(currentCell.trim());
          if (currentRow.length > 0 && currentRow.some((c) => c !== '')) {
            rows.push(currentRow);
          }
          currentRow = [];
          currentCell = '';
        } else {
          currentCell += char;
        }
      }
    }

    if (currentCell.length > 0 || currentRow.length > 0) {
      currentRow.push(currentCell.trim());
      if (currentRow.some((c) => c !== '')) {
        rows.push(currentRow);
      }
    }

    if (rows.length < 2) return [];

    const headers = rows[0].map((h) => h.toLowerCase().replace(/[\s_-]+/g, ''));
    const getIdx = (candidates) => headers.findIndex((h) => candidates.includes(h));
    const titleIdx = getIdx(['title', 'name', 'account', 'loginname']);
    const userIdx = getIdx(['username', 'loginusername', 'user', 'email', 'login']);
    const passIdx = getIdx(['password', 'loginpassword', 'pass']);
    const urlIdx = getIdx(['url', 'loginuri', 'uri', 'website', 'web', 'link']);
    const notesIdx = getIdx(['notes', 'note', 'comments', 'comment', 'extra']);
    const catIdx = getIdx(['category', 'folder']);
    const totpIdx = getIdx(['totp', 'logintotp']);
    const favIdx = getIdx(['favorite', 'fav']);

    const entries = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const title = titleIdx !== -1 ? row[titleIdx] : '';
      const user = userIdx !== -1 ? row[userIdx] : '';
      const pass = passIdx !== -1 ? row[passIdx] : '';
      const url = urlIdx !== -1 ? row[urlIdx] : '';
      const notes = notesIdx !== -1 ? row[notesIdx] : '';
      const cat = catIdx !== -1 ? row[catIdx] : '';
      const totp = totpIdx !== -1 ? row[totpIdx] : '';
      const fav = favIdx !== -1 ? ['true', '1', 'yes'].includes((row[favIdx] || '').toLowerCase()) : false;

      if (!title && !user && !pass) continue;

      entries.push({
        title: title || 'Imported Entry',
        username: user || '',
        password: pass || '',
        url: url || '',
        notes: notes || '',
        category: CATEGORIES.includes(cat) ? cat : 'General',
        totp: totp || '',
        favorite: fav,
      });
    }

    return entries;
  }

  async function importCSV(csvText, mode = 'merge') {
    if (!isUnlocked()) return { ok: false, reason: 'locked' };
    const incoming = parseCSV(csvText);
    if (!incoming || incoming.length === 0) {
      return { ok: false, reason: 'empty-or-invalid' };
    }

    const normalized = incoming.map(normalizeEntry);
    let imported = 0;
    let skipped = 0;

    if (mode === 'replace') {
      vault.entries = normalized;
      imported = normalized.length;
    } else {
      const existingSigs = new Set(
        vault.entries.map((e) => `${e.title}\u0000${e.username}\u0000${e.password}`)
      );
      const toAdd = [];
      for (const e of normalized) {
        const sig = `${e.title}\u0000${e.username}\u0000${e.password}`;
        if (existingSigs.has(sig)) {
          skipped++;
          continue;
        }
        toAdd.push(Object.assign({}, e, { id: C.uid() }));
        existingSigs.add(sig);
      }
      vault.entries = toAdd.concat(vault.entries);
      imported = toAdd.length;
    }

    await persist();
    return { ok: true, imported, skipped, total: vault.entries.length, mode };
  }

  /* -------------------- danger zone -------------------- */
  async function wipeAll() {
    key = null;
    vault = null;
    envelope = null;
    ensureBackend();
    try { backend.removeItem(STORAGE_KEY); } catch (err) { /* ignore */ }
    // Best-effort cleanup of any stale keys from older builds
    try {
      backend.keys()
        .filter((k) => k.startsWith('keyring.') && k !== STORAGE_KEY)
        .forEach((k) => backend.removeItem(k));
    } catch (err) { /* ignore */ }
  }

  /* -------------------- diagnostics -------------------- */
  function byteSize() {
    try {
      ensureBackend();
      const raw = backend.getItem(STORAGE_KEY);
      return raw ? new Blob([raw]).size : 0;
    } catch (err) {
      return 0;
    }
  }

  function entryStats() {
    if (!isUnlocked()) return { total: 0, weak: 0, reused: 0, favorites: 0 };
    const entries = vault.entries;
    const counts = new Map();
    for (const e of entries) {
      if (!e.password) continue;
      counts.set(e.password, (counts.get(e.password) || 0) + 1);
    }
    let weak = 0;
    let reused = 0;
    for (const e of entries) {
      if (e.password && C.estimateEntropyBits(e.password) < 45) weak++;
      if (e.password && (counts.get(e.password) || 0) > 1) reused++;
    }
    return {
      total: entries.length,
      weak,
      reused,
      favorites: entries.filter((e) => e.favorite).length,
    };
  }

  return {
    STORAGE_KEY,
    CATEGORIES,
    DEFAULT_SETTINGS,
    storageAvailable,
    getStorageKind,
    isPersistent,
    hasVault,
    isUnlocked,
    peekInfo,
    createVault,
    unlock,
    lock,
    getEntries,
    getEntry,
    addEntry,
    updateEntry,
    deleteEntry,
    getTrash,
    restoreFromTrash,
    emptyTrash,
    toggleFavorite,
    getSettings,
    updateSettings,
    changeMasterPassword,
    exportBackup,
    parseBackup,
    importBackup,
    parseCSV,
    importCSV,
    wipeAll,
    byteSize,
    entryStats,
  };
})();

window.KeyringStore = KeyringStore;
