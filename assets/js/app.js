/* ============================================================
   Keyring — app logic
   Plain DOM, no framework. Sections:
     1. helpers
     2. state
     3. gate (setup / unlock)
     4. shell + rendering
     5. entry form / detail / delete
     6. generator
     7. settings / backup
     8. lock + auto-lock
     9. boot
   ============================================================ */

(function () {
  'use strict';

  const C = window.KeyringCrypto;
  const S = window.KeyringStore;

  /* ==========================================================
     1. helpers
     ========================================================== */

  const $ = function (sel, root) { return (root || document).querySelector(sel); };
  const $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function icon(name, cls) {
    return '<svg class="icon ' + (cls || '') + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  }

  function initials(title) {
    const t = String(title || '').trim();
    if (!t) return '?';
    const parts = t.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return t.slice(0, 2).toUpperCase();
  }

  function hueFor(text) {
    let h = 0;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }

  function timeAgo(ts) {
    if (!ts) return '—';
    const diff = Date.now() - Number(ts);
    const s = Math.round(diff / 1000);
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + 'h ago';
    const d = Math.round(h / 24);
    if (d < 30) return d + 'd ago';
    const mo = Math.round(d / 30);
    if (mo < 12) return mo + 'mo ago';
    return Math.round(mo / 12) + 'y ago';
  }

  function fullDate(ts) {
    if (!ts) return '—';
    try {
      return new Date(Number(ts)).toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch (err) {
      return new Date(Number(ts)).toISOString();
    }
  }

  function normalizeUrl(u) {
    const raw = String(u || '').trim();
    if (!raw) return '';
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return raw;
    return 'https://' + raw;
  }

  function isProbablyUrl(u) {
    const raw = String(u || '').trim();
    return raw.length > 0 && !/\s/.test(raw);
  }

  let toastSeq = 0;
  function toast(message, kind) {
    const wrap = $('#toast-wrap');
    if (!wrap) return;
    const id = ++toastSeq;
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'err' ? ' err' : '');
    el.dataset.id = String(id);
    el.innerHTML = icon(kind === 'err' ? 'alert' : 'check') + '<span>' + esc(message) + '</span>';
    wrap.appendChild(el);
    setTimeout(function () {
      el.classList.add('out');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
    }, kind === 'err' ? 3400 : 2100);
  }

  /* ---------- clipboard ---------- */
  let clipboardTimer = null;

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  async function copyText(text, label, opts) {
    const options = opts || {};
    let ok = true;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        ok = fallbackCopy(text);
      }
    } catch (err) {
      ok = fallbackCopy(text);
    }

    if (!ok) {
      toast('Could not access the clipboard — select and copy manually', 'err');
      return false;
    }

    const seconds = currentSettings().clipboardClearSeconds;
    if (options.secret && seconds > 0) {
      const mins = seconds >= 60 ? Math.round(seconds / 60) + ' min' : seconds + 's';
      toast(label + ' copied · clears in ' + mins);
      scheduleClipboardClear(seconds);
    } else {
      toast(label + ' copied');
    }
    return true;
  }

  function scheduleClipboardClear(seconds) {
    if (clipboardTimer) clearTimeout(clipboardTimer);
    clipboardTimer = setTimeout(function () {
      clipboardTimer = null;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText('').catch(function () { /* ignore */ });
        } else {
          fallbackCopy(' ');
        }
      } catch (err) { /* ignore */ }
    }, Math.max(5, seconds) * 1000);
  }

  /* ==========================================================
     2. state
     ========================================================== */

  const state = {
    filter: 'all',
    search: '',
    sort: 'recent',
    activeSheet: null,
    lastActivity: Date.now(),
    hiddenAt: null,
    revealTimer: null,
    installPrompt: null,
    importedDraft: null,
  };

  function currentSettings() {
    if (!S.isUnlocked()) {
      return JSON.parse(JSON.stringify(S.DEFAULT_SETTINGS));
    }
    return S.getSettings();
  }

  /* ==========================================================
     3. gate
     ========================================================== */

  function showSetup() {
    $('#gate').classList.remove('hidden');
    $('#app').classList.add('hidden');
    $('#setup-form').classList.remove('hidden');
    $('#unlock-form').classList.add('hidden');
    setTimeout(function () {
      const el = $('#setup-password');
      if (el) el.focus();
    }, 120);
  }

  function showUnlock(message) {
    $('#gate').classList.remove('hidden');
    $('#app').classList.add('hidden');
    $('#setup-form').classList.add('hidden');
    $('#unlock-form').classList.remove('hidden');
    const err = $('#unlock-error');
    if (Date.now() < unlockCooldownUntil) {
      setUnlockCooldownUI();
    } else if (message) {
      err.textContent = message;
      err.classList.remove('hidden');
    } else {
      err.classList.add('hidden');
    }
    setTimeout(function () {
      const el = $('#unlock-password');
      if (el) el.focus();
    }, 120);
  }

  function renderStrength(inputEl, meterEl) {
    const value = inputEl.value || '';
    const bits = C.estimateEntropyBits(value);
    const info = C.strengthLabel(bits);
    const fill = meterEl.querySelector('i');
    const label = meterEl.querySelector('.strength-label');
    const pct = [8, 25, 46, 69, 92][info.level];
    fill.style.width = value ? pct + '%' : '0%';
    const colors = ['#ff6b81', '#ff8a5c', '#f5b759', '#3ddc97', '#22d3ee'];
    fill.style.background = colors[info.level];
    label.textContent = value ? info.label : '—';
    label.style.color = value ? colors[info.level] : '';
  }

  async function handleSetup(event) {
    event.preventDefault();
    const passEl = $('#setup-password');
    const confirmEl = $('#setup-confirm');
    const errEl = $('#setup-error');
    const btn = $('#setup-submit');

    const password = passEl.value;
    const confirm = confirmEl.value;

    function fail(msg) {
      errEl.textContent = msg;
      errEl.classList.remove('hidden');
    }

    errEl.classList.add('hidden');

    if (password.length < 8) return fail('Use at least 8 characters.');
    if (password !== confirm) return fail('The two passwords do not match.');
    if (C.estimateEntropyBits(password) < 45) {
      return fail('That password is easy to guess. Mix in numbers, symbols and length.');
    }

    btn.disabled = true;
    btn.textContent = 'Sealing vault…';
    try {
      await S.createVault(password);
      passEl.value = '';
      confirmEl.value = '';
      unlockUI();
    } catch (err) {
      fail(err && err.message ? err.message : 'Could not create the vault.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Create vault';
    }
  }

  let unlockBusy = false;
  let failedUnlockAttempts = 0;
  let unlockCooldownUntil = 0;
  let unlockCooldownTimer = null;

  function setUnlockCooldownUI() {
    const btn = $('#unlock-submit');
    const errEl = $('#unlock-error');
    if (!btn || !errEl) return;
    const remaining = Math.max(0, Math.ceil((unlockCooldownUntil - Date.now()) / 1000));
    if (remaining > 0) {
      btn.disabled = true;
      btn.textContent = 'Wait ' + remaining + 's';
      errEl.textContent = 'Wrong password. Cooldown active (' + remaining + 's remaining).';
      errEl.classList.remove('hidden');
    } else {
      clearInterval(unlockCooldownTimer);
      unlockCooldownTimer = null;
      btn.disabled = false;
      btn.textContent = 'Unlock';
      errEl.textContent = 'Wrong master password. Try again.';
    }
  }

  async function handleUnlock(event) {
    event.preventDefault();
    if (unlockBusy) return;
    const passEl = $('#unlock-password');
    const errEl = $('#unlock-error');
    const btn = $('#unlock-submit');

    const now = Date.now();
    if (now < unlockCooldownUntil) {
      setUnlockCooldownUI();
      return;
    }

    const password = passEl.value;

    if (!password) {
      errEl.textContent = 'Enter your master password.';
      errEl.classList.remove('hidden');
      return;
    }

    errEl.classList.add('hidden');
    unlockBusy = true;
    btn.disabled = true;
    btn.textContent = 'Unlocking…';

    let result;
    try {
      result = await S.unlock(password);
    } catch (err) {
      result = { ok: false, reason: 'error' };
    } finally {
      unlockBusy = false;
      if (Date.now() >= unlockCooldownUntil) {
        btn.disabled = false;
        btn.textContent = 'Unlock';
      }
    }

    if (result.ok) {
      failedUnlockAttempts = 0;
      unlockCooldownUntil = 0;
      if (unlockCooldownTimer) {
        clearInterval(unlockCooldownTimer);
        unlockCooldownTimer = null;
      }
      passEl.value = '';
      unlockUI();
      if (result.entries === 0) {
        setTimeout(function () { toast('Vault unlocked — add your first password'); }, 250);
      }
      return;
    }

    if (result.reason === 'superseded') {
      // A newer attempt is already running; it will report the outcome.
      return;
    }

    if (result.reason === 'bad-password') {
      failedUnlockAttempts++;
      if (failedUnlockAttempts >= 3) {
        const cooldownSec = Math.min(30, 3 * Math.pow(2, failedUnlockAttempts - 3));
        unlockCooldownUntil = Date.now() + (cooldownSec * 1000);
        setUnlockCooldownUI();
        clearInterval(unlockCooldownTimer);
        unlockCooldownTimer = setInterval(setUnlockCooldownUI, 1000);
      } else {
        errEl.textContent = 'Wrong master password. Try again.';
        errEl.classList.remove('hidden');
      }
      passEl.select();
      const card = $('.gate-card');
      if (card && card.animate) {
        card.animate(
          [{ transform: 'translateX(0)' }, { transform: 'translateX(-7px)' },
           { transform: 'translateX(6px)' }, { transform: 'translateX(-4px)' },
           { transform: 'translateX(0)' }],
          { duration: 320, easing: 'ease-in-out' }
        );
      }
    } else if (result.reason === 'storage') {
      errEl.textContent = 'This browser is blocking local storage, so the vault cannot be opened. Disable private browsing and reload.';
      errEl.classList.remove('hidden');
    } else {
      errEl.textContent = 'The stored vault could not be read.';
      errEl.classList.remove('hidden');
    }
  }

  /* ==========================================================
     4. shell + rendering
     ========================================================== */

  function unlockUI() {
    $('#gate').classList.add('hidden');
    $('#app').classList.remove('hidden');
    const settings = S.getSettings();
    state.sort = settings.sortMode || 'recent';
    state.filter = 'all';
    state.search = '';
    $('#search').value = '';
    $('#search-clear').classList.add('hidden');
    state.lastActivity = Date.now();
    renderChips();
    renderList();
    maybeShowInstallBanner();
    startIdleWatch();
    refreshInstallButton();
    maybeShowInstallBanner();
    applyStorageNotice();
    handleLaunchShortcut();
  }

  function handleLaunchShortcut() {
    try {
      const params = new URLSearchParams(location.search);
      if (params.get('action') === 'new') {
        setTimeout(function () { openEntryForm(null); }, 320);
        try { history.replaceState(null, '', location.pathname); } catch (err) { /* ignore */ }
      }
    } catch (err) { /* ignore */ }
  }

  function lockVault(showMessage) {
    stopIdleWatch();
    state.revealTimer && clearTimeout(state.revealTimer);
    state.revealTimer = null;
    closeSheet(true);
    S.lock();
    $('#app').classList.add('hidden');
    showUnlock(showMessage ? 'Vault locked. Enter your master password to continue.' : null);
    const banner = $('#banner');
    banner.classList.add('hidden');
  }

  function getVisibleEntries() {
    const all = S.getEntries();
    const term = state.search.trim().toLowerCase();
    const filtered = all.filter(function (e) {
      if (state.filter === 'fav' && !e.favorite) return false;
      if (state.filter !== 'all' && state.filter !== 'fav' && e.category !== state.filter) return false;
      if (!term) return true;
      const hay = [e.title, e.username, e.url, e.notes, e.category]
        .concat(e.tags || [])
        .join(' \u0000 ')
        .toLowerCase();
      return hay.indexOf(term) !== -1;
    });

    const sortMode = state.sort;
    filtered.sort(function (a, b) {
      if (sortMode === 'az') return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
      if (sortMode === 'category') {
        const c = a.category.localeCompare(b.category);
        return c !== 0 ? c : a.title.localeCompare(b.title);
      }
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    return filtered;
  }

  function renderChips() {
    const entries = S.getEntries();
    const present = {};
    entries.forEach(function (e) { present[e.category] = (present[e.category] || 0) + 1; });
    const favCount = entries.filter(function (e) { return e.favorite; }).length;

    const chips = [];
    chips.push(
      '<button class="chip' + (state.filter === 'all' ? ' active' : '') + '" data-filter="all" role="tab">All <span>' + entries.length + '</span></button>'
    );
    if (favCount > 0 || state.filter === 'fav') {
      chips.push(
        '<button class="chip' + (state.filter === 'fav' ? ' active' : '') + '" data-filter="fav" role="tab">' +
        icon('star') + 'Favorites <span>' + favCount + '</span></button>'
      );
    }
    S.CATEGORIES.forEach(function (cat) {
      const count = present[cat] || 0;
      if (!count && state.filter !== cat) return;
      chips.push(
        '<button class="chip' + (state.filter === cat ? ' active' : '') + '" data-filter="' + esc(cat) + '" role="tab">' +
        esc(cat) + ' <span>' + count + '</span></button>'
      );
    });

    const wrap = $('#chips');
    wrap.innerHTML = chips.join('');
    $('#sort-btn').textContent = state.sort === 'az' ? 'A–Z' : (state.sort === 'category' ? 'Category' : 'Recent');
  }

  function cardHTML(entry) {
    const weak = entry.password && C.estimateEntropyBits(entry.password) < 45;
    const userLine = entry.username
      ? '<div class="card-user">' + esc(entry.username) + '</div>'
      : (entry.url ? '<div class="card-user">' + esc(entry.url) + '</div>' : '<div class="card-user">No username saved</div>');

    return '' +
      '<article class="card" data-id="' + esc(entry.id) + '">' +
        '<div class="card-main" data-action="open" role="button" tabindex="0" aria-label="Open ' + esc(entry.title) + '">' +
          '<div class="avatar" style="--hue:' + hueFor(entry.title) + '">' + esc(initials(entry.title)) + '</div>' +
          '<div class="card-text">' +
            '<div class="card-title-row">' +
              '<span class="card-title">' + esc(entry.title) + '</span>' +
              (weak ? '<span class="warn-dot" title="Weak password" aria-label="Weak password"></span>' : '') +
              '<span class="cat-pill">' + esc(entry.category) + '</span>' +
            '</div>' +
            userLine +
            (entry.password ? '<div class="card-pass">••••••••••</div>' : '<div class="card-pass">no password</div>') +
          '</div>' +
          '<button class="star-btn' + (entry.favorite ? ' active' : '') + '" data-action="fav" ' +
            'aria-label="' + (entry.favorite ? 'Remove from favorites' : 'Add to favorites') + '" ' +
            'aria-pressed="' + (entry.favorite ? 'true' : 'false') + '">' + icon('star') + '</button>' +
        '</div>' +
        '<div class="card-actions">' +
          '<button data-action="copy-user">' + icon('user') + 'User</button>' +
          '<button data-action="copy-pass">' + icon('key') + 'Password</button>' +
          '<button data-action="edit">' + icon('edit') + 'Edit</button>' +
          '<button data-action="delete" class="danger">' + icon('trash') + 'Delete</button>' +
        '</div>' +
      '</article>';
  }

  function renderList() {
    const entries = getVisibleEntries();
    const all = S.getEntries();
    const listEl = $('#list');
    const emptyEl = $('#empty');
    const metaEl = $('#meta-row');

    if (!entries.length) {
      listEl.innerHTML = '';
      emptyEl.classList.remove('hidden');

      const isFiltered = state.search.trim() || state.filter !== 'all';
      if (!all.length) {
        $('#empty-title').textContent = 'Your vault is empty';
        $('#empty-msg').textContent = 'Add your first login — it is encrypted before it ever touches storage.';
        $('#empty-cta').classList.remove('hidden');
        metaEl.innerHTML = '';
      } else if (isFiltered) {
        $('#empty-title').textContent = 'Nothing matches';
        $('#empty-msg').textContent = 'No entry matches this search or filter. Try a different word or category.';
        $('#empty-cta').classList.add('hidden');
        metaEl.innerHTML = '<span>0 of ' + all.length + ' entries</span>';
      } else {
        $('#empty-title').textContent = 'Your vault is empty';
        $('#empty-msg').textContent = 'Add your first login.';
        $('#empty-cta').classList.remove('hidden');
        metaEl.innerHTML = '';
      }
      return;
    }

    emptyEl.classList.add('hidden');
    listEl.innerHTML = entries.map(cardHTML).join('');

    const stats = S.entryStats();
    const bits = [];
    bits.push('<span>' + (entries.length === all.length
      ? entries.length + (entries.length === 1 ? ' entry' : ' entries')
      : entries.length + ' of ' + all.length) + '</span>');
    if (stats.weak > 0) {
      bits.push('<span style="color:var(--warn)">' + stats.weak + ' weak</span>');
    }
    if (stats.reused > 0) {
      bits.push('<span style="color:var(--warn)">' + stats.reused + ' reused</span>');
    }
    metaEl.innerHTML = bits.join('');
  }

  function refresh() {
    renderChips();
    renderList();
  }

  /* ==========================================================
     5. sheets
     ========================================================== */

  const overlay = function () { return $('#overlay'); };

  function openSheet(name, html, setup) {
    const ov = overlay();

    // Replace the sheet node with a clean copy so listeners attached by the
    // previous sheet (delegated change/click handlers) cannot leak into this one.
    const previous = $('#sheet');
    const sheet = previous.cloneNode(false);
    previous.parentNode.replaceChild(sheet, previous);

    sheet.innerHTML = html;
    state.activeSheet = name;
    ov.classList.remove('hidden');
    document.body.classList.add('no-scroll', 'sheet-open');
    requestAnimationFrame(function () { ov.classList.add('open'); });
    sheet.scrollTop = 0;

    $$('[data-close]', sheet).forEach(function (el) {
      el.addEventListener('click', function () { closeSheet(); });
    });

    if (typeof setup === 'function') setup(sheet);

    setTimeout(function () {
      const first = sheet.querySelector('input:not([type=hidden]):not([type=checkbox]), textarea, select');
      if (first && !('ontouchstart' in window)) first.focus();
    }, 220);
  }

  function closeSheet(instant) {
    const ov = overlay();
    if (ov.classList.contains('hidden')) return;
    state.activeSheet = null;
    if (state.revealTimer) { clearTimeout(state.revealTimer); state.revealTimer = null; }
    ov.classList.remove('open');
    document.body.classList.remove('no-scroll', 'sheet-open');
    if (instant) {
      ov.classList.add('hidden');
      const sheet = $('#sheet');
      if (sheet) sheet.innerHTML = '';
      return;
    }
    setTimeout(function () {
      if (!ov.classList.contains('open')) {
        ov.classList.add('hidden');
        const sheet = $('#sheet');
        if (sheet) sheet.innerHTML = '';
      }
    }, 200);
  }

  function sheetHead(title, iconName, extraHtml) {
    return '<div class="sheet-head">' +
      '<h2>' + (iconName ? icon(iconName) : '') + esc(title) + '</h2>' +
      '<div style="display:flex;gap:4px;align-items:center">' + (extraHtml || '') +
      '<button type="button" class="icon-btn" data-close aria-label="Close">' + icon('x') + '</button></div>' +
      '</div>';
  }

  /* ---------- entry form ---------- */

  function entryFormHTML(data) {
    const isEdit = !!(data && data.id);
    const d = data || {};
    const categories = S.CATEGORIES.map(function (cat) {
      return '<option value="' + esc(cat) + '"' + ((d.category || 'General') === cat ? ' selected' : '') + '>' + esc(cat) + '</option>';
    }).join('');

    return '' +
      '<form class="sheet-form" id="entry-form" autocomplete="off" novalidate>' +
        sheetHead(isEdit ? 'Edit password' : 'New password', 'key') +
        '<label class="field">' +
          '<span class="field-label">Title *</span>' +
          '<input id="f-title" type="text" required placeholder="e.g. Gmail, HDFC Bank, GitHub" value="' + esc(d.title || '') + '" maxlength="80">' +
        '</label>' +
        '<label class="field">' +
          '<span class="field-label">Username or email</span>' +
          '<input id="f-username" type="text" inputmode="email" placeholder="you@example.com" value="' + esc(d.username || '') + '" maxlength="160" spellcheck="false">' +
        '</label>' +
        '<div class="field">' +
          '<span class="field-label">Password</span>' +
          '<div class="input-row">' +
            '<input id="f-password" type="password" placeholder="Password" value="' + esc(d.password || '') + '" maxlength="512" spellcheck="false">' +
            '<button type="button" class="icon-btn" data-toggle-pass="f-password" aria-label="Show password">' + icon('eye') + '</button>' +
            '<button type="button" class="icon-btn" id="f-generate" aria-label="Generate password" title="Generate password">' + icon('dice') + '</button>' +
          '</div>' +
          '<div class="strength" id="f-strength"><div class="strength-track"><i></i></div><span class="strength-label">—</span></div>' +
        '</div>' +
        '<div class="field-grid">' +
          '<label class="field">' +
            '<span class="field-label">Website</span>' +
            '<input id="f-url" type="text" inputmode="url" placeholder="example.com" value="' + esc(d.url || '') + '" spellcheck="false">' +
          '</label>' +
          '<label class="field">' +
            '<span class="field-label">Category</span>' +
            '<select id="f-category">' + categories + '</select>' +
          '</label>' +
        '</div>' +
        '<label class="field">' +
          '<span class="field-label">Tags</span>' +
          '<input id="f-tags" type="text" placeholder="work, personal (comma separated)" value="' + esc((d.tags || []).join(', ')) + '">' +
        '</label>' +
        '<label class="field">' +
          '<span class="field-label">2FA / TOTP Authenticator Secret (optional)</span>' +
          '<input id="f-totp" type="text" placeholder="e.g. JBSWY3DPEHPK3PXP or otpauth://..." value="' + esc(d.totp || '') + '" autocomplete="off" spellcheck="false">' +
        '</label>' +
        '<label class="field">' +
          '<span class="field-label">Notes</span>' +
          '<textarea id="f-notes" placeholder="Recovery codes, security question answers, anything else…" maxlength="4000" rows="3">' + esc(d.notes || '') + '</textarea>' +
        '</label>' +
        '<p class="form-error hidden" id="f-error" role="alert"></p>' +
        '<div class="sheet-actions">' +
          '<button type="button" class="btn ghost" data-close>Cancel</button>' +
          '<button type="submit" class="btn primary" id="f-save">' + (isEdit ? 'Save changes' : 'Save password') + '</button>' +
        '</div>' +
      '</form>';
  }

  function readEntryForm() {
    return {
      title: $('#f-title') ? $('#f-title').value : '',
      username: $('#f-username') ? $('#f-username').value : '',
      password: $('#f-password') ? $('#f-password').value : '',
      url: $('#f-url') ? $('#f-url').value : '',
      category: $('#f-category') ? $('#f-category').value : 'General',
      tags: $('#f-tags') ? $('#f-tags').value : '',
      totp: $('#f-totp') ? $('#f-totp').value.trim() : '',
      notes: $('#f-notes') ? $('#f-notes').value : '',
    };
  }

  function openEntryForm(entry) {
    const isEdit = !!(entry && entry.id);
    const data = entry || {};
    openSheet('entry', entryFormHTML(data), function (sheet) {
      const form = $('#entry-form', sheet);
      const passInput = $('#f-password', sheet);
      const strength = $('#f-strength', sheet);
      if (passInput.value) renderStrength(passInput, strength);

      passInput.addEventListener('input', function () { renderStrength(passInput, strength); });

      $('#f-generate', sheet).addEventListener('click', function () {
        const draft = readEntryForm();
        state.importedDraft = { mode: 'edit-form', entryId: isEdit ? entry.id : null, draft: draft };
        openGenerator({
          onUse: function (value) {
            const restored = Object.assign({}, draft, { password: value });
            if (isEdit) {
              const original = S.getEntry(entry.id) || {};
              openEntryForm(Object.assign({}, original, restored, { id: entry.id }));
            } else {
              openEntryForm(restored);
            }
          },
        });
      });

      form.addEventListener('submit', function (event) {
        event.preventDefault();
        submitEntryForm(form, isEdit ? entry.id : null);
      });

      [passInput].forEach(function (el) {
        el.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') { ev.preventDefault(); submitEntryForm(form, isEdit ? entry.id : null); }
        });
      });
    });
  }

  async function submitEntryForm(form, editId) {
    const errEl = $('#f-error', form);
    const saveBtn = $('#f-save', form);
    const data = readEntryForm();

    function fail(msg) {
      errEl.textContent = msg;
      errEl.classList.remove('hidden');
    }

    errEl.classList.add('hidden');
    if (!String(data.title).trim()) return fail('Give this entry a title so you can find it later.');
    if (!String(data.password).trim() && !String(data.notes).trim()) {
      return fail('Add a password (or at least a note) before saving.');
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Encrypting…';
    try {
      if (editId) {
        await S.updateEntry(editId, data);
        closeSheet();
        refresh();
        toast('Changes saved');
      } else {
        await S.addEntry(data);
        closeSheet();
        refresh();
        toast('Saved and encrypted');
      }
    } catch (err) {
      fail('Could not save: ' + (err && err.message ? err.message : 'unknown error'));
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = editId ? 'Save changes' : 'Save password';
    }
  }

  /* ---------- detail ---------- */

  function openDetail(id) {
    const entry = S.getEntry(id);
    if (!entry) { toast('That entry no longer exists', 'err'); refresh(); return; }

    const weak = entry.password && C.estimateEntropyBits(entry.password) < 45;
    const strengthInfo = entry.password ? C.strengthLabel(C.estimateEntropyBits(entry.password)) : null;

    const tagsHtml = (entry.tags && entry.tags.length)
      ? entry.tags.map(function (t) { return '<span class="tag">#' + esc(t) + '</span>'; }).join('')
      : '';

    const urlHtml = entry.url
      ? '<div class="kv-row">' +
          '<div class="kv-label">Website</div>' +
          '<div class="kv-value-row">' +
            '<div class="kv-value"><a href="' + esc(normalizeUrl(entry.url)) + '" target="_blank" rel="noopener noreferrer">' + esc(entry.url) + '</a></div>' +
            '<div class="kv-actions">' +
              '<button class="icon-btn" data-act="copy-url" aria-label="Copy website">' + icon('copy') + '</button>' +
            '</div>' +
          '</div>' +
        '</div>'
      : '';

    const html = '' +
      '<div class="detail-title-row">' +
        '<div class="avatar" style="--hue:' + hueFor(entry.title) + '">' + esc(initials(entry.title)) + '</div>' +
        '<h2>' + esc(entry.title) + '</h2>' +
        '<button class="star-btn' + (entry.favorite ? ' active' : '') + '" id="d-fav" aria-label="Toggle favorite">' + icon('star') + '</button>' +
        '<button type="button" class="icon-btn" data-close aria-label="Close">' + icon('x') + '</button>' +
      '</div>' +
      '<div class="detail-meta">' +
        '<span class="tag accent">' + esc(entry.category) + '</span>' +
        tagsHtml +
        (weak ? '<span class="tag" style="color:var(--warn)">weak password</span>' : '') +
        (strengthInfo && !weak ? '<span class="tag" style="color:var(--ok)">' + esc(strengthInfo.label) + '</span>' : '') +
      '</div>' +
      '<div class="kv">' +
        (entry.username
          ? '<div class="kv-row">' +
              '<div class="kv-label">Username / Email</div>' +
              '<div class="kv-value-row">' +
                '<div class="kv-value">' + esc(entry.username) + '</div>' +
                '<div class="kv-actions">' +
                  '<button class="icon-btn" data-act="copy-user" aria-label="Copy username">' + icon('copy') + '</button>' +
                '</div>' +
              '</div>' +
            '</div>'
          : '') +
        (entry.password
          ? '<div class="kv-row">' +
              '<div class="kv-label">Password</div>' +
              '<div class="kv-value-row">' +
                '<div class="kv-value masked" id="d-pass">••••••••••••</div>' +
                '<div class="kv-actions">' +
                  '<button class="icon-btn" id="d-reveal" aria-label="Show password">' + icon('eye') + '</button>' +
                  '<button class="icon-btn" data-act="copy-pass" aria-label="Copy password">' + icon('copy') + '</button>' +
                '</div>' +
              '</div>' +
            '</div>'
          : '') +
        (entry.totp
          ? '<div class="kv-row" id="d-totp-row">' +
              '<div class="kv-label">2FA / TOTP Authenticator <span id="d-totp-timer" style="font-weight:normal;opacity:0.7"></span></div>' +
              '<div class="kv-value-row">' +
                '<div class="kv-value mono" id="d-totp-code" style="font-size:1.35rem;letter-spacing:3px;font-weight:600;color:var(--accent-2)">------</div>' +
                '<div class="kv-actions">' +
                  '<button class="icon-btn" id="d-copy-totp" aria-label="Copy 2FA code">' + icon('copy') + '</button>' +
                '</div>' +
              '</div>' +
            '</div>'
          : '') +
        urlHtml +
        (entry.notes
          ? '<div class="kv-row">' +
              '<div class="kv-label">Notes</div>' +
              '<div class="kv-text">' + esc(entry.notes) + '</div>' +
              '<div style="display:flex;justify-content:flex-end;margin-top:6px">' +
                '<button class="icon-btn" data-act="copy-notes" aria-label="Copy notes">' + icon('copy') + '</button>' +
              '</div>' +
            '</div>'
          : '') +
        (entry.history && entry.history.length
          ? '<div class="kv-row">' +
              '<details style="cursor:pointer">' +
                '<summary class="kv-label" style="outline:none">Password history (' + entry.history.length + ' previous)</summary>' +
                '<div style="margin-top:8px;display:flex;flex-direction:column;gap:6px">' +
                  entry.history.map(function (h) {
                    return '<div style="display:flex;justify-content:space-between;align-items:center;background:var(--surface-2);padding:6px 10px;border-radius:8px">' +
                      '<div>' +
                        '<span class="mono" style="font-size:13px">' + esc(h.password) + '</span>' +
                        '<div style="font-size:11px;color:var(--text-faint)">Changed ' + esc(timeAgo(h.changedAt)) + '</div>' +
                      '</div>' +
                      '<button type="button" class="icon-btn" data-act="copy-old" data-val="' + esc(h.password) + '" aria-label="Copy old password">' + icon('copy') + '</button>' +
                    '</div>';
                  }).join('') +
                '</div>' +
              '</details>' +
            '</div>'
          : '') +
      '</div>' +
      '<div class="detail-foot">' +
        '<button class="btn ghost" id="d-delete">' + icon('trash') + 'Delete</button>' +
        '<button class="btn primary" id="d-edit">' + icon('edit') + 'Edit</button>' +
      '</div>' +
      '<div class="detail-times">Added ' + esc(fullDate(entry.createdAt)) + ' · Updated ' + esc(timeAgo(entry.updatedAt)) + '</div>';

    openSheet('detail', html, function (sheet) {
      $('#d-fav', sheet).addEventListener('click', async function () {
        const updated = await S.toggleFavorite(id);
        if (updated) {
          const btn = $('#d-fav', sheet);
          btn.classList.toggle('active', updated.favorite);
          refresh();
        }
      });

      const revealBtn = $('#d-reveal', sheet);
      if (revealBtn) {
        revealBtn.addEventListener('click', function () {
          const el = $('#d-pass', sheet);
          const shown = el.dataset.shown === 'true';
          if (shown) {
            el.textContent = '••••••••••••';
            el.dataset.shown = 'false';
            el.classList.add('masked');
            revealBtn.innerHTML = icon('eye');
            if (state.revealTimer) { clearTimeout(state.revealTimer); state.revealTimer = null; }
          } else {
            const fresh = S.getEntry(id);
            el.textContent = fresh ? fresh.password : '';
            el.dataset.shown = 'true';
            el.classList.remove('masked');
            revealBtn.innerHTML = icon('eye-off');
            if (state.revealTimer) clearTimeout(state.revealTimer);
            state.revealTimer = setTimeout(function () {
              const node = document.getElementById('d-pass');
              if (node && node.dataset.shown === 'true') {
                node.textContent = '••••••••••••';
                node.dataset.shown = 'false';
                node.classList.add('masked');
              }
            }, 30000);
          }
        });
      }

      if (entry.totp) {
        let totpTimer = null;
        async function updateTOTP() {
          const codeEl = $('#d-totp-code', sheet);
          const timerEl = $('#d-totp-timer', sheet);
          if (!codeEl) {
            if (totpTimer) clearInterval(totpTimer);
            return;
          }
          const res = await C.generateTOTP(entry.totp);
          if (res) {
            codeEl.textContent = res.code.slice(0, 3) + ' ' + res.code.slice(3);
            if (timerEl) timerEl.textContent = '(' + res.remaining + 's)';
          } else {
            codeEl.textContent = 'Invalid secret';
          }
        }
        updateTOTP();
        totpTimer = setInterval(updateTOTP, 1000);

        const copyTotp = $('#d-copy-totp', sheet);
        if (copyTotp) {
          copyTotp.addEventListener('click', async function () {
            const res = await C.generateTOTP(entry.totp);
            if (res && res.code) {
              await copyText(res.code, '2FA Code', { secret: true });
            } else {
              toast('Invalid 2FA secret', 'err');
            }
          });
        }
      }

      sheet.addEventListener('click', function (event) {
        const btn = event.target.closest('[data-act]');
        if (!btn) return;
        const act = btn.getAttribute('data-act');
        const fresh = S.getEntry(id);
        if (!fresh) return;
        if (act === 'copy-user') copyText(fresh.username, 'Username', { secret: false });
        if (act === 'copy-pass') copyText(fresh.password, 'Password', { secret: true });
        if (act === 'copy-url') copyText(fresh.url, 'Website', { secret: false });
        if (act === 'copy-notes') copyText(fresh.notes, 'Notes', { secret: false });
        if (act === 'copy-old') copyText(btn.getAttribute('data-val'), 'Previous password', { secret: true });
      });

      $('#d-edit', sheet).addEventListener('click', function () { openEntryForm(S.getEntry(id)); });
      $('#d-delete', sheet).addEventListener('click', function () { confirmDelete(id); });
    });
  }

  function confirmDelete(id) {
    const entry = S.getEntry(id);
    if (!entry) return;
    const html = '' +
      '<div class="confirm">' +
        '<div class="confirm-icon">' + icon('trash') + '</div>' +
        '<h2>Delete this password?</h2>' +
        '<p><strong style="color:var(--text)">' + esc(entry.title) + '</strong> will be removed from the vault on this device. This cannot be undone unless you have a backup.</p>' +
        '<div class="sheet-actions">' +
          '<button type="button" class="btn ghost" data-close>Keep it</button>' +
          '<button class="btn danger solid" id="confirm-delete">Delete</button>' +
        '</div>' +
      '</div>';
    openSheet('delete', html, function (sheet) {
      $('#confirm-delete', sheet).addEventListener('click', async function () {
        await S.deleteEntry(id);
        closeSheet();
        refresh();
        toast('Deleted');
      });
    });
  }

  /* ==========================================================
     6. generator
     ========================================================== */

  function generatorHTML() {
    const g = currentSettings().generator || S.DEFAULT_SETTINGS.generator;
    return '' +
      '<div class="sheet-form">' +
        sheetHead('Password generator', 'dice') +
        '<div class="chips" style="margin-top:-6px">' +
          '<button class="chip' + (g.mode !== 'passphrase' ? ' active' : '') + '" id="gen-tab-pass">Random</button>' +
          '<button class="chip' + (g.mode === 'passphrase' ? ' active' : '') + '" id="gen-tab-phrase">Passphrase</button>' +
        '</div>' +
        '<div class="gen-output">' +
          '<span class="gen-value" id="gen-value">' + esc(C.generatePassword(g)) + '</span>' +
          '<button class="icon-btn" id="gen-refresh" aria-label="Regenerate">' + icon('refresh') + '</button>' +
        '</div>' +
        '<div class="gen-strength"><div class="strength" id="gen-strength"><div class="strength-track"><i></i></div><span class="strength-label">—</span></div></div>' +

        '<div id="gen-passopts">' +
          '<div class="gen-controls">' +
            '<div class="gen-length-row">' +
              '<label for="gen-length">Length</label>' +
              '<input type="range" id="gen-length" min="8" max="64" value="' + Number(g.length) + '">' +
              '<span class="gen-length-val" id="gen-length-val">' + Number(g.length) + '</span>' +
            '</div>' +
            '<div class="gen-toggles">' +
              '<label class="gen-toggle"><input type="checkbox" id="gen-lower"' + (g.lowercase ? ' checked' : '') + '> a-z</label>' +
              '<label class="gen-toggle"><input type="checkbox" id="gen-upper"' + (g.uppercase ? ' checked' : '') + '> A-Z</label>' +
              '<label class="gen-toggle"><input type="checkbox" id="gen-digits"' + (g.digits ? ' checked' : '') + '> 0-9</label>' +
              '<label class="gen-toggle"><input type="checkbox" id="gen-symbols"' + (g.symbols ? ' checked' : '') + '> Symbols</label>' +
            '</div>' +
            '<label class="gen-toggle" style="justify-content:flex-start">' +
              '<input type="checkbox" id="gen-ambig"' + (g.avoidAmbiguous ? ' checked' : '') + '> Avoid look-alike characters (l, 1, O, 0)' +
            '</label>' +
          '</div>' +
        '</div>' +

        '<div id="gen-phraseopts" class="hidden">' +
          '<div class="gen-controls">' +
            '<div class="gen-length-row">' +
              '<label for="gen-words">Words</label>' +
              '<input type="range" id="gen-words" min="3" max="8" value="' + Number(g.words || 4) + '">' +
              '<span class="gen-length-val" id="gen-words-val">' + Number(g.words || 4) + '</span>' +
            '</div>' +
            '<div class="gen-toggles">' +
              '<label class="gen-toggle"><input type="checkbox" id="gen-cap" checked> Capitalise</label>' +
              '<label class="gen-toggle"><input type="checkbox" id="gen-num" checked> Add a number</label>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="gen-actions">' +
          '<button class="btn ghost" id="gen-copy">' + icon('copy') + 'Copy</button>' +
          '<button class="btn primary" id="gen-use">Use this password</button>' +
        '</div>' +
      '</div>';
  }

  function openGenerator(options) {
    const opts = options || {};
    openSheet('generator', generatorHTML(), function (sheet) {
      const valueEl = $('#gen-value', sheet);
      const strengthEl = $('#gen-strength', sheet);
      const stateGen = {
        mode: (currentSettings().generator.mode === 'passphrase') ? 'passphrase' : 'password',
      };

      function currentOpts() {
        return {
          length: Number($('#gen-length', sheet).value),
          lowercase: $('#gen-lower', sheet).checked,
          uppercase: $('#gen-upper', sheet).checked,
          digits: $('#gen-digits', sheet).checked,
          symbols: $('#gen-symbols', sheet).checked,
          avoidAmbiguous: $('#gen-ambig', sheet).checked,
          words: Number($('#gen-words', sheet).value),
          capitalize: $('#gen-cap', sheet).checked,
          addNumber: $('#gen-num', sheet).checked,
        };
      }

      function regenerate() {
        const o = currentOpts();
        const value = stateGen.mode === 'passphrase'
          ? C.generatePassphrase(o)
          : C.generatePassword(o);
        valueEl.textContent = value;
        // strength meter
        const bits = C.estimateEntropyBits(value);
        const info = C.strengthLabel(bits);
        const fill = strengthEl.querySelector('i');
        const label = strengthEl.querySelector('.strength-label');
        const colors = ['#ff6b81', '#ff8a5c', '#f5b759', '#3ddc97', '#22d3ee'];
        fill.style.width = [8, 25, 46, 69, 92][info.level] + '%';
        fill.style.background = colors[info.level];
        label.textContent = info.label;
        label.style.color = colors[info.level];
        return value;
      }

      function syncRange(rangeEl, valEl) {
        const min = Number(rangeEl.min);
        const max = Number(rangeEl.max);
        const pct = ((Number(rangeEl.value) - min) / (max - min)) * 100;
        rangeEl.style.setProperty('--fill', pct + '%');
        if (valEl) valEl.textContent = rangeEl.value;
      }

      function applyMode() {
        const isPhrase = stateGen.mode === 'passphrase';
        $('#gen-tab-pass', sheet).classList.toggle('active', !isPhrase);
        $('#gen-tab-phrase', sheet).classList.toggle('active', isPhrase);
        $('#gen-passopts', sheet).classList.toggle('hidden', isPhrase);
        $('#gen-phraseopts', sheet).classList.toggle('hidden', !isPhrase);
        regenerate();
      }

      $('#gen-tab-pass', sheet).addEventListener('click', function () { stateGen.mode = 'password'; applyMode(); });
      $('#gen-tab-phrase', sheet).addEventListener('click', function () { stateGen.mode = 'passphrase'; applyMode(); });

      const lengthEl = $('#gen-length', sheet);
      const wordsEl = $('#gen-words', sheet);
      syncRange(lengthEl, $('#gen-length-val', sheet));
      syncRange(wordsEl, $('#gen-words-val', sheet));

      lengthEl.addEventListener('input', function () {
        syncRange(lengthEl, $('#gen-length-val', sheet));
        regenerate();
      });
      wordsEl.addEventListener('input', function () {
        syncRange(wordsEl, $('#gen-words-val', sheet));
        regenerate();
      });

      ['gen-lower', 'gen-upper', 'gen-digits', 'gen-symbols', 'gen-ambig', 'gen-cap', 'gen-num']
        .forEach(function (id) {
          const el = document.getElementById(id);
          if (el) el.addEventListener('change', regenerate);
        });

      $('#gen-refresh', sheet).addEventListener('click', regenerate);

      $('#gen-copy', sheet).addEventListener('click', function () {
        copyText(valueEl.textContent, 'Password', { secret: true });
      });

      $('#gen-use', sheet).addEventListener('click', function () {
        const value = valueEl.textContent;
        if (typeof opts.onUse === 'function') {
          closeSheet();
          opts.onUse(value);
        } else {
          copyText(value, 'Password', { secret: true });
          closeSheet();
        }
      });

      // remember the generator setup for next time
      sheet.addEventListener('change', function () {
        const o = currentOpts();
        S.updateSettings({
          generator: Object.assign({}, o, { mode: stateGen.mode }),
        }).catch(function () { /* settings are best-effort */ });
      });

      applyMode();
    });
  }

  /* ==========================================================
     7. settings + backup
     ========================================================== */

  function settingsHTML() {
    const settings = S.getSettings();
    const stats = S.entryStats();
    const bytes = S.byteSize();
    const trash = S.getTrash();
    const trashCount = trash.length;
    const sizeLabel = bytes > 1024 * 1024
      ? (bytes / (1024 * 1024)).toFixed(2) + ' MB'
      : Math.max(1, Math.round(bytes / 1024)) + ' KB';

    function option(value, label, selected) {
      return '<option value="' + value + '"' + (selected ? ' selected' : '') + '>' + label + '</option>';
    }

    const autoLockOpts = [
      option(0, 'Off', settings.autoLockMinutes === 0),
      option(1, '1 min', settings.autoLockMinutes === 1),
      option(5, '5 min', settings.autoLockMinutes === 5),
      option(15, '15 min', settings.autoLockMinutes === 15),
      option(30, '30 min', settings.autoLockMinutes === 30),
      option(60, '1 hour', settings.autoLockMinutes === 60),
    ].join('');

    const clipOpts = [
      option(0, 'Never', settings.clipboardClearSeconds === 0),
      option(15, '15 s', settings.clipboardClearSeconds === 15),
      option(30, '30 s', settings.clipboardClearSeconds === 30),
      option(60, '60 s', settings.clipboardClearSeconds === 60),
      option(120, '2 min', settings.clipboardClearSeconds === 120),
    ].join('');

    return '' +
      '<div class="sheet-form">' +
        sheetHead('Settings', 'settings') +

        '<div class="settings-group">' +
          '<h3>Security</h3>' +
          '<div class="settings-card">' +
            '<div class="settings-item">' +
              '<div class="settings-text"><div class="t">Auto-lock</div><div class="s">Lock the vault after a period of inactivity</div></div>' +
              '<select id="set-autolock">' + autoLockOpts + '</select>' +
            '</div>' +
            '<div class="settings-item">' +
              '<div class="settings-text"><div class="t">Clear clipboard</div><div class="s">Wipe copied passwords after a delay</div></div>' +
              '<select id="set-clip">' + clipOpts + '</select>' +
            '</div>' +
            '<div class="settings-item">' +
              '<div class="settings-text"><div class="t">Master password</div><div class="s">Change the key that encrypts this vault</div></div>' +
              '<button class="btn ghost small" id="set-change-pass">Change</button>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="settings-group">' +
          '<h3>Backup &amp; transfer</h3>' +
          '<div class="settings-card">' +
            '<div class="settings-item">' +
              '<div class="settings-text"><div class="t">Export backup</div><div class="s">Encrypted .json file — move it to another phone</div></div>' +
              '<button class="btn ghost small" id="set-export">' + icon('download') + 'Export</button>' +
            '</div>' +
            '<div class="settings-item">' +
              '<div class="settings-text"><div class="t">Import backup</div><div class="s">Restore or merge from a backup file</div></div>' +
              '<button class="btn ghost small" id="set-import">' + icon('upload') + 'Import</button>' +
            '</div>' +
            '<div class="settings-item">' +
              '<div class="settings-text"><div class="t">Install on this phone</div><div class="s">Add Keyring to your home screen</div></div>' +
              '<button class="btn ghost small" id="set-install">Install</button>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="settings-group">' +
          '<h3>Vault health</h3>' +
          '<div class="settings-card">' +
            '<div class="settings-item">' +
              '<div class="settings-text"><div class="t">Stored entries</div><div class="s">' +
                stats.total + ' total · ' + stats.favorites + ' favorites · ' +
                '<span style="color:' + (stats.weak ? 'var(--warn)' : 'var(--ok)') + '">' + stats.weak + ' weak</span> · ' +
                '<span style="color:' + (stats.reused ? 'var(--warn)' : 'var(--ok)') + '">' + stats.reused + ' reused</span>' +
              '</div></div>' +
              '<span class="storage-pill"><span id="dot"></span>' + sizeLabel + '</span>' +
            '</div>' +
            '<div class="settings-item">' +
              '<div class="settings-text"><div class="t">Encryption</div><div class="s">AES-256-GCM · PBKDF2-SHA256 · ' + Number(C.KDF_ITERATIONS).toLocaleString() + ' iterations</div></div>' +
              '<span class="storage-pill">Active</span>' +
            '</div>' +
            '<div class="settings-item">' +
              '<div class="settings-text"><div class="t">Storage</div><div class="s">' +
                (S.isPersistent()
                  ? 'Saved on this device, encrypted at rest'
                  : 'Preview mode — this window blocks storage, nothing is saved') +
              '</div></div>' +
              '<span class="storage-pill' + (S.isPersistent() ? '' : ' warn') + '">' +
                (S.isPersistent() ? 'On device' : 'In memory') +
              '</span>' +
            '</div>' +
            '<div class="settings-item">' +
              '<div class="settings-text"><div class="t">Trash bin</div><div class="s">' + trashCount + ' deleted item' + (trashCount === 1 ? '' : 's') + '</div></div>' +
              (trashCount > 0
                ? '<button class="btn ghost small" id="set-empty-trash">Empty trash</button>'
                : '<span class="storage-pill">Empty</span>') +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="settings-group">' +
          '<h3>Danger zone</h3>' +
          '<div class="settings-card">' +
            '<div class="settings-item">' +
              '<div class="settings-text"><div class="t">Delete vault</div><div class="s">Erase every entry from this device. Export a backup first.</div></div>' +
              '<button class="btn danger small" id="set-wipe">Erase</button>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="about-line">' +
          '<span>Keyring v1.0</span><span>Offline · no accounts · no tracking</span><span>Data never leaves this device</span>' +
        '</div>' +
      '</div>';
  }

  function openSettings() {
    // keep the locked-state snapshot accurate (sort order, generator setup)
    const settings = S.getSettings();
    state.sort = settings.sortMode || state.sort;
    renderChips();
    openSheet('settings', settingsHTML(), function (sheet) {
      $('#set-autolock', sheet).addEventListener('change', async function (e) {
        await S.updateSettings({ autoLockMinutes: Number(e.target.value) });
        startIdleWatch();
        toast('Auto-lock updated');
      });

      $('#set-clip', sheet).addEventListener('change', async function (e) {
        await S.updateSettings({ clipboardClearSeconds: Number(e.target.value) });
        toast('Clipboard setting saved');
      });

      const emptyTrashBtn = $('#set-empty-trash', sheet);
      if (emptyTrashBtn) {
        emptyTrashBtn.addEventListener('click', async function () {
          if (!window.confirm('Permanently delete all items in trash?')) return;
          await S.emptyTrash();
          toast('Trash emptied');
          closeSheet();
          refresh();
        });
      }

      $('#set-change-pass', sheet).addEventListener('click', openChangeMasterPassword);
      $('#set-export', sheet).addEventListener('click', openExport);
      $('#set-import', sheet).addEventListener('click', openImport);
      $('#set-install', sheet).addEventListener('click', function () {
        promptInstall();
      });
      $('#set-wipe', sheet).addEventListener('click', openWipe);
    });
  }

  function openChangeMasterPassword() {
    const html = '' +
      '<form class="sheet-form" id="chg-form" autocomplete="off" novalidate>' +
        sheetHead('Change master password', 'lock') +
        '<p class="sheet-sub" style="margin-top:-8px">Your entries stay the same — they get re-encrypted with a new key. Backups you made earlier still need the <strong>old</strong> password to open.</p>' +
        '<label class="field"><span class="field-label">Current password</span>' +
          '<input id="chg-current" type="password" autocomplete="current-password" placeholder="Current master password">' +
        '</label>' +
        '<label class="field"><span class="field-label">New password</span>' +
          '<input id="chg-new" type="password" autocomplete="new-password" placeholder="At least 8 characters">' +
        '</label>' +
        '<label class="field"><span class="field-label">Confirm new password</span>' +
          '<input id="chg-confirm" type="password" autocomplete="new-password" placeholder="Repeat new password">' +
        '</label>' +
        '<p class="form-error hidden" id="chg-error" role="alert"></p>' +
        '<div class="sheet-actions">' +
          '<button type="button" class="btn ghost" data-close>Cancel</button>' +
          '<button type="submit" class="btn primary">Update password</button>' +
        '</div>' +
      '</form>';

    openSheet('change-password', html, function (sheet) {
      $('#chg-form', sheet).addEventListener('submit', async function (event) {
        event.preventDefault();
        const errEl = $('#chg-error', sheet);
        const current = $('#chg-current', sheet).value;
        const next = $('#chg-new', sheet).value;
        const confirm = $('#chg-confirm', sheet).value;

        function fail(msg) {
          errEl.textContent = msg;
          errEl.classList.remove('hidden');
        }
        errEl.classList.add('hidden');
        if (next.length < 8) return fail('The new password needs at least 8 characters.');
        if (next !== confirm) return fail('The new passwords do not match.');
        if (C.estimateEntropyBits(next) < 45) return fail('That new password is too easy to guess.');

        const result = await S.changeMasterPassword(current, next);
        if (!result.ok) {
          if (result.reason === 'bad-password') return fail('Current password is incorrect.');
          return fail('Could not change the password. Try again.');
        }
        closeSheet();
        toast('Master password updated');
      });
    });
  }

  /* ---------- export ---------- */

  function downloadFile(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1200);
    return blob;
  }

  function openExport() {
    let backup;
    try {
      backup = S.exportBackup();
    } catch (err) {
      toast('Could not create the backup', 'err');
      return;
    }

    const canShare = !!(navigator.canShare && window.File);
    const html = '' +
      '<div class="sheet-form">' +
        sheetHead('Export backup', 'download') +
        '<p class="sheet-sub" style="margin-top:-8px">' +
          'A single file with all <strong>' + backup.entryCount + '</strong> ' +
          (backup.entryCount === 1 ? 'entry' : 'entries') +
          ', encrypted with your master password. Without that password the file is unreadable — that is what makes it safe to email or upload.</p>' +
        '<div class="kv-row" style="margin-bottom:4px">' +
          '<div class="kv-label">File name</div>' +
          '<div class="kv-text" style="font-family:var(--mono);font-size:13px">' + esc(backup.filename) + '</div>' +
        '</div>' +
        '<div class="gen-actions" style="flex-direction:column;margin-top:6px">' +
          '<button class="btn primary" id="exp-download">' + icon('download') + 'Download backup file</button>' +
          (canShare ? '<button class="btn ghost" id="exp-share">' + icon('upload') + 'Share to another app</button>' : '') +
          '<button class="btn ghost" id="exp-copy">' + icon('copy') + 'Copy backup text</button>' +
        '</div>' +
        '<p class="hint" style="margin-top:14px">To move phones: export here → send the file to your new phone (WhatsApp, Drive, AirDrop, USB) → install Keyring there → Settings → Import backup.</p>' +
      '</div>';

    openSheet('export', html, function (sheet) {
      $('#exp-download', sheet).addEventListener('click', function () {
        downloadFile(backup.filename, backup.json, 'application/json');
        toast('Backup downloaded');
      });

      const shareBtn = $('#exp-share', sheet);
      if (shareBtn) {
        shareBtn.addEventListener('click', async function () {
          try {
            const file = new File([backup.json], backup.filename, { type: 'application/json' });
            if (navigator.canShare({ files: [file] })) {
              await navigator.share({
                files: [file],
                title: 'Keyring backup',
                text: 'Encrypted Keyring vault backup',
              });
              return;
            }
            throw new Error('share unsupported');
          } catch (err) {
            downloadFile(backup.filename, backup.json, 'application/json');
            toast('Sharing unavailable — downloaded instead');
          }
        });
      }

      $('#exp-copy', sheet).addEventListener('click', function () {
        copyText(backup.json, 'Backup', { secret: false });
      });
    });
  }

  /* ---------- import ---------- */

  function openImport(presetText, presetName) {
    const html = '' +
      '<form class="sheet-form" id="imp-form" autocomplete="off" novalidate>' +
        sheetHead('Import passwords', 'upload') +
        '<p class="sheet-sub" style="margin-top:-8px">Select an encrypted Keyring backup (.json) or an unencrypted CSV export from Chrome, Firefox, Bitwarden, or 1Password.</p>' +
        '<label class="field">' +
          '<span class="field-label">File (.json or .csv)</span>' +
          '<input id="imp-file" type="file" accept=".json,.csv,application/json,text/csv,text/plain">' +
        '</label>' +
        '<label class="field">' +
          '<span class="field-label">…or paste text</span>' +
          '<textarea id="imp-text" rows="3" placeholder="Paste .json backup or .csv content" spellcheck="false">' + esc(presetText || '') + '</textarea>' +
        '</label>' +
        '<label class="field" id="imp-pass-field">' +
          '<span class="field-label">Backup password (only for .json backups)</span>' +
          '<input id="imp-pass" type="password" placeholder="Master password of the backup" autocomplete="off" spellcheck="false">' +
        '</label>' +
        '<label class="field">' +
          '<span class="field-label">How to bring it in</span>' +
          '<select id="imp-mode">' +
            '<option value="merge">Merge — keep existing entries, add new ones</option>' +
            '<option value="replace">Replace — wipe this vault and use the backup</option>' +
          '</select>' +
        '</label>' +
        '<p class="form-error hidden" id="imp-error" role="alert"></p>' +
        '<div class="sheet-actions">' +
          '<button type="button" class="btn ghost" data-close>Cancel</button>' +
          '<button type="submit" class="btn primary" id="imp-submit">Import</button>' +
        '</div>' +
      '</form>';

    openSheet('import', html, function (sheet) {
      const fileInput = $('#imp-file', sheet);
      const textArea = $('#imp-text', sheet);
      const passField = $('#imp-pass-field', sheet);
      const errEl = $('#imp-error', sheet);

      function checkFormat() {
        const val = textArea.value.trim();
        const isCsv = !val.startsWith('{') && val.includes(',') && val.includes('\n');
        if (isCsv) {
          if (passField) passField.classList.add('hidden');
          errEl.textContent = 'Detected unencrypted CSV file. Passwords will be encrypted into your Keyring vault.';
          errEl.style.color = 'var(--accent-2)';
          errEl.classList.remove('hidden');
        } else {
          if (passField) passField.classList.remove('hidden');
          errEl.style.color = '';
          errEl.classList.add('hidden');
        }
      }

      if (presetName) textArea.setAttribute('data-filename', presetName);
      textArea.addEventListener('input', checkFormat);

      fileInput.addEventListener('change', function () {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function () {
          textArea.value = String(reader.result || '');
          textArea.setAttribute('data-filename', file.name);
          checkFormat();
          if (textArea.value.trim().startsWith('{')) {
            const parsed = S.parseBackup(textArea.value);
            if (!parsed.ok) {
              errEl.textContent = parsed.reason === 'version'
                ? 'That backup was made by a newer version of Keyring.'
                : 'That file does not look like a Keyring backup.';
              errEl.classList.remove('hidden');
            }
          }
        };
        reader.readAsText(file);
      });

      $('#imp-form', sheet).addEventListener('submit', async function (event) {
        event.preventDefault();
        const btn = $('#imp-submit', sheet);
        const text = textArea.value;
        const password = $('#imp-pass', sheet).value;
        const mode = $('#imp-mode', sheet).value;

        function fail(msg) {
          errEl.textContent = msg;
          errEl.style.color = '';
          errEl.classList.remove('hidden');
        }

        errEl.classList.add('hidden');
        errEl.style.color = '';
        const trimmed = text.trim();
        if (!trimmed) return fail('Choose a file or paste its contents.');

        const isCsv = !trimmed.startsWith('{') && trimmed.includes(',') && trimmed.includes('\n');
        if (isCsv) {
          if (mode === 'replace' && !window.confirm('Replace mode erases the current vault contents. Continue?')) return;
          btn.disabled = true;
          btn.textContent = 'Importing CSV…';
          const result = await S.importCSV(trimmed, mode);
          btn.disabled = false;
          btn.textContent = 'Import';
          if (!result.ok) {
            return fail('Could not parse CSV. Ensure it has header columns like name, username, password.');
          }
          closeSheet();
          toast(mode === 'replace'
            ? 'Vault replaced from CSV — ' + result.imported + ' entries'
            : result.imported + ' imported from CSV · ' + result.skipped + ' skipped');
          state.filter = 'all';
          state.search = '';
          $('#search').value = '';
          $('#search-clear').classList.add('hidden');
          refresh();
          return;
        }

        if (!password) return fail('Enter the password that was used for this backup.');
        if (mode === 'replace' && !window.confirm('Replace mode erases the current vault contents. Continue?')) return;

        btn.disabled = true;
        btn.textContent = 'Decrypting…';
        const result = await S.importBackup(text, password, mode);
        btn.disabled = false;
        btn.textContent = 'Import';

        if (!result.ok) {
          if (result.reason === 'bad-password') return fail('That password does not open this backup.');
          if (result.reason === 'not-backup' || result.reason === 'not-json') {
            return fail('This does not look like a Keyring backup file.');
          }
          if (result.reason === 'version') return fail('Backup made with a newer version of Keyring.');
          return fail('Import failed. The file may be damaged.');
        }

        closeSheet();
        toast(mode === 'replace'
          ? 'Vault replaced — ' + result.imported + ' entries'
          : result.imported + ' imported · ' + result.skipped + ' skipped as duplicates');
        state.filter = 'all';
        state.search = '';
        $('#search').value = '';
        $('#search-clear').classList.add('hidden');
        refresh();
      });
    });
  }

  /* ---------- wipe ---------- */

  function openWipe() {
    const html = '' +
      '<form class="sheet-form" id="wipe-form" autocomplete="off" novalidate>' +
        '<div class="confirm">' +
          '<div class="confirm-icon">' + icon('alert') + '</div>' +
          '<h2>Erase the whole vault?</h2>' +
          '<p>Every password on this device will be deleted permanently. If you have not exported a backup, there is no way back.</p>' +
        '</div>' +
        '<label class="field">' +
          '<span class="field-label">Type DELETE to confirm</span>' +
          '<input id="wipe-confirm" type="text" placeholder="DELETE" autocapitalize="characters" spellcheck="false">' +
        '</label>' +
        '<p class="form-error hidden" id="wipe-error" role="alert"></p>' +
        '<div class="sheet-actions">' +
          '<button type="button" class="btn ghost" data-close>Cancel</button>' +
          '<button type="submit" class="btn danger solid" id="wipe-go">Erase everything</button>' +
        '</div>' +
      '</form>';

    openSheet('wipe', html, function (sheet) {
      $('#wipe-form', sheet).addEventListener('submit', async function (event) {
        event.preventDefault();
        const value = $('#wipe-confirm', sheet).value.trim();
        const errEl = $('#wipe-error', sheet);
        if (value !== 'DELETE') {
          errEl.textContent = 'Type DELETE (in capitals) to confirm.';
          errEl.classList.remove('hidden');
          return;
        }
        await S.wipeAll();
        closeSheet(true);
        showSetup();
        toast('Vault erased from this device');
      });
    });
  }

  /* ==========================================================
     8. auto-lock
     ========================================================== */

  let idleInterval = null;

  function startIdleWatch() {
    stopIdleWatch();
    state.lastActivity = Date.now();
    idleInterval = setInterval(checkIdle, 5000);
  }

  function stopIdleWatch() {
    if (idleInterval) { clearInterval(idleInterval); idleInterval = null; }
  }

  function checkIdle() {
    if (!S.isUnlocked()) return;
    const minutes = S.getSettings().autoLockMinutes;
    if (!minutes) return;
    if (Date.now() - state.lastActivity > minutes * 60 * 1000) {
      lockVault(true);
    }
  }

  function noteActivity() {
    state.lastActivity = Date.now();
  }

  /* ==========================================================
     9. PWA glue
     ========================================================== */

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
  }

  function applyStorageNotice() {
    const kind = S.getStorageKind();
    const banner = $('#banner');
    if (!banner) return false;

    if (kind === 'no-crypto') {
      banner.className = 'banner err';
      banner.innerHTML = '<strong>Encryption unavailable.</strong> This page is not a secure context, ' +
        'so the browser will not run WebCrypto. Open Keyring over https — or from the hosted preview / installed app.';
      banner.classList.remove('hidden');
      return true;
    }

    if (kind === 'memory') {
      banner.className = 'banner';
      banner.innerHTML = '<strong>Preview mode — not saved.</strong> This window blocks local storage, so the vault ' +
        'lives in memory only and disappears when you reload. Open Keyring in a normal browser tab (or install it) to keep your passwords.';
      banner.classList.remove('hidden');
      return true;
    }

    return false;
  }

  function maybeShowInstallBanner() {
    const settings = S.getSettings();
    if (isStandalone() || settings.installBannerDismissed) return;

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    const banner = $('#banner');
    const hasPrompt = !!(window.KeyringPWA && window.KeyringPWA.getInstallEvent());

    if (hasPrompt) {
      banner.innerHTML = '<div style="display:flex;align-items:center;gap:10px;justify-content:space-between">' +
        '<span><strong>Install Keyring</strong> — full-screen, offline, on your home screen.</span>' +
        '<span style="display:flex;gap:6px;flex:none">' +
          '<button class="btn small primary" id="banner-install">Install</button>' +
          '<button class="icon-btn" id="banner-dismiss" aria-label="Dismiss">' + icon('x') + '</button>' +
        '</span></div>';
      banner.classList.remove('hidden');
      $('#banner-install').addEventListener('click', promptInstall);
      $('#banner-dismiss').addEventListener('click', dismissBanner);
    } else if (isIOS) {
      banner.innerHTML = '<div style="display:flex;align-items:center;gap:10px;justify-content:space-between">' +
        '<span><strong>Install on iPhone:</strong> tap the Share button, then “Add to Home Screen”.</span>' +
        '<button class="icon-btn" id="banner-dismiss" aria-label="Dismiss">' + icon('x') + '</button></div>';
      banner.classList.remove('hidden');
      $('#banner-dismiss').addEventListener('click', dismissBanner);
    }
  }

  function dismissBanner() {
    $('#banner').classList.add('hidden');
    S.updateSettings({ installBannerDismissed: true }).catch(function () { /* ignore */ });
  }

  async function promptInstall() {
    const evt = window.KeyringPWA ? window.KeyringPWA.getInstallEvent() : null;

    if (evt) {
      if (window.KeyringPWA) window.KeyringPWA.clearInstallEvent();
      evt.prompt();
      try {
        const choice = await evt.userChoice;
        if (choice && choice.outcome === 'accepted') toast('Installing Keyring…');
      } catch (err) { /* user dismissed */ }
      refreshInstallButton();
      return;
    }

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    const steps = isIOS
      ? '<ol style="padding-left:18px;margin:8px 0 0;display:flex;flex-direction:column;gap:8px">' +
          '<li>Open Keyring in <strong>Safari</strong> (not inside another app).</li>' +
          '<li>Tap the <strong>Share</strong> icon in the toolbar.</li>' +
          '<li>Scroll and choose <strong>Add to Home Screen</strong>.</li>' +
          '<li>Tap <strong>Add</strong> — Keyring opens full-screen and offline.</li>' +
        '</ol>'
      : '<ol style="padding-left:18px;margin:8px 0 0;display:flex;flex-direction:column;gap:8px">' +
          '<li>Open the browser menu (⋮).</li>' +
          '<li>Choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li>' +
          '<li>Confirm — Keyring gets its own icon and works offline.</li>' +
        '</ol>';

    const html = '<div class="sheet-form">' +
      sheetHead('Install Keyring', 'download') +
      '<p class="sheet-sub" style="margin-top:-8px">Installing gives you a full-screen app with its own icon that works with no internet.</p>' +
      '<div class="kv-row"><div class="kv-text">' + steps + '</div></div>' +
      '<div class="sheet-actions"><button type="button" class="btn primary" data-close>Got it</button></div>' +
    '</div>';

    openSheet('install', html);
  }

  function refreshInstallButton() {
    const btn = $('#btn-install');
    if (!btn) return;
    if (isStandalone()) {
      btn.classList.add('hidden');
      return;
    }
    btn.classList.remove('hidden');
  }

  /* ==========================================================
     10. events + boot
     ========================================================== */

  function bindEvents() {
    /* gate */
    $('#setup-form').addEventListener('submit', handleSetup);
    $('#unlock-form').addEventListener('submit', handleUnlock);

    const setupPass = $('#setup-password');
    const setupStrength = $('#setup-strength');
    setupPass.addEventListener('input', function () { renderStrength(setupPass, setupStrength); });

    /* password visibility toggles (delegated so dynamic sheets work) */
    document.addEventListener('click', function (event) {
      const toggle = event.target.closest('[data-toggle-pass]');
      if (!toggle) return;
      const input = document.getElementById(toggle.getAttribute('data-toggle-pass'));
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.innerHTML = icon(show ? 'eye-off' : 'eye');
      toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });

    /* app chrome */
    $('#btn-settings').addEventListener('click', openSettings);
    $('#btn-generator').addEventListener('click', function () { openGenerator({}); });
    $('#btn-lock').addEventListener('click', function () { lockVault(false); });
    $('#btn-install').addEventListener('click', promptInstall);
    $('#fab').addEventListener('click', function () { openEntryForm(null); });
    $('#empty-cta').addEventListener('click', function () { openEntryForm(null); });

    /* search */
    const searchEl = $('#search');
    searchEl.addEventListener('input', function () {
      state.search = searchEl.value;
      $('#search-clear').classList.toggle('hidden', !searchEl.value);
      renderList();
    });
    $('#search-clear').addEventListener('click', function () {
      searchEl.value = '';
      state.search = '';
      $('#search-clear').classList.add('hidden');
      renderList();
      searchEl.focus();
    });

    /* chips + sort */
    $('#chips').addEventListener('click', function (event) {
      const chip = event.target.closest('[data-filter]');
      if (!chip) return;
      state.filter = chip.getAttribute('data-filter');
      renderChips();
      renderList();
    });

    $('#sort-btn').addEventListener('click', function () {
      const order = ['recent', 'az', 'category'];
      const next = order[(order.indexOf(state.sort) + 1) % order.length];
      state.sort = next;
      S.updateSettings({ sortMode: next }).catch(function () { /* ignore */ });
      renderChips();
      renderList();
    });

    /* list delegation */
    $('#list').addEventListener('click', async function (event) {
      const card = event.target.closest('.card');
      if (!card) return;
      const id = card.getAttribute('data-id');
      const actionEl = event.target.closest('[data-action]');
      if (!actionEl) return;
      const action = actionEl.getAttribute('data-action');
      const entry = S.getEntry(id);
      if (!entry) { refresh(); return; }

      if (action === 'open') openDetail(id);
      if (action === 'fav') {
        const updated = await S.toggleFavorite(id);
        if (updated) { refresh(); toast(updated.favorite ? 'Added to favorites' : 'Removed from favorites'); }
      }
      if (action === 'copy-user') {
        if (!entry.username) { toast('No username saved on this entry', 'err'); return; }
        copyText(entry.username, 'Username', { secret: false });
      }
      if (action === 'copy-pass') {
        if (!entry.password) { toast('No password saved on this entry', 'err'); return; }
        copyText(entry.password, 'Password', { secret: true });
      }
      if (action === 'edit') openEntryForm(entry);
      if (action === 'delete') confirmDelete(id);
    });

    $('#list').addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const main = event.target.closest('.card-main');
      if (!main) return;
      event.preventDefault();
      const card = event.target.closest('.card');
      if (card) openDetail(card.getAttribute('data-id'));
    });

    /* overlay */
    overlay().addEventListener('click', function (event) {
      if (event.target === overlay()) closeSheet();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        if (!overlay().classList.contains('hidden')) closeSheet();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        if (S.isUnlocked()) {
          event.preventDefault();
          $('#search').focus();
        }
      }
    });

    /* activity tracking for auto-lock */
    ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(function (evt) {
      document.addEventListener(evt, noteActivity, { passive: true });
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        state.hiddenAt = Date.now();
      } else {
        if (state.hiddenAt && S.isUnlocked()) {
          const minutes = S.getSettings().autoLockMinutes;
          if (minutes && Date.now() - state.hiddenAt > minutes * 60 * 1000) {
            lockVault(true);
          }
        }
        state.hiddenAt = null;
        noteActivity();
      }
    });

    window.addEventListener('beforeunload', function () {
      // Key is memory-only; nothing to purge on disk. Drop references anyway.
      S.lock();
    });

    window.addEventListener('online', function () {
      // Offline-first: nothing to sync, but avoids a confusing stale banner
      const banner = $('#banner');
      if (banner && /offline/i.test(banner.textContent || '')) banner.classList.add('hidden');
    });

    window.addEventListener('offline', function () {
      if (!S.isUnlocked()) return;
      const banner = $('#banner');
      banner.innerHTML = 'You are offline — that is fine, Keyring never needs the internet.';
      banner.classList.remove('hidden');
    });
  }

  function boot() {
    S.storageAvailable();
    applyStorageNotice();

    bindEvents();

    if (S.hasVault()) {
      showUnlock();
    } else {
      showSetup();
    }

    if (window.KeyringPWA) window.KeyringPWA.register();
    refreshInstallButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* expose a small surface for the PWA glue and debugging */
  window.KeyringApp = {
    lock: lockVault,
    refresh: refresh,
    toast: toast,
    openImport: openImport,
    openSettings: openSettings,
    isStandalone: isStandalone,
    onInstallAvailable: function () {
      refreshInstallButton();
      if (S.isUnlocked()) maybeShowInstallBanner();
    },
  };
})();
