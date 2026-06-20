# Certiorari

A tiny Electron browser that lets you pick **exactly which** Windows client
certificate to present for a site, then applies it to every HTTPS request — built
for the case where you have ~50 nearly-identical certs and the native picker is
useless for telling them apart.

## Run

```sh
npm install
npm start
```

Diagnostic (dump your Personal store the way the app sees it):

```sh
npm run certs
```

## Flow

1. **URL screen** — enter a site (the last URL is pre-filled; empty by default).
2. **Certificate picker** — choose one of your Personal-store certs. Each row
   shows a primary label plus a disambiguating sub-line (issuer / expiry /
   thumbprint tail).
3. **Browser** — the site loads with your chosen cert applied to the TLS
   handshake. The 🔐 button (top-right) re-opens the picker at any time; picking
   a new cert reloads the page with it.

## How the cert actually gets applied

`app.on('select-client-certificate')` in [`src/main/main.js`](src/main/main.js)
fires during the TLS handshake. We suppress Chromium's native picker and return
the cert the user chose for that host. The private key never leaves Windows —
CNG does the signing inside Chromium. We only ever pass cert **metadata** around.

Changing the cert mounts a fresh in-memory `<webview>` partition, which forces a
new TLS handshake so the new cert is actually negotiated (Chromium caches the
client-cert choice per host/session otherwise).

## How the cert label is built

Labels are produced by **Liquid templates**, matched per certificate **issuer**
and scoped per **site**. Resolution order (see [`src/main/labels.js`](src/main/labels.js)):

1. Rules for the current site's canonical origin (`https://host[:port]`), then
2. Rules in the global `*` ("all sites") bucket, then
3. The built-in fallback `deriveCertLabel(cert)` → `CN - OU1 - OU2 … - OUn`
   ([`src/main/certs.js`](src/main/certs.js), still the `>>> EDIT ME <<<` fallback).

The first rule whose `issuer` matches the cert wins; its Liquid `template` renders
against the cert. Edit rules in-app via **⚙ Label mappings** on the cert picker
(opens [`editor.html`](src/renderer/editor.html) in its own window), with a live
preview. Storage is `userData/mappings.json`; on first run it's seeded with the
packaged default from [`default-mappings.json`](src/main/default-mappings.json)
(issuer `CN=Bob Enterprises` → `{{ ou[0] }} - {{ ou[4] | skip: 5 }} - {{ ou[1] }}`).

### Template DSL (Liquid)

Context (from the Subject): `cn` (first CN), `ou` (0-indexed array — `ou[0]`,
`ou[1]`, …), `o`/`c`/`l`/`st`/`email` (first of each), `issuer.cn`, `dn`.
Filters: Liquid built-ins (`upcase`, `downcase`, `capitalize`, `strip`,
`slice: a, b`, `append`, `prepend`, `default`) plus two domain filters registered
in `labels.js` — `skip: n` (drop first n chars) and `take: n` (keep first n).

```liquid
{{ ou[1] | upcase }} - {{ ou[3] | upcase }} - {{ ou[4] | upcase }}
```

Issuer matching (in `labels.js`, `issuerMatches`) is forgiving: exact issuer CN,
a `CN=…` form, or any substring of the full issuer DN — all case-insensitive.

Cert→handshake matching is separate (`findCertInList` in `certs.js`), by SHA-1
thumbprint with a serial-number fallback.

The store(s) scanned are in `STORE_PATHS` (default: `Cert:\CurrentUser\My`, i.e.
"Personal > Certificates"). Add `Cert:\LocalMachine\My` if you keep certs there.

## Passwords / locked keys

- **Certs in the Windows store (your case):** Windows owns the unlock. If a key
  has *strong private key protection*, Windows shows its **own native PIN/password
  prompt** during the handshake — nothing for the app to do, and the most secure
  arrangement. Run `npm run certs` to see what's in your store; none of your
  current certs show a password requirement.

- **Opt-in saved passwords:** [`src/main/secrets.js`](src/main/secrets.js) is an
  encrypted vault using Electron `safeStorage` → **DPAPI**, scoped to your
  Windows user account. Plaintext is never written or logged. Saving is always
  explicit (the "Remember" checkbox in the 🔒 dialog). This is wired and ready,
  but see below for when it's actually used.

