# CLAUDE.md — Certiorari

Agent orientation for this repo. Read this first; see [README.md](README.md) for user-facing docs.

## What this is

A small **Windows-only Electron browser** whose sole purpose is to let a user pick
**exactly which client certificate** to present for a site (mutual TLS), then browse
with it. It exists because the user has ~50 client certs for the same site that are
named near-identically in the native Windows/Firefox picker — impossible to tell apart.
Typical usage: spin it up, view a few pages with a chosen cert, close it.

Platform is **Windows only** by design: it reads the Windows cert store via PowerShell,
uses DPAPI for secrets, and ships as a Windows exe.

## Stack

- **Electron 42** (main + preload + renderer), no bundler — renderer loads plain
  `.js`/`.css` via `loadFile`.
- **liquidjs** (the only production dependency) — templating DSL for cert labels.
- **electron-builder** — portable exe + NSIS installer.
- Zero native modules. Cert enumeration shells out to `powershell.exe`.

## Run / build / test

```sh
npm start            # run from a TERMINAL (main-process console.log only shows there)
npm test             # node:test suite in test/ — pure-Node, no Electron needed
npm run certs        # standalone dump of the Personal cert store (no Electron)
npm run dist         # portable + NSIS installer  → dist/  (run on NATIVE Windows, not WSL)
npm run pack         # unpacked app only (fast packaging sanity check)
```

Tests live in `test/*.test.js` and run on the built-in **node:test** runner (`npm test`,
no deps). They cover only the **Electron-free surface**: `deriveCertLabel`, `parseDN`/
`parseDNPairs`, `findCertInList`, `sha1ThumbprintFromPem`, `normalizeSerial`,
`resolveWithRules`, `preview`, `issuerMatches`, `buildContext`, `canonicalizeUrl`.
Anything touching `app.getPath` (`resolveLabel`, the mappings-store CRUD, secrets) needs
the Electron runtime and is exercised manually, not unit-tested.

## CI (.github/workflows)

- **ci.yml** — on PRs to master/main: runs `npm test` (ubuntu, Electron binary download
  skipped) + `npm run pack` (windows) to prove it still packages. No publish.
