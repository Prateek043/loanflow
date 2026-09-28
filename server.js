// Loan Journey Viewer — tiny zero-dependency server.
// Proxies Loki (via Grafana's datasource proxy) and parses lmApp HTTP logs
// into a structured journey for one loanRequestId.
//
// Each user signs in with their own Grafana username/password; every Loki query
// runs as that user, so Grafana's permissions apply.
//
// Env:
//   SESSION_SECRET         encrypts the session cookie (required; long random string)
//   GRAFANA_URL            default https://grafana.rupeek.com
//   LOKI_DS_UID            default eRl6oHbIk (Loki-prod)
//   HOST / PORT            default 127.0.0.1 / 4747

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
dotenv.config();

const GRAFANA_URL = (process.env.GRAFANA_URL || 'https://grafana.rupeek.com').replace(/\/$/, '');
const LOKI_DS_UID = process.env.LOKI_DS_UID || 'eRl6oHbIk';
const PORT = Number(process.env.PORT || 4747);
const HOST = process.env.HOST || (process.env.VERCEL ? '0.0.0.0' : '127.0.0.1');
const PAGE_LIMIT = 1000;
const MAX_PAGES = 20;

// ---- sessions ------------------------------------------------------------
// The session cookie holds the user's Grafana credentials, AES-256-GCM encrypted
// with SESSION_SECRET. It is HttpOnly, so page JavaScript can never read it.

const SESSION_COOKIE = 'ljv_session';
const SESSION_TTL_MS = 12 * 3600e3;
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET not set: using a random one, so everyone is logged out when the server restarts');
}
const SESSION_KEY = crypto.createHash('sha256').update(process.env.SESSION_SECRET || crypto.randomBytes(32)).digest();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', SESSION_KEY, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url');
}

function unseal(token) {
  try {
    const buf = Buffer.from(token, 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', SESSION_KEY, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    const obj = JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
    return obj.exp > Date.now() ? obj : null;
  } catch { return null; }
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, v.join('=')]));
}

function isSecure(req) {
  if (req.headers['x-forwarded-proto']) return req.headers['x-forwarded-proto'] === 'https';
  return !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '');
}

