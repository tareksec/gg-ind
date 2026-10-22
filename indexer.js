import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import { customAlphabet, nanoid } from 'nanoid';
import { db, getSettings, nowIso, quotaDay } from './database.js';

const KEYS_DIR = path.resolve(process.env.KEYS_DIR || './keys');
export const DRY_RUN = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');

const SCOPES = ['https://www.googleapis.com/auth/indexing'];
const RATE_LIMIT_PAUSE_MS = 60_000;
const QUOTA_RECHECK_MS = 60_000;

export const MODES = ['DIRECT', 'BRIDGE'];
export const ACTIONS = ['URL_UPDATED', 'URL_DELETED'];
export const STRATEGIES = ['301_REDIRECT', 'HTML_BRIDGE'];
export const STATUSES = ['pending', 'processing', 'success', 'failed', 'quota_exceeded'];

const makeSlug = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 10);
const indexing = google.indexing('v3');
const jwtClients = new Map(); // file_name -> google.auth.JWT

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* Key scanning                                                        */
/* ------------------------------------------------------------------ */

function readKeyFile(fileName) {
  const raw = JSON.parse(fs.readFileSync(path.join(KEYS_DIR, fileName), 'utf8'));
  if (raw.type !== 'service_account') throw new Error('Not a service account key (type must be "service_account")');
  if (!raw.client_email || !raw.private_key) throw new Error('Key file is missing client_email or private_key');
  return raw;
}

export function syncKeys() {
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  const files = fs.readdirSync(KEYS_DIR).filter((f) => f.toLowerCase().endsWith('.json'));

  const upsert = db.prepare(`
    INSERT INTO service_accounts (file_name, client_email, project_id, status, last_error)
    VALUES (@file_name, @client_email, @project_id, @status, @last_error)
    ON CONFLICT(file_name) DO UPDATE SET
      client_email = excluded.client_email,
      project_id   = excluded.project_id,
      -- a re-sync gives invalid/missing keys another chance; disabled stays disabled
      status       = CASE WHEN service_accounts.status = 'disabled' AND excluded.status = 'active'
                          THEN 'disabled' ELSE excluded.status END,
      last_error   = excluded.last_error,
      updated_at   = @now
  `);

  const result = { scanned: files.length, valid: 0, invalid: [], missing: 0 };
  db.transaction(() => {
    for (const file_name of files) {
      try {
        const key = readKeyFile(file_name);
        upsert.run({
          file_name,
          client_email: key.client_email,
          project_id: key.project_id || key.client_email.split('@')[1]?.split('.')[0] || 'unknown',
          status: 'active',
          last_error: null,
          now: nowIso(),
        });
        result.valid++;
      } catch (err) {
        upsert.run({ file_name, client_email: '', project_id: '', status: 'invalid', last_error: err.message, now: nowIso() });
        result.invalid.push({ file: file_name, error: err.message });
      }
    }
    result.missing = db
      .prepare(`UPDATE service_accounts SET status = 'missing', updated_at = ?
                WHERE status != 'missing' AND file_name NOT IN (SELECT value FROM json_each(?))`)
      .run(nowIso(), JSON.stringify(files)).changes;
  })();

  jwtClients.clear();
  kick();
  return result;
}

function getJwtClient(account) {
  let client = jwtClients.get(account.file_name);
  if (!client) {
    const key = readKeyFile(account.file_name);
    client = new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes: SCOPES });
    jwtClients.set(account.file_name, client);
  }
  return client;
}

/* ------------------------------------------------------------------ */
/* Quota tracking                                                      */
/* ------------------------------------------------------------------ */

