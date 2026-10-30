import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
/**
 * Local Data API v1 probe. Reads live credentials from .env.truelayer.local.
 * Does not print the client secret. Bind address is 127.0.0.1 only.
 *
 * localhost is not a registered redirect URI, so the bank journey returns to
 * TrueLayer's console redirect page. Paste that page's code (or full URL) back here.
 */
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 8765);
const REDIRECT_URI = 'https://console.truelayer.com/redirect-page';
const AUTH_BASE = 'https://auth.truelayer.com';
const API_BASE = 'https://api.truelayer.com';
const SCOPE = 'info accounts balance transactions cards offline_access';
const ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../.env.truelayer.local');

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[trimmed.slice(0, eq).trim()] = value;
  }
  const clientId = env.TL_CLIENT_ID;
  const clientSecret = env.TL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('TL_CLIENT_ID and TL_CLIENT_SECRET are required in .env.truelayer.local');
  }
  return { clientId, clientSecret };
}

const credentials = loadEnv(ENV_PATH);

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function page(body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TrueLayer v1 live probe</title>
  <style>
    :root { color-scheme: light dark; }
    body { font: 16px/1.45 ui-sans-serif, system-ui, sans-serif; margin: 0; background: #f6f4ef; color: #1c1915; }
    main { max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; }
    h1 { font-size: 1.6rem; margin: 0 0 8px; }
    h2 { font-size: 1.15rem; margin: 28px 0 8px; }
    p, li { color: #3f3a33; }
    a.button, button { appearance: none; border: 0; border-radius: 8px; background: #1f6b4a; color: white; padding: 10px 16px; font: inherit; cursor: pointer; text-decoration: none; display: inline-block; }
    textarea { width: 100%; min-height: 88px; font: 14px/1.4 ui-monospace, monospace; padding: 10px; border-radius: 8px; border: 1px solid #cfc6b8; box-sizing: border-box; }
    .card { background: white; border: 1px solid #e4dccf; border-radius: 12px; padding: 16px; margin: 12px 0; }
    .muted { color: #6d645b; font-size: 0.92rem; }
    .error { background: #fff1f0; border-color: #e7b2ab; }
    table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee6dc; vertical-align: top; }
    td.amount { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .credit { color: #1f6b4a; }
    .debit { color: #8a3b32; }
  </style>
</head>
<body>
  <main>
    <h1>TrueLayer v1 live probe</h1>
    <p class="muted">Production client, Data API v1, your browser. This page never shows the client secret. Bank login happens on TrueLayer, not here.</p>
    ${body}
  </main>
</body>
</html>`;
}

function home() {
  return page(`
    <ol>
      <li>Open TrueLayer and pick your real bank. Finish their login and consent there.</li>
      <li>You should land on <code>console.truelayer.com/redirect-page</code> with a code in the address bar.</li>
      <li>Paste that code, or the whole URL, below.</li>
    </ol>
    <p><a class="button" href="/start" target="_blank" rel="noopener">Connect bank</a></p>
    <form method="post" action="/exchange">
      <p><label for="code">Code or redirect URL</label></p>
      <textarea id="code" name="code" required placeholder="Paste the code or the full redirect URL"></textarea>
      <p><button type="submit">Fetch accounts and transactions</button></p>
    </form>
    <p class="muted">American Express has no accounts API. Use Connect bank again so the new link includes the cards scope, then paste a fresh code. HSBC’s popup 403 is their own page crashing; if that happens, copy the popup address into the main tab instead of logging in inside the popup.</p>
  `);
}

function authUrl() {
  const url = new URL(`${AUTH_BASE}/`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', credentials.clientId);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', randomBytes(8).toString('hex'));
  return url.toString();
}

function parseInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return { error: 'Paste the code or the redirect URL.' };
  if (text.includes('tlcs_') || text.includes('client_secret')) {
    return { error: 'That looks like a client secret. Paste only the redirect code or URL.' };
  }
  try {
    const url = new URL(text);
    const error = url.searchParams.get('error');
    if (error) {
      return {
        error: `${error}: ${url.searchParams.get('error_description') || 'TrueLayer returned an error instead of a code.'}`,
      };
    }
    const code = url.searchParams.get('code');
    if (!code) return { error: 'That URL has no code parameter.' };
    return { code };
  } catch {
    if (!/^[A-Za-z0-9._-]{8,256}$/.test(text)) {
      return { error: 'That does not look like a TrueLayer code or redirect URL.' };
    }
    return { code: text };
  }
}

async function exchange(code) {
  const response = await fetch(`${AUTH_BASE}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      redirect_uri: REDIRECT_URI,
      code,
    }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = json.error_description || json.error || `HTTP ${response.status}`;
    throw new Error(`Token exchange failed: ${detail}`);
  }
  return json.access_token;
}

async function tlGet(path, token) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  let json = text;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  return { status: response.status, json };
}

function money(amount, currency) {
  if (amount == null) return '';
  const formatted = Number(amount).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${formatted} ${currency || ''}`.trim();
}

function maskNumber(value) {
  const digits = String(value || '').replace(/\s/g, '');
  if (digits.length < 4) return '';
  return `••••${digits.slice(-4)}`;
}

function errorBlock(label, result) {
  if (!result || result.status === 200) return '';
  return `<div class="card error"><strong>${escapeHtml(label)} HTTP ${result.status}</strong>
    <pre>${escapeHtml(JSON.stringify(result.json, null, 2).slice(0, 800))}</pre></div>`;
}

function renderResults({ info, accounts, cards, details }) {
  const person = info.json?.results?.[0];
  const identity = person
    ? `<p>Signed in as <strong>${escapeHtml(person.full_name || 'unknown name')}</strong></p>`
    : `<p class="muted">Identity call returned HTTP ${info.status}.</p>`;

  const accountRows = (accounts.json?.results || []).map((row) => ({ ...row, kind: 'account' }));
  const cardRows = (cards.json?.results || []).map((row) => ({ ...row, kind: 'card' }));
  const rows = [...accountRows, ...cardRows];
  if (!rows.length) {
    return page(`
      ${identity}
      ${errorBlock('Accounts', accounts)}
      ${errorBlock('Cards', cards)}
      <p><a href="/">Try again</a></p>
    `);
  }

  const sections = rows
    .map((account, index) => {
      const extra = details[index] || {};
      const balance = extra.balance?.json?.results?.[0];
      const transactions = extra.transactions?.json?.results || [];
      const txError = extra.transactions && extra.transactions.status !== 200 ? extra.transactions.json : null;
      const number = account.account_number || {};
      const txRows = transactions
        .slice()
        .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
        .slice(0, 12)
        .map((tx) => {
          const credit = Number(tx.amount) > 0;
          return `<tr>
            <td>${escapeHtml(String(tx.timestamp || '').slice(0, 10))}</td>
            <td>${escapeHtml(tx.description || tx.merchant_name || '')}</td>
            <td class="amount ${credit ? 'credit' : 'debit'}">${escapeHtml(money(tx.amount, tx.currency))}</td>
          </tr>`;
        })
        .join('');

      return `<section class="card">
        <h2>${escapeHtml(account.display_name || account.account_type || 'Account')}</h2>
        <p class="muted">${escapeHtml(account.provider?.display_name || '')} · ${escapeHtml(account.account_type || '')} · ${escapeHtml(account.currency || '')}
          ${number.sort_code ? ` · ${escapeHtml(number.sort_code)} ${escapeHtml(maskNumber(number.number))}` : ''}
        </p>
        ${
          balance
            ? `<p>Available <strong>${escapeHtml(money(balance.available, balance.currency))}</strong>
               · current ${escapeHtml(money(balance.current, balance.currency))}</p>`
            : `<p class="muted">Balance HTTP ${extra.balance?.status ?? 'n/a'}</p>`
        }
        ${
          txRows
            ? `<table><thead><tr><th>Date</th><th>Description</th><th>Amount</th></tr></thead><tbody>${txRows}</tbody></table>
               <p class="muted">${transactions.length} transaction${transactions.length === 1 ? '' : 's'} returned. Showing 12.</p>`
            : txError
              ? `<pre>${escapeHtml(JSON.stringify(txError, null, 2).slice(0, 800))}</pre>`
              : `<p class="muted">No settled transactions in the requested range. Pending: ${escapeHtml(String(extra.pendingCount ?? 0))}.</p>`
        }
      </section>`;
    })
    .join('');

  return page(`${identity}${sections}<p><a href="/">Start another connection</a></p>`);
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://127.0.0.1:${PORT}`);
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(home());
      return;
    }
    if (request.method === 'GET' && url.pathname === '/start') {
      response.writeHead(302, { Location: authUrl() });
      response.end();
      return;
    }
    if (request.method === 'POST' && url.pathname === '/exchange') {
      const parsedForm = new URLSearchParams(await readBody(request));
      const parsed = parseInput(parsedForm.get('code'));
      if (parsed.error) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(page(`<div class="card error">${escapeHtml(parsed.error)}</div><p><a href="/">Back</a></p>`));
        return;
      }
      const token = await exchange(parsed.code);
      const to = new Date();
      const from = new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000);
      const day = (date) => date.toISOString().slice(0, 10);
      const range = `from=${day(from)}&to=${day(to)}`;
      const [info, accounts, cards] = await Promise.all([
        tlGet('/data/v1/info', token),
        tlGet('/data/v1/accounts', token),
        tlGet('/data/v1/cards', token),
      ]);
      const accountRows = [
        ...(accounts.json?.results || []).map((row) => ({ ...row, kind: 'account' })),
        ...(cards.json?.results || []).map((row) => ({ ...row, kind: 'card' })),
      ];
      const details = await Promise.all(
        accountRows.map(async (account) => {
          const id = encodeURIComponent(account.account_id || account.card_id);
          const base = account.kind === 'card' ? 'cards' : 'accounts';
          const [balance, transactions, pending] = await Promise.all([
            tlGet(`/data/v1/${base}/${id}/balance`, token),
            tlGet(`/data/v1/${base}/${id}/transactions?${range}`, token),
            tlGet(`/data/v1/${base}/${id}/transactions/pending`, token),
          ]);
          const pendingCount = pending.status === 200 ? (pending.json?.results?.length ?? 0) : 0;
          console.log(
            `${base} ${id} tx ${transactions.status} rows ${transactions.json?.results?.length ?? 0} pending ${pending.status} rows ${pendingCount}`,
          );
          return { balance, transactions, pendingCount };
        }),
      );
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(renderResults({ info, accounts, cards, details }));
      console.log(
        `fetched ${accountRows.length} product(s); info ${info.status}; accounts ${accounts.status}; cards ${cards.status}`,
      );
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('Not found');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'request failed');
    response.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(
      page(
        `<div class="card error">${escapeHtml(error instanceof Error ? error.message : 'Request failed')}</div><p><a href="/">Back</a></p>`,
      ),
    );
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`TrueLayer probe at http://127.0.0.1:${PORT}`);
});
