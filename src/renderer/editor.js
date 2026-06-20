'use strict';

const api = window.certiorari;
const $ = (id) => document.getElementById(id);

let GLOBAL = '*';
let currentOrigin = '';
let buckets = {}; // { key: rules[] }
let selectedKey = GLOBAL;
let rules = []; // working copy for selectedKey
let dirty = false;
let test = { subject: '', issuer: '' };

const EXAMPLE = {
  label: 'Example — Bob Enterprises cert',
  subject: 'CN=jdoe, OU=Engineering, OU=Platform, OU=US-East, OU=Region, OU=HELLOWORLD, O=Acme, C=US',
  issuer: 'CN=Bob Enterprises',
};

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

function setDirty(v) {
  dirty = v;
  $('dirty').textContent = v ? '● unsaved changes' : '';
}

// --------------------------------------------------------------------------
async function init() {
  const url = new URLSearchParams(location.search).get('url') || '';
  [GLOBAL, currentOrigin] = await Promise.all([api.mappings.globalKey(), api.mappings.canonicalize(url)]);
  buckets = await api.mappings.getAll();

  selectedKey = currentOrigin && currentOrigin !== GLOBAL ? currentOrigin : GLOBAL;
  populateBuckets();
  loadBucket(selectedKey);

  await loadTestCerts();
  wireEvents();
}

function populateBuckets() {
  const sel = $('bucket-select');
  sel.innerHTML = '';

  const add = (value, text) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    sel.appendChild(o);
  };

  add(GLOBAL, '★ All sites (default)');
  if (currentOrigin && currentOrigin !== GLOBAL) add(currentOrigin, `${currentOrigin}  (this site)`);
  Object.keys(buckets)
    .filter((k) => k !== GLOBAL && k !== currentOrigin)
    .sort()
    .forEach((k) => add(k, k));
  add('__add__', '＋ Add a site…');

  sel.value = selectedKey;
}

function loadBucket(key) {
  selectedKey = key;
  rules = (buckets[key] || []).map((r) => ({ issuer: r.issuer || '', template: r.template || '' }));
  setDirty(false);
  renderRules();
}

// --------------------------------------------------------------------------
function renderRules() {
  const list = $('rules-list');
  list.innerHTML = '';

  if (!rules.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No rules for this scope yet — add one, or labels fall back to CN - OU1 - OU2 …';
    list.appendChild(empty);
  }

  rules.forEach((rule, i) => {
    const card = document.createElement('div');
    card.className = 'rule-card';

    const head = document.createElement('div');
    head.className = 'rule-head';
    const badge = document.createElement('span');
    badge.className = 'rule-active hidden';
    badge.textContent = '✓ active';
    const rm = document.createElement('button');
    rm.className = 'icon-btn';
    rm.textContent = '✕';
    rm.title = 'Remove rule';
    rm.addEventListener('click', () => {
      rules.splice(i, 1);
      setDirty(true);
      renderRules();
    });
    head.appendChild(badge);
    head.appendChild(rm);

    const issuer = document.createElement('input');
    issuer.type = 'text';
    issuer.className = 'rule-issuer';
    issuer.placeholder = 'Issuer to match (e.g. CN=Bob Enterprises, or an issuer CN)';
    issuer.value = rule.issuer;
    issuer.addEventListener('input', () => {
      rule.issuer = issuer.value;
      setDirty(true);
      previewSoon();
    });

    const template = document.createElement('textarea');
    template.className = 'rule-template';
    template.rows = 2;
    template.spellcheck = false;
    template.placeholder = "{{ ou[0] }} - {{ ou[4] | skip: 5 }} - {{ ou[1] }}";
    template.value = rule.template;
    template.addEventListener('input', () => {
      rule.template = template.value;
      setDirty(true);
      previewSoon();
    });

    const preview = document.createElement('div');
    preview.className = 'rule-preview';
    preview.dataset.idx = String(i);

    card.appendChild(head);
    card.appendChild(issuer);
    card.appendChild(template);
    card.appendChild(preview);
    list.appendChild(card);
  });

  previewAll();
}

async function previewAll() {
  const cards = [...document.querySelectorAll('.rule-preview')];
  let firstMatch = -1;

  const results = await Promise.all(
    rules.map((r) =>
      api.mappings.preview({
        template: r.template,
        issuerKey: r.issuer,
        subject: test.subject,
        issuer: test.issuer,
      })
    )
  );

  results.forEach((res, i) => {
    if (res.matches && firstMatch === -1) firstMatch = i;
  });

  cards.forEach((el) => {
    const i = Number(el.dataset.idx);
    const res = results[i];
    const badge = el.parentElement.querySelector('.rule-active');
    badge.classList.toggle('hidden', i !== firstMatch);

    el.className = 'rule-preview';
    if (!res) {
      el.textContent = '';
    } else if (res.error) {
      el.classList.add('is-error');
      el.textContent = `⚠ ${res.error}`;
    } else if (!res.matches) {
      el.classList.add('is-muted');
      el.textContent = "issuer doesn't match the test cert";
    } else {
      el.classList.add('is-ok');
      el.textContent = `→ ${res.output || '(empty)'}`;
    }
  });
}
const previewSoon = debounce(previewAll, 250);