// Google enforces the 200/day publish quota per Google Cloud *project*, not per service account.
// Several keys from the same project therefore share one pool; keys from different projects add up.
export function quotaSnapshot() {
  const today = quotaDay();
  const limit = Math.max(1, parseInt(getSettings().daily_limit, 10) || 200);

  const accounts = db
    .prepare('SELECT * FROM service_accounts ORDER BY id')
    .all()
    .map((a) => ({
      ...a,
      used: a.usage_date === today ? a.used_today : 0,
      exhausted: a.exhausted_date === today,
    }));

  const projects = new Map();
  for (const a of accounts) {
    if (!a.project_id) continue;
    const p = projects.get(a.project_id) || { project_id: a.project_id, keys: 0, activeKeys: 0, used: 0, exhausted: false };
    p.keys++;
    p.used += a.used; // usage by disabled/missing keys still drained the project's pool
    if (a.status === 'active') p.activeKeys++;
    p.exhausted ||= a.exhausted;
    projects.set(a.project_id, p);
  }

  const usable = [...projects.values()].filter((p) => p.activeKeys > 0);
  for (const p of projects.values()) {
    p.limit = limit;
    p.remaining = p.exhausted ? 0 : Math.max(0, limit - p.used);
  }
  for (const a of accounts) a.projectRemaining = projects.get(a.project_id)?.remaining ?? 0;

  return {
    day: today,
    limit,
    accounts,
    projects: [...projects.values()],
    activeKeys: accounts.filter((a) => a.status === 'active').length,
    total: usable.length * limit,
    remaining: usable.reduce((sum, p) => sum + p.remaining, 0),
    used: usable.reduce((sum, p) => sum + Math.min(p.used, limit), 0),
  };
}

let lastAccountId = 0;

// Round-robin across active keys whose project still has quota left today.
function pickAccount() {
  const candidates = quotaSnapshot().accounts.filter((a) => a.status === 'active' && a.projectRemaining > 0);
  if (!candidates.length) return null;
  const next = candidates.find((a) => a.id > lastAccountId) || candidates[0];
  lastAccountId = next.id;
  return next;
}

function recordUsage(account) {
  const today = quotaDay();
  db.prepare(`
    UPDATE service_accounts SET
      used_today   = CASE WHEN usage_date = @today THEN used_today + 1 ELSE 1 END,
      usage_date   = @today,
      total_used   = total_used + 1,
      last_used_at = @now,
      updated_at   = @now
    WHERE id = @id
  `).run({ id: account.id, today, now: nowIso() });
}

function markProjectExhausted(projectId, message) {
  db.prepare('UPDATE service_accounts SET exhausted_date = ?, last_error = ?, updated_at = ? WHERE project_id = ?')
    .run(quotaDay(), message, nowIso(), projectId);
}

function markKeyInvalid(account, message) {
  db.prepare("UPDATE service_accounts SET status = 'invalid', last_error = ?, updated_at = ? WHERE id = ?")
    .run(message, nowIso(), account.id);
  jwtClients.delete(account.file_name);
}

export function setKeyEnabled(id, enabled) {
  const info = db
    .prepare(`UPDATE service_accounts SET status = ?, updated_at = ?
              WHERE id = ? AND status IN ('active', 'disabled', 'invalid')`)
    .run(enabled ? 'active' : 'disabled', nowIso(), id);
  if (enabled) kick();
  return info.changes > 0;
}

// Fetches an OAuth access token for the key. Proves the key works without spending quota.
export async function testKey(id) {
  const account = db.prepare('SELECT * FROM service_accounts WHERE id = ?').get(id);
  if (!account) throw new Error('Key not found');
  jwtClients.delete(account.file_name);
  try {
    await getJwtClient(account).authorize();
    db.prepare("UPDATE service_accounts SET status = CASE WHEN status = 'invalid' THEN 'active' ELSE status END, last_error = NULL, updated_at = ? WHERE id = ?")
      .run(nowIso(), id);
    kick();
    return { ok: true, message: `Authenticated as ${account.client_email}` };
  } catch (err) {
    const message = describeError(err).message;
    markKeyInvalid(account, message);
    return { ok: false, message };
  }
}

/* ------------------------------------------------------------------ */
/* Google + Cloudflare calls                                           */
/* ------------------------------------------------------------------ */

async function publish(account, url, type) {
  if (DRY_RUN) {
    await sleep(120);
    return { status: 200, data: { urlNotificationMetadata: { url, latestUpdate: { url, type, notifyTime: nowIso() } } } };
  }
  const res = await indexing.urlNotifications.publish({ auth: getJwtClient(account), requestBody: { url, type } });
  return { status: res.status, data: res.data };
}

