'use strict';

const api = window.certiorari;

// ---- app state ------------------------------------------------------------
let certsCache = [];
let currentUrl = '';
let currentCert = null; // { thumbprint, serialNumber, label }
let partitionSeq = 0; // bumps each time we need a fresh TLS session
let pickerResolve = null; // set while the picker modal is open
let unlockTarget = null; // cert being edited in the unlock modal

// ---- element helpers ------------------------------------------------------
const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');

function switchView(which) {
  $('view-start').classList.toggle('active', which === 'start');
  $('view-browser').classList.toggle('active', which === 'browser');
}

function normalizeUrl(input) {
  let u = (input || '').trim();
  if (!u) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
  try {
    return new URL(u).toString();
  } catch {
    return '';
  }
}

// ===========================================================================
//  START VIEW
// ===========================================================================
(async function initStart() {
  const last = await api.getLastUrl();
  $('url-input').value = last || ''; // autopopulate last URL, default empty
  $('url-input').focus();
})();

$('url-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('start-error').textContent = '';
  const url = normalizeUrl($('url-input').value);
  if (!url) {
    $('start-error').textContent = 'Please enter a valid URL.';
    return;
  }
  currentUrl = url;
  await api.setLastUrl(url);

  const cert = await openPicker();
  if (!cert) return; // user cancelled
  await applyCertAndBrowse(cert, url, true);
});

// ===========================================================================
//  CERT PICKER
// ===========================================================================
async function openPicker() {
  show($('picker-modal'));
  $('picker-search').value = '';
  $('picker-search').focus();
  await loadCerts();
  renderPicker('');
  return new Promise((resolve) => {
    pickerResolve = resolve;
  });
}

function closePicker(result) {
  hide($('picker-modal'));
  const r = pickerResolve;
  pickerResolve = null;
  if (r) r(result || null);
}

async function loadCerts() {
  try {
    const all = await api.listCerts(currentUrl);
    // Only show certificates that are still valid (notAfter in the future).
    const now = Date.now();
    certsCache = all.filter((c) => !c.notAfter || new Date(c.notAfter).getTime() > now);
  } catch (err) {
    certsCache = [];
    console.error('listCerts failed', err);
  }
  $('picker-empty').classList.toggle('hidden', certsCache.length > 0);
}

function renderPicker(filter) {
  const list = $('picker-list');
  list.innerHTML = '';

  // Full-text, case-insensitive search. The haystack is the full Subject DN
  // (plus the visible label/sub-line so what you SEE is also searchable).
  // Multiple whitespace-separated terms must ALL match (AND), so you can narrow
  // 50 look-alikes with e.g. "acme 2026".
  const tokens = (filter || '').toLowerCase().split(/\s+/).filter(Boolean);
  const matches = certsCache.filter((c) => {
    if (!tokens.length) return true;
    const haystack = `${c.subject} ${c.label} ${c.sublabel}`.toLowerCase();
    return tokens.every((t) => haystack.includes(t));
  });

  for (const c of matches) {
    const row = document.createElement('div');
    row.className = 'cert-row';
    if (currentCert && currentCert.thumbprint === c.thumbprint) row.classList.add('selected');

    const main = document.createElement('div');
    main.className = 'cr-main';
    const label = document.createElement('div');
    label.className = 'cr-label';
    label.innerHTML = highlight(c.label, tokens);
    const sub = document.createElement('div');
    sub.className = 'cr-sub';
    sub.innerHTML = highlight(c.sublabel, tokens);
    main.appendChild(label);
    main.appendChild(sub);

    // Expiration section — colored by urgency, hover shows days remaining.
    const exp = expiryBadge(c.notAfter);

    // Per-cert password affordance (advanced / .pfx path; see README).
    const pw = document.createElement('button');
    pw.className = 'cr-pw';
    pw.textContent = '🔒';
    pw.title = 'Set / save a password for this certificate';
    pw.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openUnlock(c);
    });
    api.secret.has(c.thumbprint).then((has) => {
      if (has) {
        pw.classList.add('saved');
        pw.textContent = '🔑';
        pw.title = 'A password is saved for this certificate';
      }
    });

    row.appendChild(main);
    row.appendChild(exp);
    row.appendChild(pw);
    row.addEventListener('click', () => closePicker(c));
    list.appendChild(row);
  }

  // Result count + empty / no-match states.
  const total = certsCache.length;
  const count = $('picker-count');
  if (!total) {
    count.textContent = '';
  } else if (tokens.length) {
    count.textContent = `${matches.length} of ${total} match`;
  } else {
    count.textContent = `${total} certificate${total === 1 ? '' : 's'}`;
  }
  $('picker-nomatch').classList.toggle('hidden', !(total && matches.length === 0));
  $('picker-clear').classList.toggle('hidden', !(filter && filter.length));
}

