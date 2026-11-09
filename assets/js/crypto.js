/* ============================================================
   Keyring — crypto layer
   Everything here runs locally in the browser using WebCrypto.
   No network calls, no third-party libraries, no plaintext ever
   leaves memory in a persisted form.
   ------------------------------------------------------------
   Envelope format (what actually sits in localStorage):

     {
       v: 1,
       kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 310000 },
       salt: "<base64, 16 bytes>",
       iv:   "<base64, 12 bytes>",
       data: "<base64 AES-256-GCM ciphertext>"
     }

   The AES key is derived from the master password + salt.
   Wrong password -> GCM auth tag mismatch -> decrypt throws.
   ============================================================ */

const KeyringCrypto = (() => {
  'use strict';

  const KDF_ITERATIONS = 310000; // OWASP-recommended order of magnitude for PBKDF2-SHA256
  const SALT_BYTES = 16;
  const IV_BYTES = 12;

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  /* ---------- base64 helpers (chunked, safe for large vaults) ---------- */
  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function b64ToBuf(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /* ---------- randomness ---------- */
  function randomBytes(n) {
    const out = new Uint8Array(n);
    crypto.getRandomValues(out);
    return out;
  }

  function randomInt(maxExclusive) {
    if (maxExclusive <= 0) throw new Error('randomInt: max must be > 0');
    // Rejection sampling — avoids modulo bias
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    const buf = new Uint32Array(1);
    for (;;) {
      crypto.getRandomValues(buf);
      if (buf[0] < limit) return buf[0] % maxExclusive;
    }
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /* ---------- key derivation ---------- */
  async function deriveKey(password, saltBytes, iterations = KDF_ITERATIONS) {
    const baseKey = await crypto.subtle.importKey(
      'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: saltBytes,
        iterations,
        hash: 'SHA-256',
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,           // not extractable
      ['encrypt', 'decrypt']
    );
  }

  /* ---------- encrypt / decrypt payload objects ---------- */
  async function encryptJSON(key, obj) {
    const iv = randomBytes(IV_BYTES);
    const plaintext = enc.encode(JSON.stringify(obj));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    return { iv: bufToB64(iv), data: bufToB64(cipher) };
  }

  async function decryptJSON(key, ivB64, dataB64) {
    const iv = b64ToBuf(ivB64);
    const data = b64ToBuf(dataB64);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return JSON.parse(dec.decode(plain));
  }

  /* ---------- password / passphrase generation ---------- */
  const SETS = {
    lowercase: 'abcdefghijkmnopqrstuvwxyz'.replace('l', ''),   // no l
    uppercase: 'ABCDEFGHJKLMNPQRSTUVWXYZ'.replace('I', '').replace('O', ''), // no I, O
    digits: '23456789',                                          // no 0, 1
    symbols: '!@#$%^&*()-_=+[]{};:,.?/',
  };

  // Full sets used when ambiguity filtering is off
  const FULL_SETS = {
    lowercase: 'abcdefghijklmnopqrstuvwxyz',
    uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    digits: '0123456789',
    symbols: '!@#$%^&*()-_=+[]{};:,.?/',
  };

  function generatePassword(opts = {}) {
    const {
      length = 20,
      lowercase = true,
      uppercase = true,
      digits = true,
      symbols = true,
      avoidAmbiguous = false,
    } = opts;

    const src = avoidAmbiguous ? SETS : FULL_SETS;
    const pools = [];
    if (lowercase) pools.push(src.lowercase);
    if (uppercase) pools.push(src.uppercase);
    if (digits) pools.push(src.digits);
    if (symbols) pools.push(src.symbols);
    if (!pools.length) pools.push(src.lowercase);

    const len = Math.max(pools.length, Math.min(128, Math.max(4, length | 0)));
    const all = pools.join('');

    // Guarantee at least one character from each selected pool, then fill.
    const chars = pools.map((p) => p[randomInt(p.length)]);
    while (chars.length < len) chars.push(all[randomInt(all.length)]);

    return shuffle(chars).join('');
  }

  const WORDS = [
    'amber','anchor','apollo','apple','arrow','atlas','aurora','autumn','badger','bamboo',
    'beacon','bison','blossom','breeze','bronze','cactus','canyon','cedar','cinder','citrus',
    'clover','cobalt','comet','copper','coral','cosmos','cotton','cricket','crystal','dawn',
    'delta','drift','eagle','ember','emerald','falcon','fable','fern','fjord','flint',
    'forest','fossil','galaxy','garnet','glacier','granite','harbor','hazel','heron','hollow',
    'indigo','ivory','jade','jasper','jungle','kite','lagoon','lantern','lark','lemon',
    'lichen','lilac','linen','lotus','lunar','maple','marble','meadow','mesa','meteor',
    'mint','monsoon','moss','nectar','nickel','nimbus','nova','oak','oasis','obsidian',
    'olive','onyx','opal','orbit','orchid','otter','pebble','pepper','petal','pine',
    'pixel','plum','polar','prairie','prism','pulsar','quartz','quill','raven','reef',
    'ripple','robin','saffron','sage','sand','satin','scarlet','shadow','silver','solstice',
    'sparrow','spruce','stellar','summit','sundial','sycamore','tango','thistle','thunder','tidal',
    'timber','topaz','tulip','tundra','umber','valley','velvet','violet','walnut','willow',
    'winter','zenith','zephyr','zinc',
  ];

  function generatePassphrase(opts = {}) {
    const { words = 4, separator = '-', capitalize = true, addNumber = true } = opts;
    const n = Math.max(3, Math.min(10, words | 0));
    const pick = [];
    for (let i = 0; i < n; i++) pick.push(WORDS[randomInt(WORDS.length)]);
    let out = pick
      .map((w) => (capitalize ? w[0].toUpperCase() + w.slice(1) : w))
      .join(separator);
    if (addNumber) out += separator + randomInt(90) + 10;
    return out;
  }

  /* ---------- strength estimation (entropy based, not naive rules) ---------- */
  function estimateEntropyBits(password) {
    if (!password) return 0;
    const classes = [
      /[a-z]/.test(password),
      /[A-Z]/.test(password),
      /[0-9]/.test(password),
      /[^a-zA-Z0-9]/.test(password),
    ].filter(Boolean).length;

    // Rough per-character pool size
    let pool = 0;
    if (/[a-z]/.test(password)) pool += 26;
    if (/[A-Z]/.test(password)) pool += 26;
    if (/[0-9]/.test(password)) pool += 10;
    if (/[^a-zA-Z0-9]/.test(password)) pool += 32;

    let bits = password.length * Math.log2(Math.max(pool, 2));

    // Penalise obvious repetition / sequences
    if (/^(.)\1+$/.test(password)) bits *= 0.15;
    else if (/(.)\1{2,}/.test(password)) bits *= 0.8;
    if (/^(?:0123|1234|12345|123456|abcdef|qwerty|password|letmein|admin)/i.test(password)) bits *= 0.35;
    if (/^\d+$/.test(password)) bits *= 0.6;
    if (classes === 1 && password.length < 12) bits *= 0.75;

    return Math.max(0, Math.round(bits));
  }

  function strengthLabel(bits) {
    if (bits < 28) return { label: 'Very weak', level: 0 };
    if (bits < 45) return { label: 'Weak', level: 1 };
    if (bits < 60) return { label: 'Fair', level: 2 };
    if (bits < 80) return { label: 'Strong', level: 3 };
    return { label: 'Excellent', level: 4 };
  }

  /* ---------- misc ---------- */
  function uid() {
    const b = randomBytes(8);
    return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  function constantTimeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  /* ---------- base32 decoding (RFC 4648) ---------- */
  function base32ToBuf(base32Str) {
    const clean = String(base32Str || '')
      .replace(/[\s-]/g, '')
      .toUpperCase();
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let value = 0;
    const bytes = [];

    for (let i = 0; i < clean.length; i++) {
      const idx = alphabet.indexOf(clean[i]);
      if (idx === -1) continue;
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        bytes.push((value >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    return new Uint8Array(bytes);
  }

  /* ---------- TOTP (RFC 6238 / RFC 4226) ---------- */
  async function generateTOTP(secret, epochMs = Date.now(), period = 30) {
    if (!secret) return null;
    let rawSecret = secret;
    if (typeof secret === 'string' && secret.toLowerCase().startsWith('otpauth://')) {
      try {
        const u = new URL(secret);
        rawSecret = u.searchParams.get('secret') || secret;
      } catch {
        const m = secret.match(/secret=([A-Za-z2-7]+)/i);
        if (m) rawSecret = m[1];
      }
    }

    const keyBytes = base32ToBuf(rawSecret);
    if (!keyBytes || keyBytes.length === 0) return null;

    const epochSec = Math.floor(epochMs / 1000);
    const counter = Math.floor(epochSec / period);

    const counterBuf = new ArrayBuffer(8);
    const counterView = new DataView(counterBuf);
    counterView.setUint32(0, Math.floor(counter / 0x100000000), false);
    counterView.setUint32(4, counter >>> 0, false);

    const hmacKey = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', hmacKey, counterBuf);
    const sigBytes = new Uint8Array(signature);
    const offset = sigBytes[sigBytes.length - 1] & 0x0f;
    const binary =
      ((sigBytes[offset] & 0x7f) << 24) |
      ((sigBytes[offset + 1] & 0xff) << 16) |
      ((sigBytes[offset + 2] & 0xff) << 8) |
      (sigBytes[offset + 3] & 0xff);

    const otp = binary % 1000000;
    const code = String(otp).padStart(6, '0');
    const remaining = period - (epochSec % period);

    return { code, remaining, period };
  }

  return {
    KDF_ITERATIONS,
    SALT_BYTES,
    IV_BYTES,
    bufToB64,
    b64ToBuf,
    randomBytes,
    randomInt,
    shuffle,
    deriveKey,
    encryptJSON,
    decryptJSON,
    generatePassword,
    generatePassphrase,
    estimateEntropyBits,
    strengthLabel,
    uid,
    constantTimeEqual,
    base32ToBuf,
    generateTOTP,
  };
})();

window.KeyringCrypto = KeyringCrypto;