function bridgeConfig(settings) {
  const base = (settings.bridge_base_url || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('Bridge URL is not configured (open Settings)');
  if (!settings.worker_api_key) throw new Error('Worker API key is not configured (open Settings)');
  return { base, apiKey: settings.worker_api_key };
}

async function callWorker(settings, method, endpoint, body) {
  const { base, apiKey } = bridgeConfig(settings);
  const res = await fetch(`${base}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Worker responded ${res.status}: ${data.error || res.statusText}`);
  return { base, data };
}

async function registerBridge(settings, slug, targetUrl, strategy) {
  const { base, data } = await callWorker(settings, 'POST', '/api/create', { slug, targetUrl, mode: strategy });
  return data.url || `${base}/${slug}`;
}

export async function testBridge() {
  const settings = getSettings();
  const { base, data } = await callWorker(settings, 'GET', '/api/health');
  return { ok: true, message: `Worker at ${base} is reachable (KV binding: ${data.kv ? 'ok' : 'missing'})`, data };
}

function describeError(err) {
  const status = err.response?.status || (typeof err.code === 'number' ? err.code : 0);
  const body = err.response?.data;
  const apiError = body?.error;
  let message, reason;
  if (apiError && typeof apiError === 'object') {
    message = apiError.message;
    reason = apiError.status || apiError.errors?.[0]?.reason;
  } else {
    reason = apiError; // OAuth token endpoint errors: { error: 'invalid_grant', error_description }
    message = body?.error_description || apiError;
  }
  return { status, reason: reason || '', message: message || err.message || String(err) };
}

function classifyError(err) {
  const info = describeError(err);
  const text = `${info.reason} ${info.message}`;
  if (info.status === 429 || /RESOURCE_EXHAUSTED|rateLimitExceeded|quota/i.test(info.reason)) {
    return { ...info, kind: /per minute/i.test(info.message) ? 'rate' : 'quota' };
  }
  if (/invalid_grant|invalid_client|unauthorized_client|DECODER|PEM|private key/i.test(text) || info.status === 401) {
    return { ...info, kind: 'auth' };
  }
  if (info.status === 403 && /has not been used|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(text)) {
    return { ...info, kind: 'auth', message: `Indexing API is not enabled for this project. ${info.message}` };
  }
  if (info.status === 403 && /ownership/i.test(info.message)) {
    return {
      ...info,
      kind: 'item',
      message: `${info.message} Add the service account email as an Owner of this domain in Search Console.`,
    };
  }
  return { ...info, kind: 'item' };
}

/* ------------------------------------------------------------------ */
/* Queue                                                               */
/* ------------------------------------------------------------------ */

const state = {
  running: false,
  paused: false,
  status: 'idle', // idle | running | paused | quota_exhausted | no_keys | rate_limited
  message: '',
  current: null,
};
let wake = null; // resolves the current inter-request wait early (pause/resume)
let recheckTimer = null;

function interruptibleSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  }).finally(() => {
    wake = null;
  });
}

function setStatus(status, message = '') {
  state.status = status;
  state.message = message;
}