### Advanced: app-managed passwords (`.pfx` / local proxy)

The store path above can't (and shouldn't) intercept Windows' native prompt, so
the saved-password vault only takes effect if you load `.pfx` files yourself. The
clean way to do that while still rendering in the browser is a **local mTLS proxy**
inside the main process that holds the PFX (password from the vault) and
originates the upstream TLS. That introduces a local CA/MITM surface, so it's left
as a documented seam rather than built by default. The vault + unlock UI are the
pieces it would plug into:

- `secrets.getPassword(thumbprint)` → supply the PFX password
- the 🔒 dialog → collect + optionally remember it

## Security notes

- Renderer is isolated (`contextIsolation: true`, `nodeIntegration: false`); the
  only main↔renderer surface is the explicit allowlist in
  [`src/preload/preload.js`](src/preload/preload.js).
- The remote site renders in a separate `<webview>` with its own session
  partition — it has no Node access.
- Passwords: DPAPI-encrypted at rest, opt-in, never plaintext.

## Project layout

```
src/
  main/
    main.js              app entry, select-client-certificate hook, IPC
    certs.js             Personal-store enumeration + CN-OU fallback + matching
    labels.js            Liquid engine: resolve labels from issuer-matched templates
    mappings.js          per-origin template store + URL canonicalization + seed
    default-mappings.json packaged seed (Bob Enterprises default)
    secrets.js           DPAPI password vault (opt-in)
    config.js            remembers last URL
  preload/preload.js     contextBridge allowlist
  renderer/
    index.html / renderer.js   URL screen, picker, browser, unlock modal
    editor.html / editor.js    label-mappings editor window
    styles.css / editor.css    dark theme
scripts/list-certs.js    standalone store dump (npm run certs)
```

## Packaging / distribution (Windows)

Built with electron-builder (config in [`electron-builder.yml`](electron-builder.yml)).

- `npm run dist` — builds a **portable** single `.exe` **and** an **NSIS installer** into `dist/`. Auto-increments version.
- `npm run dist:portable` — portable `.exe` only. Auto-increments version.
- `npm run pack` — unpacked folder in `dist/win-unpacked/` (for inspection). No version bump.
- `npm run version:patch` — manually increment the version patch in `package.json`.

Outputs:
- `dist/Certiorari-<version>-portable.exe` — run directly, nothing installed.
- `dist/Certiorari-<version>-setup.exe` — per-user install, no admin/UAC.

Both persist per-user data (last URL, the DPAPI password vault) under
`%APPDATA%\certiorari` across runs.

### Code signing & SmartScreen — read before sending to a client

An **unsigned** build triggers Windows SmartScreen ("Windows protected your PC")
and may be flagged by antivirus. To avoid that, sign with an Authenticode cert.
Never hard-code secrets in the config — pass them at build time as env vars:

```powershell
$env:CSC_LINK="C:\path\to\codesign.pfx"
$env:CSC_KEY_PASSWORD="********"
npm run dist
```

- **OV cert** (~$200–400/yr): clears the unknown-publisher/AV issues. Since 2023 the
  key must live on an HSM/USB token, so you'll use the CA's cloud-signing tool or a
  custom `sign` hook rather than a local `.pfx`.
- **EV cert**: same, plus *instant* SmartScreen reputation (no warm-up period).
- Unsigned is acceptable for a one-off internal hand-off the client is expecting —
  they click "More info → Run anyway" once.

### Notes
- **Build from native Windows** (PowerShell/cmd), not WSL. The NSIS installer step
  runs `makensis`, which under WSL/Linux needs Wine (`spawn wine ENOENT` otherwise).
  The portable target builds fine from either.
- Relies on `powershell.exe` (built into Windows) to read the cert store; the call
  passes `-ExecutionPolicy Bypass`, so the machine's execution policy is irrelevant.
- x64 only by default; add `arch: [x64, arm64]` in `electron-builder.yml` for ARM.
- Add `build/icon.ico` for branding (see [build/README.md](build/README.md)).