- **release.yml** — on push to master: auto-increments the version (`npm version`),
  commits it back as `ci: release v<x> [skip ci]`, tags it, then builds + publishes the
  installers to GitHub Releases. Loop-safe (the `[skip ci]` commit + GITHUB_TOKEN pushes
  don't re-trigger). Needs the bot to be able to push to master (branch-protection bypass).
  NOTE: trigger/checkout/push all target `master` — confirm that's the repo's default branch.

## The core mechanism (how a chosen cert gets presented)

1. Renderer records the user's choice → IPC `session:setCert` → main stores it in the
   `certForHost` Map (keyed by `url.host`), as `{ thumbprint, serialNumber, label }`.
2. The target site renders in a `<webview>` with a **unique in-memory partition**
   (`clientcert-N`). A fresh partition = fresh Chromium `NetworkContext`.
3. `app.on('select-client-certificate')` ([main.js](src/main/main.js)) fires during the
   TLS handshake. It looks up `certForHost`, finds the match in the server-offered `list`
   via `findCertInList` (SHA-1 thumbprint, serial fallback), `preventDefault()`s the native
   picker, and `callback(match)`. The private key never leaves Windows (CNG signs).

**Changing the cert** (the 🔐 button) updates the map, runs a "nuclear" reset, then mounts
a **new** partition so the handshake re-fires. See the next section — this is the subtle part.

## Known-tricky area: client-cert "stickiness" (ACTIVE)

Chromium caches the client-cert choice in `SSLClientAuthCache`, which is **per network
context and has no public clear API**. The only real reset is a brand-new partition. On
cert change ([renderer.js](src/renderer/renderer.js) `cert-btn` handler) we therefore:
`session:nuke` the old partition + default session (`closeAllConnections`, `clearAuthCache`,
`clearHostResolverCache`, `clearCache`, `clearCodeCaches`, `clearStorageData`, `clearData`),
then `mountWebview` on a fresh partition.

**Open question:** the user reported the cert sometimes not changing. We added an on-screen
diagnostic (status bar, bottom-right, channel `cert:diag`) showing `host`, `wcId`,
`defaultSession`, `offered` count, `want`, `matched`. Interpretation:
- new `wcId` + `isolated → "<cert>"` = working; any remaining stickiness is **server-side**.
- `⚠ SHARED session` (`defaultSession=true`) = the `<webview>` isn't isolating; the fresh
  partition can't reset the cache. **Planned fix if confirmed:** move the browser view +
  an explicit `session` object into the main process (`WebContentsView`) instead of relying
  on `<webview>` partitions.
Root cause not yet confirmed — needs the on-screen readout from a real run.

## Label templating (Liquid)

Cert labels are resolved by **Liquid templates matched on the cert issuer, scoped per site**.
Resolution order ([labels.js](src/main/labels.js) `resolveLabel`):
1. Rules for the current **canonical origin** (`https://host[:port]`, see
   [mappings.js](src/main/mappings.js) `canonicalizeUrl`).
2. Rules in the global `*` ("all sites") bucket.
3. Fallback: `certs.deriveCertLabel` → `CN - OU1 - OU2 … - OUn`.

First rule whose `issuer` matches wins (`issuerMatches`: issuer CN exact / `CN=…` form /
substring of full issuer DN, all case-insensitive). Templates render against a context of
`cn`, `ou[]` (0-indexed), `o`/`c`/`l`/`st`/`email`, `issuer.cn`, `dn`. Built-in Liquid
filters plus custom `skip: n` / `take: n`.

Store: `userData/mappings.json`, seeded on first run from
[default-mappings.json](src/main/default-mappings.json) (issuer `CN=Bob Enterprises`).
Edited in a **separate window** (editor.html/js, opened via "⚙ Label mappings" on the
picker) with live preview; saving broadcasts `mappings:changed` so the open picker
re-resolves labels.

## File map

```
src/main/
  main.js              app entry, select-client-certificate hook, certForHost map,
                       session:nuke, all IPC handlers, editor BrowserWindow, cert:diag
  certs.js             PowerShell enumeration of Cert:\CurrentUser\My; deriveCertLabel
                       (CN-OU FALLBACK), deriveCertSublabel, parseDNPairs/parseDN,
                       findCertInList. NO electron import (so npm run certs works).
  labels.js            Liquid engine, buildContext, issuerMatches, resolveLabel, preview
  mappings.js          per-origin + '*' template store, canonicalizeUrl, first-run seed
  default-mappings.json packaged seed (Bob Enterprises)
  secrets.js           DPAPI (safeStorage) password vault — opt-in, for the .pfx path
  config.js            remembers last URL
src/preload/preload.js contextBridge allowlist (the ONLY main<->renderer surface)
src/renderer/
  index.html/renderer.js  start screen, picker (search/expiry/mappings btn), browser, unlock
  editor.html/editor.js   label-mappings editor window
  styles.css/editor.css   dark theme
scripts/list-certs.js  standalone store dump
test/*.test.js         node:test unit tests (Electron-free helpers)
.github/workflows/     ci.yml (PR gate) + release.yml (auto-bump + publish)
build/                 icon.svg + icon instructions
```

The mappings editor also has **Export / Import** (whole-store JSON as a string: export
copies to the clipboard, import is a paste-in modal with a "replace all" option,
duplicate rules skipped on merge) via `mappings:export` / `mappings:import` IPC.

## Conventions & invariants

- **Security:** `contextIsolation: true`, `nodeIntegration: false`. Renderer reaches main
  ONLY through the explicit allowlist in `preload.js`. Remote content lives in an isolated
  `<webview>` (its own partition, no Node). Passwords are DPAPI-encrypted, opt-in, never
  plaintext. Cert `subject` strings are HTML-escaped before any `innerHTML` (see picker
  highlight).
- **User edit point:** `deriveCertLabel` / `deriveCertSublabel` in `certs.js` carry an
  `>>> EDIT ME <<<` banner. They are now the *fallback* (templates are primary), but the
  user still tweaks them.
- **Persistent state** (all under `%APPDATA%/certiorari`): `config.json` (last URL),
  `secrets.json` (DPAPI vault), `mappings.json` (templates). These are plain files, NOT
  session storage — `session:nuke`/`clearData` does not touch them.
- **Labels depend on URL:** `certs:list` takes `{ url }` and resolves labels for that
  origin. Don't call it without the current URL if labels matter.

## Gotchas

- **Build from native Windows, not WSL** — NSIS needs Wine under Linux (`spawn wine ENOENT`).
  The portable target builds from either.
- **Main-process `console.log` is invisible** unless launched from a terminal via
  `npm start`; the packaged exe shows nothing. That's why diagnostics also go on-screen.
- **A running instance won't pick up edits** — Electron has no hot reload; restart.
- **`dist/*.exe` can be stale** — rebuild after code changes.
- `electron-builder.yml` has a `publish: github` block (user-added) for `--publish`.

## Current status

Functionally complete: URL entry → cert picker (full-text subject search, expiry badges,
issuer-matched Liquid label templates) → mTLS browsing → change-cert with nuclear reset →
packaging. The one open thread is the cert-change stickiness investigation above.