function updateSubmission(id, fields) {
  const cols = Object.keys(fields);
  db.prepare(`UPDATE submissions SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...fields, id, updated_at: nowIso() });
}

function nextItem() {
  return db
    .prepare("SELECT * FROM submissions WHERE status IN ('pending', 'quota_exceeded') ORDER BY id LIMIT 1")
    .get();
}

async function processItem(item, account) {
  const settings = getSettings();
  updateSubmission(item.id, {
    status: 'processing',
    attempts: item.attempts + 1,
    service_account: account.client_email,
    project_id: account.project_id,
  });

  let submitUrl = item.url;
  if (item.mode === 'BRIDGE') {
    try {
      if (!item.bridge_url) {
        const slug = item.slug || makeSlug();
        const bridgeUrl = await registerBridge(settings, slug, item.url, item.strategy);
        updateSubmission(item.id, { slug, bridge_url: bridgeUrl });
        item.bridge_url = bridgeUrl;
      }
      submitUrl = item.bridge_url;
    } catch (err) {
      updateSubmission(item.id, {
        status: 'failed',
        http_status: null,
        message: `Bridge registration failed: ${err.message}`,
        processed_at: nowIso(),
      });
      return 'done';
    }
  }

  const sentAt = { processed_at: nowIso(), processed_day: quotaDay() };
  try {
    const res = await publish(account, submitUrl, item.action);
    recordUsage(account);
    const notifyTime = res.data?.urlNotificationMetadata?.latestUpdate?.notifyTime;
    updateSubmission(item.id, {
      status: 'success',
      http_status: res.status,
      message: `${DRY_RUN ? '[DRY RUN] ' : ''}${item.action} accepted${notifyTime ? ` (notifyTime ${notifyTime})` : ''}`,
      ...sentAt,
    });
    return 'done';
  } catch (err) {
    const error = classifyError(err);
    switch (error.kind) {
      case 'auth':
        markKeyInvalid(account, error.message);
        updateSubmission(item.id, {
          status: 'pending',
          http_status: error.status || null,
          message: `Key ${account.client_email} rejected (${error.message}); will retry with another key`,
        });
        return 'retry';
      case 'quota':
        markProjectExhausted(account.project_id, error.message);
        updateSubmission(item.id, { status: 'quota_exceeded', http_status: error.status || 429, message: error.message });
        return 'retry';
      case 'rate':
        updateSubmission(item.id, { status: 'pending', http_status: error.status, message: error.message });
        return 'rate';
      default:
        if (error.status) recordUsage(account); // the request reached Google and counts against quota
        updateSubmission(item.id, {
          status: 'failed',
          http_status: error.status || null,
          message: error.message,
          ...sentAt,
        });
        return 'done';
    }
  }
}

async function runLoop() {
  while (!state.paused) {
    const item = nextItem();
    if (!item) return setStatus('idle');

    const account = pickAccount();
    if (!account) {
      const { activeKeys } = quotaSnapshot();
      if (activeKeys === 0) {
        setStatus('no_keys', 'No active service account keys. Add .json keys to ./keys and click "Sync Keys".');
      } else {
        setStatus('quota_exhausted', 'All keys have used today\'s quota. The queue resumes automatically after midnight Pacific time.');
        clearTimeout(recheckTimer);
        recheckTimer = setTimeout(kick, QUOTA_RECHECK_MS);
      }
      return;
    }

    setStatus('running');
    state.current = item.mode === 'BRIDGE' ? `${item.url} (bridge)` : item.url;
    const outcome = await processItem(item, account);
    state.current = null;

    if (outcome === 'rate') {
      setStatus('rate_limited', 'Google per-minute rate limit hit. Waiting 60 seconds.');
      await interruptibleSleep(RATE_LIMIT_PAUSE_MS);
    } else if (outcome === 'done') {
      await interruptibleSleep(Math.max(0, parseInt(getSettings().delay_ms, 10) || 0));
    }
  }
  setStatus('paused', 'Queue paused by user.');
}

export function kick() {
  if (state.running || state.paused) return;
  state.running = true;
  runLoop()
    .catch((err) => {
      console.error('[queue] crashed:', err);
      setStatus('idle', `Queue error: ${err.message}`);
    })
    .finally(() => {
      state.running = false;
    });
}

export function pauseQueue() {
  state.paused = true;
  wake?.();
  if (!state.running) setStatus('paused', 'Queue paused by user.');
}

export function resumeQueue() {
  state.paused = false;
  wake?.();
  if (state.status === 'paused') setStatus('idle');
  kick();
}

export function queueState() {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM submissions GROUP BY status').all()) counts[row.status] = row.n;
  return { ...state, counts, dryRun: DRY_RUN };
}

/* ------------------------------------------------------------------ */
/* Enqueueing                                                          */
/* ------------------------------------------------------------------ */

function normalizeUrl(value) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function enqueue(rawUrls, { mode, action, strategy }) {
  const seen = new Set();
  const valid = [];
  const invalid = [];
  let duplicates = 0;

  for (const line of rawUrls) {
    if (!line.trim()) continue;
    const url = normalizeUrl(line);
    if (!url) invalid.push(line.trim());
    else if (seen.has(url)) duplicates++;
    else {
      seen.add(url);
      valid.push(url);
    }
  }

  const batchId = nanoid(10);
  const insert = db.prepare(
    'INSERT INTO submissions (batch_id, url, mode, action, strategy) VALUES (?, ?, ?, ?, ?)'
  );
  db.transaction(() => {
    for (const url of valid) insert.run(batchId, url, mode, action, mode === 'BRIDGE' ? strategy : null);
  })();

  kick();
  return { batchId, queued: valid.length, invalid, duplicates };
}

export function retryFailed() {
  const changes = db
    .prepare("UPDATE submissions SET status = 'pending', message = 'Queued for retry', updated_at = ? WHERE status = 'failed'")
    .run(nowIso()).changes;
  kick();
  return changes;
}

export function clearPending() {
  return db.prepare("DELETE FROM submissions WHERE status IN ('pending', 'quota_exceeded')").run().changes;
}

export function initIndexer() {
  // Anything left "processing" by a previous crash/shutdown goes back in the queue.
  db.prepare("UPDATE submissions SET status = 'pending', updated_at = ? WHERE status = 'processing'").run(nowIso());
  return syncKeys();
}
