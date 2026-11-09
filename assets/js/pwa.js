/* ============================================================
   Keyring — PWA glue
   Captures the install prompt, registers the service worker,
   and exposes a tiny API the app layer can use.
   ============================================================ */

window.KeyringPWA = (function () {
  'use strict';

  let installEvent = null;

  function isStandalone() {
    const mm = window.matchMedia ? window.matchMedia('(display-mode: standalone)').matches : false;
    return mm || window.navigator.standalone === true;
  }

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    installEvent = event;
    if (window.KeyringApp && window.KeyringApp.onInstallAvailable) {
      window.KeyringApp.onInstallAvailable();
    }
  });

  window.addEventListener('appinstalled', function () {
    installEvent = null;
    if (window.KeyringApp) {
      if (window.KeyringApp.toast) window.KeyringApp.toast('Keyring installed on this device');
      if (window.KeyringApp.onInstallAvailable) window.KeyringApp.onInstallAvailable();
    }
  });

  function register() {
    // The standalone single-file build has no sw.js next to it
    if (window.KEYRING_STANDALONE) return;
    if (!('serviceWorker' in navigator)) return;
    if (!/^https?:$/.test(location.protocol)) return;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (err) {
        console.warn('[keyring] service worker registration failed', err);
      });
    });
  }

  return {
    getInstallEvent: function () { return installEvent; },
    clearInstallEvent: function () { installEvent = null; },
    isStandalone: isStandalone,
    register: register,
  };
})();