// --------------------------------------------------------------------------
async function loadTestCerts() {
  const sel = $('test-cert');
  sel.innerHTML = '';
  const optEx = document.createElement('option');
  optEx.value = 'example';
  optEx.textContent = EXAMPLE.label;
  sel.appendChild(optEx);

  let certs = [];
  try {
    certs = await api.listCerts('');
  } catch {
    certs = [];
  }
  certs.forEach((c, idx) => {
    const o = document.createElement('option');
    o.value = String(idx);
    o.textContent = c.subject || c.thumbprint;
    o._cert = c;
    sel.appendChild(o);
  });
  sel._certs = certs;

  applyTest('example');
}

function applyTest(which) {
  if (which === 'example') {
    test = { subject: EXAMPLE.subject, issuer: EXAMPLE.issuer };
  } else {
    const c = $('test-cert')._certs[Number(which)];
    test = { subject: c.subject || '', issuer: c.issuer || '' };
  }
  $('test-subject').value = test.subject;
  $('test-issuer').value = test.issuer;
  previewAll();
}

// --------------------------------------------------------------------------
function wireEvents() {
  $('bucket-select').addEventListener('change', (e) => {
    const v = e.target.value;
    if (v === '__add__') {
      e.target.value = selectedKey; // keep current selection visible
      $('new-site').classList.remove('hidden');
      $('new-site-add').classList.remove('hidden');
      $('new-site').focus();
      return;
    }
    if (dirty && !confirm('Discard unsaved changes to the current scope?')) {
      e.target.value = selectedKey;
      return;
    }
    loadBucket(v);
  });

  $('new-site-add').addEventListener('click', async () => {
    const origin = await api.mappings.canonicalize($('new-site').value);
    if (!origin) {
      alert('Enter a valid URL, e.g. https://site.example.com');
      return;
    }
    if (!buckets[origin]) buckets[origin] = [];
    $('new-site').value = '';
    $('new-site').classList.add('hidden');
    $('new-site-add').classList.add('hidden');
    selectedKey = origin;
    populateBuckets();
    loadBucket(origin);
  });

  $('add-rule').addEventListener('click', () => {
    rules.push({ issuer: '', template: '' });
    setDirty(true);
    renderRules();
  });

  $('save-btn').addEventListener('click', save);

  $('test-cert').addEventListener('change', (e) => applyTest(e.target.value));
  const onTestEdit = debounce(() => {
    test = { subject: $('test-subject').value, issuer: $('test-issuer').value };
    previewAll();
  }, 250);
  $('test-subject').addEventListener('input', onTestEdit);
  $('test-issuer').addEventListener('input', onTestEdit);
  
  // export/import
  $('export-btn').addEventListener('click', async () => {
    const str = await api.mappings.export();
    await navigator.clipboard.writeText(str);
    const oldText = $('export-btn').textContent;
    $('export-btn').textContent = 'Copied!';
    setTimeout(() => { $('export-btn').textContent = oldText; }, 2000);
  });

  const modal = $('import-modal');
  $('import-btn').addEventListener('click', () => {
    $('import-text').value = '';
    modal.classList.remove('hidden');
    $('import-text').focus();
  });
  
  const closeImport = () => modal.classList.add('hidden');
  $('import-close').addEventListener('click', closeImport);
  $('import-cancel').addEventListener('click', closeImport);

  $('import-confirm').addEventListener('click', async () => {
    const str = $('import-text').value.trim();
    if (!str) return;
    const replace = $('import-replace').checked;
    
    try {
      const ok = await api.mappings.import(str, replace);
      if (ok) {
        closeImport();
        // Reload everything
        buckets = await api.mappings.getAll();
        populateBuckets();
        loadBucket(selectedKey);
        const d = $('dirty');
        d.textContent = 'Imported ✓';
        setTimeout(() => { if (!dirty) d.textContent = ''; }, 2000);
      }
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    }
  });
}

async function save() {
  const saved = await api.mappings.setBucket(selectedKey, rules);
  buckets = await api.mappings.getAll();
  // keep selection if the bucket still exists, else fall back to global
  if (!buckets[selectedKey]) selectedKey = GLOBAL;
  populateBuckets();
  rules = (saved && saved.length ? saved : buckets[selectedKey] || []).map((r) => ({
    issuer: r.issuer || '',
    template: r.template || '',
  }));
  setDirty(false);
  renderRules();

  const d = $('dirty');
  d.textContent = 'Saved ✓';
  setTimeout(() => {
    if (!dirty) d.textContent = '';
  }, 1800);
}

init();
