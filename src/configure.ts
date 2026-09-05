// Renders the `/configure` setup page. It is a static HTML string with inline
// JS that builds the Stremio install URL client-side, embedding the user's
// debrid token (and any `~lang` preferences) into the addon path.

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
  <input id="langs" type="text" autocomplete="off" placeholder="english, french, urdu, german, spanish, hindi" />
  <p class="hint">Comma-separated (names or codes, e.g. english, french, urdu, german / deutch / deu, spanish, hindi). These languages float to the top of the stream list when available. Leave blank to prefer Hindi / Dual / Multi.</p>
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
  const base = ${JSON.stringify(baseUrl)};
  const token = document.getElementById('token');
  const provider = document.getElementById('provider');
  const uncached = document.getElementById('uncached');
  const langsInput = document.getElementById('langs');
  const err = document.getElementById('err');
  const result = document.getElementById('result');
  const install = document.getElementById('install');
  const url = document.getElementById('url');

  function generate() {
    const t = token.value.trim();
    if (!t) { err.style.display = 'block'; result.style.display = 'none'; return; }
    err.style.display = 'none';
    const langs = langsInput.value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const credential = provider.value === 'torbox' ? (uncached.checked ? 'torbox-download:' : 'torbox:') + t : t;
    const withLangs = credential + (langs.length ? '~' + langs.join(',') : '');
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
</script>
</body>
</html>`;
}