// Escape cert text for safe innerHTML, then wrap search hits in <mark>.
// Subjects come from the cert store, so escaping here prevents HTML injection.
function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])
  );
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function highlight(text, tokens) {
  const safe = escapeHtml(text || '');
  if (!tokens || !tokens.length) return safe;
  const re = new RegExp('(' + tokens.map(escapeRegExp).join('|') + ')', 'gi');
  return safe.replace(re, '<mark>$1</mark>');
}

// Build the expiration badge for a row. Color thresholds (days until notAfter):
//   > 30  green · 8–30  yellow · <= 7  red.   Hover shows the day count.
function expiryBadge(notAfter) {
  const el = document.createElement('div');
  el.className = 'cr-exp';
  if (!notAfter) {
    el.textContent = '—';
    return el;
  }
  const when = new Date(notAfter);
  const days = Math.ceil((when.getTime() - Date.now()) / 86400000);
  const level = days <= 7 ? 'danger' : days <= 30 ? 'warn' : 'ok';
  el.classList.add(`cr-exp-${level}`);
  el.textContent = when.toLocaleDateString();
  el.title = days === 1 ? '1 day until expiration' : `${days} days until expiration`;
  return el;
}

$('picker-search').addEventListener('input', (e) => renderPicker(e.target.value));
$('picker-clear').addEventListener('click', () => {
  const s = $('picker-search');
  s.value = '';
  renderPicker('');
  s.focus();
});
$('picker-close').addEventListener('click', () => closePicker(null));
$('picker-modal').addEventListener('click', (e) => {
  if (e.target === $('picker-modal')) closePicker(null);
});
$('picker-edit-mappings').addEventListener('click', () => api.mappings.openEditor(currentUrl));

// When the mappings editor saves, re-resolve labels live if the picker is open.
api.onMappingsChanged(async () => {
  if (pickerResolve && !$('picker-modal').classList.contains('hidden')) {
    await loadCerts();
    renderPicker($('picker-search').value);
  }
});

// ===========================================================================
//  APPLY CERT + BROWSE
// ===========================================================================
async function applyCertAndBrowse(cert, url, freshSession) {
  currentCert = {
    thumbprint: cert.thumbprint,
    serialNumber: cert.serialNumber,
    label: cert.label,
  };
  $('cert-btn-label').textContent = cert.label;

  // Tell main which cert to present for this host during the handshake.
  await api.setCertForUrl(url, currentCert);

  switchView('browser');
  if (freshSession) {
    mountWebview(url); // fresh partition => guaranteed new TLS handshake
  }
}

// Recreate the <webview> with a brand-new in-memory partition. This is what
// forces Chromium to renegotiate TLS (and thus re-fire select-client-certificate)
// so a newly chosen cert actually takes effect.
function mountWebview(url) {
  const container = $('browser-container');
  container.innerHTML = '';

  const wv = document.createElement('webview');
  wv.setAttribute('partition', `clientcert-${++partitionSeq}`); // no 'persist:' => in-memory
  wv.setAttribute('allowpopups', 'true');
  wv.setAttribute('src', url);
  container.appendChild(wv);

  wv.addEventListener('did-start-loading', () => setStatus('Loading…'));
  wv.addEventListener('did-stop-loading', () => setStatus(''));
  wv.addEventListener('did-navigate', () => {
    $('addr-input').value = wv.getURL();
  });
  wv.addEventListener('did-navigate-in-page', () => {
    $('addr-input').value = wv.getURL();
  });
  wv.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3) return; // -3 == aborted, ignore
    setStatus(`Failed to load: ${e.errorDescription} (${e.errorCode})`);
  });

  $('addr-input').value = url;
}