function sessionCookie(req, value, maxAgeSec) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${isSecure(req) ? '; Secure' : ''}`;
}

function getSession(req) {
  const tok = cookies(req)[SESSION_COOKIE];
  return tok ? unseal(tok) : null;
}

const basicAuth = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

// Validate credentials against Grafana itself
async function grafanaUser(username, password) {
  const res = await fetch(`${GRAFANA_URL}/api/user`, { headers: { Authorization: basicAuth(username, password) } });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new HttpError(502, `Grafana ${res.status} while signing in`);
  return res.json();
}

// Simple per-IP throttle so the login form can't be used to brute-force Grafana
const loginAttempts = new Map();
function throttled(ip) {
  const now = Date.now();
  const a = loginAttempts.get(ip);
  if (!a || a.reset < now) { loginAttempts.set(ip, { n: 1, reset: now + 5 * 60e3 }); return false; }
  a.n += 1;
  return a.n > 10;
}

function readJson(req, limit = 10e3) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) { reject(new HttpError(413, 'Body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new HttpError(400, 'Invalid JSON')); } });
    req.on('error', reject);
  });
}

// ---- loki ----------------------------------------------------------------

async function lokiQueryRange(auth, logql, startNs, endNs, { pageLimit = PAGE_LIMIT, maxPages = MAX_PAGES } = {}) {
  const lines = [];
  let cursor = BigInt(startNs);
  const end = BigInt(endNs);
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({
      query: logql, start: cursor.toString(), end: end.toString(),
      limit: String(pageLimit), direction: 'forward',
    });
    const url = `${GRAFANA_URL}/api/datasources/proxy/uid/${LOKI_DS_UID}/loki/api/v1/query_range?${qs}`;
    const res = await fetch(url, { headers: { Authorization: auth } });
    if (res.status === 401) throw new HttpError(401, 'Your Grafana session is no longer valid. Please sign in again.');
    if (res.status === 403) throw new HttpError(403, 'Your Grafana account does not have access to Loki-prod.');
    if (!res.ok) throw new Error(`Loki ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    let batch = [];
    for (const s of body.data.result) {
      for (const [ts, line] of s.values) batch.push({ ts, line, labels: s.stream });
    }
    batch.sort((a, b) => (BigInt(a.ts) < BigInt(b.ts) ? -1 : 1));
    lines.push(...batch);
    if (batch.length < pageLimit) break;
    cursor = BigInt(batch[batch.length - 1].ts) + 1n;
  }
  // de-dupe (same ts + line can appear across page boundaries / streams)
  const seen = new Set();
  return lines.filter((l) => {
    const k = l.ts + l.line.length + l.line.slice(0, 200);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---- parsing -------------------------------------------------------------

function parseHeaders(block) {
  const out = {};
  for (const raw of block.split('\n')) {
    const i = raw.indexOf(':');
    if (i > 0) out[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
  }
  return out;
}

function parseBody(text) {
  const t = (text || '').trim();
  if (!t || t === 'No Request Body' || t === 'No Response Body') return null;
  try { return JSON.parse(t); } catch { return t; }
}

// Format: "Request: URL: <url> Method: <m> VersionCode: <v> Headers: <h>\n Body: <b>
//          Response: Code: <c> Message: <msg> Headers: <h>\n Body: <b>"
function parseLine(line) {
  if (!line.startsWith('Request: URL: ')) return null;
  const split = line.indexOf(' Response: Code: ');
  const reqPart = split >= 0 ? line.slice(0, split) : line;
  const resPart = split >= 0 ? line.slice(split + ' Response: Code: '.length) : '';

  const m = reqPart.match(/^Request: URL: (\S+) Method: (\w+)(?: VersionCode: (\S+))? Headers: ([\s\S]*?)\n Body: ([\s\S]*)$/);
  if (!m) return null;
  const [, url, method, versionCode, reqHeaders, reqBody] = m;

  let status = null, message = '', resHeaders = {}, resBody = null;
  if (resPart) {
    const r = resPart.match(/^(\d+) Message: ([\s\S]*?) Headers: ([\s\S]*?)\n Body: ([\s\S]*)$/);
    if (r) {
      status = Number(r[1]); message = r[2].trim();
      resHeaders = parseHeaders(r[3]); resBody = parseBody(r[4]);
    } else {
      status = Number((resPart.match(/^(\d+)/) || [])[1]) || null;
    }
  }

  let u;
  try { u = new URL(url); } catch { u = { pathname: url, search: '', host: '' }; }
  const tp = resHeaders.traceparent && resHeaders.traceparent.split('-')[1];
  return {
    url, host: u.host, path: u.pathname, query: u.search, method, versionCode,
    service: u.pathname.split('/').filter(Boolean)[0] || '',
    request: { headers: parseHeaders(reqHeaders), body: parseBody(reqBody) },
    response: { status, message, headers: resHeaders, body: resBody },
    traceId: tp || resHeaders['x-trace-id'] || null,
    size: line.length,
  };
}

// ---- stages --------------------------------------------------------------

const STAGES = [
  { key: 'arrive', name: 'Pick & Arrive', re: /pickarequest|markasarrived/i },
  { key: 'agentverify', name: 'Agent Verification', re: /agentverification/i },
  { key: 'identify', name: 'Identify Customer', re: /identify-customer/i },
  { key: 'kyc', name: 'KYC', re: /generateUrl|update\/pan|validate\/kyc|kycsummary/i },
  { key: 'bank', name: 'Bank & Penny Test', re: /uploadcustomerbankdetails|pennytest|getPennyTestedAccounts/i },
  { key: 'kycverify', name: 'KYC Verification', re: /customerIntent|verifykyc/i },
  { key: 'appraisal', name: 'Appraisal', re: /touchstonepic|evalJewelsWorth|\/agent\/appraisal$|scopeofloan/i },
  { key: 'scheme', name: 'Scheme & Eligibility', re: /\/agent\/schemes|getjewelseligibility/i },
  { key: 'confirm', name: 'Loan Confirmation', re: /fetchjewelsummary|packetsplit|customerProfile|inputConfigs|loanconfirmation|schemeotpverification|appraisal\/status/i },
  { key: 'esign', name: 'E-Sign', re: /esignrequest/i },
  { key: 'pledge', name: 'Pledge Card', re: /pledgecard|loandocuments/i },
  { key: 'disburse', name: 'Disbursal', re: /transfer\/status/i },
  { key: 'vault', name: 'Vault & Checkout', re: /collaterals|\/checkout/i },
];
// Calls that don't advance the journey (listing / polling / flags)
const STATUS_RE = /\/api\/v1\/status\/[0-9a-f]{24}$/;
const CONTEXT_RE = /getactivetransactions|flagsmith/i;

function classify(p) {
  if (CONTEXT_RE.test(p) || STATUS_RE.test(p)) return 'context';
  const s = STAGES.find((st) => st.re.test(p));
  return s ? s.key : 'other';
}

function buildJourney(loanId, raw) {
  const calls = [];
  for (const r of raw) {
    const parsed = parseLine(r.line);
    const base = { ts: r.ts, time: Number(BigInt(r.ts) / 1000000n), labels: r.labels };
    if (!parsed) { calls.push({ ...base, kind: 'raw', stage: 'other', line: r.line.slice(0, 4000) }); continue; }
    const stage = classify(parsed.path);
    const relevance = parsed.url.includes(loanId) || JSON.stringify(parsed.request.body || '').includes(loanId)
      ? 'direct' : 'mentioned'; // "mentioned" = id only appears inside a response (e.g. a list of loans)
    calls.push({ ...base, kind: 'http', stage, relevance, ...parsed });
  }

  const labels = calls[0]?.labels || {};
  const stageStats = STAGES.map((s, idx) => {
    const cs = calls.filter((c) => c.stage === s.key);
    const errors = cs.filter((c) => c.response && c.response.status >= 400);
    const last = cs[cs.length - 1];
    let state = 'pending';
    if (cs.length) state = last.response && last.response.status >= 400 ? 'failed' : errors.length ? 'recovered' : 'done';
    return {
      key: s.key, name: s.name, idx, state, calls: cs.length, errors: errors.length,
      start: cs[0]?.time ?? null, end: last?.time ?? null,
    };
  });

  // Status code progression from /status/{id}
  const statusCodes = calls
    .filter((c) => c.kind === 'http' && STATUS_RE.test(c.path) && c.response.body && c.response.body.statuscode != null)
    .map((c) => ({ time: c.time, code: c.response.body.statuscode }));

  // Back-tracking = a call for an earlier stage after a later stage was reached (possible restoration)
  let maxIdx = -1;
  const events = [];
  for (const c of calls) {
    const idx = STAGES.findIndex((s) => s.key === c.stage);
    if (idx < 0) continue;
    // Polling GETs of an earlier stage are normal; only a write going backwards smells like a restoration
    const isWrite = c.method && c.method !== 'GET';
    const prev = events[events.length - 1];
    if (idx < maxIdx && isWrite && !(prev && prev.toKey === c.stage && prev.fromKey === STAGES[maxIdx].key)) {
      events.push({ type: 'backtrack', time: c.time, fromKey: STAGES[maxIdx].key, from: STAGES[maxIdx].name, toKey: c.stage, to: STAGES[idx].name });
    }
    maxIdx = Math.max(maxIdx, idx);
  }

  return {
    loanRequestId: loanId,
    agentPhone: labels.phoneNumber || null,
    app: labels.app || null,
    versionCode: calls.find((c) => c.versionCode)?.versionCode || null,
    start: calls[0]?.time ?? null,
    end: calls[calls.length - 1]?.time ?? null,
    totalCalls: calls.length,
    errorCount: calls.filter((c) => c.response && c.response.status >= 400).length,
    stages: stageStats,
    statusCodes,
    events,
    calls,
  };
}

// ---- backend service logs ------------------------------------------------

// API path prefix (as called by lmApp) → Loki `app` label of the backend service
const SERVICE_APPS = [
  { re: /^\/rpkweb\//, app: 'rupeekwebsvc' },
  { re: /^\/coresvc\//, app: 'coresvc' },
  { re: /^\/titans\//, app: 'titans' },
  { re: /^\/andromeda\//, app: 'andromeda' },
  { re: /^\/referralproxy\//, app: 'referralproxy' },
  { re: /^\/coreproxy\//, app: 'coreproxy' },
  { re: /^\/heimdall\//, app: 'heimdallapi' },
  { re: /^\/(v\d+\/)?collaterals\//, app: 'collateralsapi' },
];
const appForPath = (p) => SERVICE_APPS.find((s) => s.re.test(p))?.app || null;

const LINE_CAP = 4000;
const WINDOW_BEFORE_MS = 60e3; // client logs after the response; backend work happens before
const WINDOW_AFTER_MS = 10e3;

function redact(line) {
  return line
    .replace(/\b(JWT|Bearer)\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '$1 ██')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '██');
}

function levelOf(line) {
  if (/\b(ERROR|FATAL)\b|\berror:|\bException\b|"level":"error"/i.test(line.slice(0, 400))) return 'error';
  if (/"responseCode":\s*[45]\d\d|\bstatus(?:Code)?[=:]\s*"?[45]\d\d\b/.test(line)) return 'error';
  if (/\bWARN(ING)?\b|\bwarn:/i.test(line.slice(0, 400))) return 'warn';
  if (/\bDEBUG\b|\bdebug:/.test(line.slice(0, 400))) return 'debug';
  return 'info';
}

// Trace ids as different services print them
const TRACE_RES = [
  /trace_id=([0-9a-f]{32})/i,
  /\[traceId:([0-9a-f-]{32,36})\]/i,
  /^\[([0-9a-f]{32})\]/i,
  /(?:In|Out) -> ([0-9a-f]{32})\b/i,
];
function tracesIn(line) {
  const out = new Set();
  for (const re of TRACE_RES) { const m = line.match(re); if (m) out.add(m[1].toLowerCase()); }
  return [...out];
}

async function serviceLogs(auth, { path: apiPath, trace, id, t, scope }) {
  const app = appForPath(apiPath || '');
  const from = t - WINDOW_BEFORE_MS, to = t + WINDOW_AFTER_MS;
  const needle = trace || id;
  if (!needle) throw new Error('Need a trace id or loanRequestId');
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(needle)) throw new Error('Invalid search key');
  if (scope !== 'all' && !app) throw new Error(`No backend service mapped for ${apiPath}`);
  const selector = scope === 'all' ? '{namespace="logistics"}' : `{app="${app}"}`;
  const logql = `${selector} |= "${needle}"`;
  const raw = await lokiQueryRange(auth, logql, BigInt(from) * 1000000n, BigInt(to) * 1000000n, { pageLimit: 500, maxPages: 1 });
  const traces = new Set();
  const lines = raw.map((r) => {
    const full = redact(r.line);
    tracesIn(full).forEach((x) => traces.add(x));
    return {
      time: Number(BigInt(r.ts) / 1000000n),
      app: r.labels.app, pod: r.labels.pod,
      level: levelOf(full),
      line: full.length > LINE_CAP ? full.slice(0, LINE_CAP) : full,
      truncated: full.length > LINE_CAP ? full.length : 0,
    };
  });
  return {
    app, scope: scope === 'all' ? 'all' : 'app',
    matchedBy: trace ? 'trace' : 'loanRequestId', key: needle,
    logql, from, to, grafana: GRAFANA_URL, dsUid: LOKI_DS_UID,
    traces: [...traces].filter((x) => x !== (trace || '').toLowerCase()),
    lines, capped: raw.length >= 500,
  };
}

// ---- http ----------------------------------------------------------------

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (u.pathname === '/api/login' && req.method === 'POST') {
      if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected JSON' });
      const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
      if (throttled(ip)) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
      const { username, password } = await readJson(req);
      if (!username || !password) return send(res, 400, { error: 'Enter your username and password' });
      const user = await grafanaUser(String(username), String(password));
      if (!user) return send(res, 401, { error: 'Invalid username or password' });
      loginAttempts.delete(ip);
      const me = { login: user.login, name: user.name || user.login, email: user.email || '' };
      const token = seal({ u: String(username), p: String(password), me, exp: Date.now() + SESSION_TTL_MS });
      res.setHeader('Set-Cookie', sessionCookie(req, token, SESSION_TTL_MS / 1000));
      return send(res, 200, { user: me });
    }
    if (u.pathname === '/api/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
      return send(res, 200, { ok: true });
    }

    const session = u.pathname.startsWith('/api/') ? getSession(req) : null;
    if (u.pathname.startsWith('/api/') && !session) return send(res, 401, { error: 'Please sign in' });
    const auth = session && basicAuth(session.u, session.p);

    if (u.pathname === '/api/me') return send(res, 200, { user: session.me });
    if (u.pathname === '/api/journey') {
      const id = (u.searchParams.get('id') || '').trim();
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return send(res, 400, { error: 'Invalid loanRequestId' });
      const now = Date.now();
      const from = Number(u.searchParams.get('from')) || now - 24 * 3600e3;
      const to = Number(u.searchParams.get('to')) || now;
      const logql = `{app="lmApp"} |= "${id}"`;
      const raw = await lokiQueryRange(auth, logql, BigInt(from) * 1000000n, BigInt(to) * 1000000n);
      const journey = buildJourney(id, raw);
      journey.query = { logql, from, to, grafana: GRAFANA_URL, dsUid: LOKI_DS_UID };
      return send(res, 200, journey);
    }
    if (u.pathname === '/api/service-logs') {
      const q = Object.fromEntries(u.searchParams);
      return send(res, 200, await serviceLogs(auth, { ...q, t: Number(q.t) || Date.now() }));
    }
    // Render the page in the right state (login vs app) up front, so a refresh never flashes the other one
    if (u.pathname === '/' || u.pathname === '/index.html') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
      const signedIn = !!getSession(req);
      const out = signedIn
        ? html.replace('<body class="signed-out">', '<body>').replace('id="app" hidden', 'id="app"')
        : html.replace('<section id="login" hidden>', '<section id="login">');
      return send(res, 200, out, 'text/html');
    }
    const file = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
    const full = path.join(__dirname, 'public', path.normalize(file));
    if (!full.startsWith(path.join(__dirname, 'public'))) return send(res, 403, 'no', 'text/plain');
    const ext = path.extname(full);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    fs.readFile(full, (err, data) => (err ? send(res, 404, 'not found', 'text/plain') : send(res, 200, data, types[ext] || 'application/octet-stream')));
  } catch (e) {
    if (e.status === 401) res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    send(res, e.status || 502, { error: e.message });
  }
});

if (require.main === module || process.env.VERCEL) {
  server.listen(PORT, HOST, () => console.log(`Loan Journey Viewer → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
}
module.exports = { seal, unseal, parseLine, buildJourney, classify, STAGES, appForPath, redact, tracesIn, levelOf };
