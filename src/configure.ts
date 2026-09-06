// Renders the `/configure` setup page. It is a static HTML string with inline
// JS that builds the Stremio install URL client-side, embedding the user's
// debrid token (and any `~lang` preferences) into the addon path.

import { PREFERRED_LANGUAGE_KEYS } from './meta/parser.js';

/** Display label for a canonical language key (e.g. "hindi" -> "Hindi"). */
function languageLabel(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Builds the `<option>` list for the language picker from the canonical keys. */
function languageOptions(): string {
  return PREFERRED_LANGUAGE_KEYS.map((k) => `<option value="${k}">${languageLabel(k)}</option>`).join('');
}

/**
 * Serialize a string as JSON safe to embed inside an inline `<script>`.
 * `baseUrl` is usually derived from the request `Host` header (attacker
 * controlled when `BASE_URL` isn't set), so a raw `<` would let a hostile host
 * break out of the string and close the script tag. Escaping `<`, `>`, `&` and
 * the JS line separators as unicode escapes keeps the value intact (JS string
 * parsing decodes them back) without ever emitting a literal `</script>`.
 */
function scriptSafeJson(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Returns the full configure page HTML. `baseUrl` is injected as JSON into the
 * inline script so the client can build a self-referential install link from
 * the same origin the page was served from.
 */
export function renderConfigurePage(baseUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Tube — Debrid Setup</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:#0f1420; color:#e6e9f0; margin:0; padding:40px 20px; display:flex; justify-content:center; }
  .card { background:#171e30; border:1px solid #27314a; border-radius:14px; padding:32px; max-width:560px; width:100%; box-shadow:0 10px 40px rgba(0,0,0,.4); }
  h1 { font-size:22px; margin:0 0 8px; }
  p { color:#9aa4bd; font-size:14px; line-height:1.5; }
  label { display:block; font-size:14px; margin:20px 0 6px; font-weight:600; }
  input[type=password], input[type=text], select { width:100%; box-sizing:border-box; padding:12px; border-radius:8px; border:1px solid #303a55; background:#0d1220; color:#e6e9f0; font-size:15px; }
  button { margin-top:20px; width:100%; padding:13px; border:0; border-radius:8px; background:#5b6cff; color:white; font-size:15px; font-weight:600; cursor:pointer; }
  button:hover { background:#6a79ff; }
  .result { display:none; margin-top:20px; }
  .result a { display:block; background:#0d1220; border:1px solid #303a55; border-radius:8px; padding:12px; color:#aab6ff; text-decoration:none; word-break:break-all; margin-top:10px; font-size:13px; }
  .result a.install { background:#5b6cff; color:white; text-align:center; font-weight:700; }
  .hint { font-size:12px; color:#6f7a95; margin-top:6px; }
  .error { color:#ff7b7b; font-size:13px; margin-top:10px; display:none; }
  .lang-row { display:flex; gap:8px; align-items:stretch; }
  .lang-row select { flex:1; }
  .lang-row button { width:auto; margin-top:0; padding:12px 18px; flex-shrink:0; }
  .chips { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
  .chips:empty { display:none; }
  .chip { display:inline-flex; align-items:center; gap:8px; background:#0d1220; border:1px solid #303a55; border-radius:999px; padding:6px 8px 6px 14px; font-size:13px; color:#c9d2e8; }
  .chip button { width:auto; margin:0; padding:0 6px; background:none; border:0; color:#6f7a95; font-size:16px; line-height:1; cursor:pointer; border-radius:50%; }
  .chip button:hover { color:#ff7b7b; }
</style>
</head>
<body>
<div class="card">
  <h1>Tube — Debrid Setup</h1>
  <p>Choose your provider and paste its API token to generate a Stremio install link.
  Get your token from <a href="https://real-debrid.com/apitoken" target="_blank" rel="noopener">Real-Debrid</a>
  or <a href="https://torbox.app/settings" target="_blank" rel="noopener">TorBox settings</a>.
  Your token is embedded in the install URL. Keep this link private.</p>

  <label for="provider">Debrid provider</label>
  <select id="provider"><option value="realdebrid">Real-Debrid</option><option value="torbox">TorBox</option></select>
  <label for="token">API token</label>
  <input id="token" type="password" autocomplete="off" placeholder="Paste your token…" />
  <div id="torbox-options" hidden>
    <label><input id="uncached" type="checkbox" /> Download when no cached stream is available</label>
    <p class="hint">Opening a movie or episode can start one torrent download in your TorBox account. Tube prefers cached streams and shows a dashboard link while downloading. Reopen the title after it finishes.</p>
  </div>
  <label for="langs">Preferred languages (optional)</label>
  <div class="lang-row">
    <select id="langs"><option value="" selected>Choose a language…</option>${languageOptions()}</select>
    <button type="button" id="lang-add">Add</button>
  </div>
  <div class="chips" id="lang-chips"></div>
  <p class="hint">Pick the languages that should surface first in your stream list; first added has highest priority. Leave empty to prefer Hindi / Dual / Multi.</p>
  <button id="go">Generate install link</button>
  <div class="error" id="err" role="alert">Please paste your provider's API token.</div>

  <div class="result" id="result">
    <a class="install" id="install" href="#">Install in Stremio</a>
    <label>Manual addon URL (add via Stremio → Addons → paste URL)</label>
    <a id="url" href="#"></a>
    <p class="hint">After installing, search normally in Stremio and open a movie or episode. Tube streams appear alongside your other stream addons. You can install each provider separately.</p>
    <p class="hint">Updating an existing install? Remove the old Tube addon first, then install this link to refresh its catalogs.</p>
  </div>
</div>
<script>
  const base = ${scriptSafeJson(baseUrl)};
  const token = document.getElementById('token');
  const provider = document.getElementById('provider');
  const uncached = document.getElementById('uncached');
  const err = document.getElementById('err');
  const result = document.getElementById('result');
  const install = document.getElementById('install');
  const url = document.getElementById('url');
  const langs = document.getElementById('langs');
  const langAdd = document.getElementById('lang-add');
  const langChips = document.getElementById('lang-chips');
  const chosen = []; // canonical language keys, in priority order (first = top)

  function renderChips() {
    langChips.innerHTML = '';
    chosen.forEach((lang) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = lang.charAt(0).toUpperCase() + lang.slice(1);
      const x = document.createElement('button');
      x.type = 'button';
      x.setAttribute('aria-label', 'Remove ' + lang);
      x.textContent = '×';
      x.addEventListener('click', () => {
        const i = chosen.indexOf(lang);
        if (i !== -1) chosen.splice(i, 1);
        renderChips();
        result.style.display = 'none';
      });
      chip.appendChild(x);
      langChips.appendChild(chip);
    });
  }

  function generate() {
    const t = token.value.trim();
    if (!t) { err.style.display = 'block'; result.style.display = 'none'; return; }
    err.style.display = 'none';
    const credential = provider.value === 'torbox' ? (uncached.checked ? 'torbox-download:' : 'torbox:') + t : t;
    const withLangs = credential + (chosen.length ? '~' + chosen.join(',') : '');
    const manifest = base + '/' + encodeURIComponent(withLangs) + '/manifest.json';
    install.href = 'stremio://' + manifest.replace(/^https?:\\/\\//, '');
    url.href = manifest;
    url.textContent = manifest;
    result.style.display = 'block';
  }

  document.getElementById('go').addEventListener('click', generate);
  provider.addEventListener('change', () => {
    document.getElementById('torbox-options').hidden = provider.value !== 'torbox';
    result.style.display = 'none';
  });
  uncached.addEventListener('change', () => { result.style.display = 'none'; });
  token.addEventListener('keydown', (e) => { if (e.key === 'Enter') generate(); });
  langAdd.addEventListener('click', () => {
    const v = langs.value;
    if (v && !chosen.includes(v)) {
      chosen.push(v);
      renderChips();
      result.style.display = 'none';
    }
    langs.value = '';
  });
</script>
</body>
</html>`;
}