function currentWebview() {
  return $('browser-container').querySelector('webview');
}

function setStatus(text) {
  $('status').textContent = text;
}

// ---- toolbar actions ------------------------------------------------------
$('home-btn').addEventListener('click', () => {
  switchView('start');
  $('url-input').focus();
});
$('back-btn').addEventListener('click', () => {
  const wv = currentWebview();
  if (wv && wv.canGoBack()) wv.goBack();
});
$('reload-btn').addEventListener('click', () => {
  const wv = currentWebview();
  if (wv) wv.reload();
});

$('addr-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = normalizeUrl($('addr-input').value);
  if (!url) return;
  currentUrl = url;
  // Keep using the same chosen cert on whatever host we navigate to.
  if (currentCert) await api.setCertForUrl(url, currentCert);
  const wv = currentWebview();
  if (wv) wv.loadURL(url);
});

// "Change certificate" — re-pick, then remount with a fresh session so the new
// cert is applied and the page reloads automatically.
$('cert-btn').addEventListener('click', async () => {
  const cert = await openPicker();
  if (!cert) return;
  await applyCertAndBrowse(cert, currentUrl, false);
  mountWebview(currentUrl); // fresh partition => new handshake with new cert
});

// ---- cert-applied feedback from main --------------------------------------
api.onCertApplied((p) => {
  const banner = $('cert-banner');
  if (p.ok) {
    banner.className = 'banner ok';
    banner.textContent = `Using certificate: ${p.label}`;
    show(banner);
    setTimeout(() => hide(banner), 2500);
  } else {
    banner.className = 'banner';
    banner.textContent = p.reason || 'Certificate was not accepted by the server.';
    show(banner);
  }
});

// ===========================================================================
//  UNLOCK / SAVE PASSWORD MODAL  (advanced / .pfx path)
// ===========================================================================
async function openUnlock(cert) {
  unlockTarget = cert;
  $('unlock-cert-label').textContent = cert.label;
  $('unlock-pw').value = '';
  $('unlock-remember').checked = false;

  const available = await api.secret.available();
  const has = await api.secret.has(cert.thumbprint);
  const note = $('unlock-saved-note');
  if (!available) {
    note.textContent = 'Secure storage is unavailable on this system; passwords cannot be saved.';
    show(note);
  } else if (has) {
    note.textContent = 'A password is already saved for this certificate.';
    show(note);
  } else {
    hide(note);
  }
  $('unlock-forget').classList.toggle('hidden', !has);

  show($('unlock-modal'));
  $('unlock-pw').focus();
}

function closeUnlock() {
  hide($('unlock-modal'));
  unlockTarget = null;
}

$('unlock-close').addEventListener('click', closeUnlock);
$('unlock-modal').addEventListener('click', (e) => {
  if (e.target === $('unlock-modal')) closeUnlock();
});

$('unlock-save').addEventListener('click', async () => {
  if (!unlockTarget) return;
  const pw = $('unlock-pw').value;
  const remember = $('unlock-remember').checked;
  // NOTE: For store certs, Windows owns the native unlock prompt — saving here
  // only feeds the .pfx/local-proxy path. We never store plaintext: secret.set
  // encrypts via DPAPI (see secrets.js).
  if (remember && pw) {
    await api.secret.set(unlockTarget.thumbprint, pw);
  }
  closeUnlock();
  if (pickerResolve) renderPicker($('picker-search').value); // refresh the 🔑 indicator
});

$('unlock-forget').addEventListener('click', async () => {
  if (!unlockTarget) return;
  await api.secret.forget(unlockTarget.thumbprint);
  closeUnlock();
  if (pickerResolve) renderPicker($('picker-search').value);
});

// Esc closes whichever modal is open.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('unlock-modal').classList.contains('hidden')) return closeUnlock();
  if (!$('picker-modal').classList.contains('hidden')) return closePicker(null);
});
