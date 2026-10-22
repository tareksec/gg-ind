import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getSettings, saveSettings, quotaDay } from './database.js';
import {
  ACTIONS,
  MODES,
  STATUSES,
  STRATEGIES,
  clearPending,
  enqueue,
  initIndexer,
  pauseQueue,
  queueState,
  quotaSnapshot,
  resumeQueue,
  retryFailed,
  setKeyEnabled,
  syncKeys,
  testBridge,
  testKey,
} from './indexer.js';

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_URLS_PER_SUBMIT = 10_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors({ origin: [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`] }));
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (handler) => (req, res) =>
  Promise.resolve(handler(req, res)).catch((err) => {
    console.error(`[api] ${req.method} ${req.path}:`, err);
    res.status(500).json({ error: err.message });
  });

/* ---------------------------- stats ---------------------------- */

app.get('/api/stats', wrap((req, res) => {
  const quota = quotaSnapshot();
  const today = db
    .prepare(`SELECT
                COUNT(*) AS submitted,
                SUM(status = 'success') AS success,
                SUM(status = 'failed') AS failed
              FROM submissions WHERE processed_day = ?`)
    .get(quotaDay());
  const settings = getSettings();

  res.json({
    keys: {
      active: quota.activeKeys,
      total: quota.accounts.length,
      list: quota.accounts.map((a) => ({
        id: a.id,
        file_name: a.file_name,
        client_email: a.client_email,
        project_id: a.project_id,
        status: a.status,
        used: a.used,
        exhausted: a.exhausted,
        project_remaining: a.projectRemaining,
        total_used: a.total_used,
        last_used_at: a.last_used_at,
        last_error: a.last_error,
      })),
    },
    quota: {
      day: quota.day,
      limit: quota.limit,
      total: quota.total,
      remaining: quota.remaining,
      used: quota.used,
      projects: quota.projects,
    },
    today: { submitted: today.submitted || 0, success: today.success || 0, failed: today.failed || 0 },
    queue: queueState(),
    bridgeConfigured: Boolean(settings.bridge_base_url && settings.worker_api_key),
  });
}));

/* --------------------------- submit ---------------------------- */

app.post('/api/submit', wrap((req, res) => {
  const { urls, mode = 'DIRECT', action = 'URL_UPDATED', strategy = 'HTML_BRIDGE' } = req.body || {};
  const list = Array.isArray(urls) ? urls.map(String) : String(urls || '').split(/[\r\n]+/);

  if (!MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of ${MODES.join(', ')}` });
  if (!ACTIONS.includes(action)) return res.status(400).json({ error: `action must be one of ${ACTIONS.join(', ')}` });
  if (mode === 'BRIDGE' && !STRATEGIES.includes(strategy)) {
    return res.status(400).json({ error: `strategy must be one of ${STRATEGIES.join(', ')}` });
  }
  if (list.filter((u) => u.trim()).length > MAX_URLS_PER_SUBMIT) {
    return res.status(400).json({ error: `At most ${MAX_URLS_PER_SUBMIT} URLs per submission` });
  }
  if (mode === 'BRIDGE') {
    const s = getSettings();
    if (!s.bridge_base_url || !s.worker_api_key) {
      return res.status(400).json({ error: 'BRIDGE mode needs the Bridge URL and Worker API key (open Settings)' });
    }
  }

  const result = enqueue(list, { mode, action, strategy });
  if (!result.queued) return res.status(400).json({ error: 'No valid http(s) URLs found', ...result });
  res.json(result);
}));

/* ---------------------------- logs ----------------------------- */

function logFilter(query) {
  const where = [];
  const params = {};
  if (STATUSES.includes(query.status)) {
    where.push('status = @status');
    params.status = query.status;
  }
  if (MODES.includes(query.mode)) {
    where.push('mode = @mode');
    params.mode = query.mode;
  }
  if (query.batch) {
    where.push('batch_id = @batch');
    params.batch = String(query.batch);
  }
  if (query.search) {
    where.push('(url LIKE @search OR bridge_url LIKE @search OR service_account LIKE @search OR message LIKE @search)');
    params.search = `%${String(query.search).trim()}%`;
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

app.get('/api/logs', wrap((req, res) => {
  const { sql, params } = logFilter(req.query);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM submissions ${sql}`).get(params).n;
  const rows = db
    .prepare(`SELECT * FROM submissions ${sql} ORDER BY id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset });
  res.json({ total, limit, offset, rows });
}));

const CSV_COLUMNS = [
  'id', 'url', 'mode', 'action', 'strategy', 'bridge_url', 'status', 'service_account',
  'project_id', 'http_status', 'message', 'attempts', 'batch_id', 'created_at', 'processed_at',
];

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; // stop spreadsheet formula injection
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

app.get('/api/logs/export', wrap((req, res) => {
  const { sql, params } = logFilter(req.query);
  const rows = db.prepare(`SELECT * FROM submissions ${sql} ORDER BY id DESC`).all(params);
  const lines = [CSV_COLUMNS.join(','), ...rows.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(','))];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="smart-indexer-${quotaDay()}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
}));

app.post('/api/retry-failed', wrap((req, res) => res.json({ requeued: retryFailed() })));

/* ---------------------------- queue ---------------------------- */

app.post('/api/queue/pause', wrap((req, res) => {
  pauseQueue();
  res.json(queueState());
}));

app.post('/api/queue/resume', wrap((req, res) => {
  resumeQueue();
  res.json(queueState());
}));

app.post('/api/queue/clear', wrap((req, res) => res.json({ removed: clearPending() })));

/* ----------------------------- keys ---------------------------- */

app.post('/api/sync-keys', wrap((req, res) => res.json(syncKeys())));

app.post('/api/keys/:id/test', wrap(async (req, res) => res.json(await testKey(Number(req.params.id)))));

app.post('/api/keys/:id/toggle', wrap((req, res) => {
  const ok = setKeyEnabled(Number(req.params.id), Boolean(req.body?.enabled));
  if (!ok) return res.status(400).json({ error: 'Key cannot be toggled (missing from ./keys?)' });
  res.json({ ok });
}));

/* --------------------------- settings -------------------------- */

function publicSettings() {
  const { worker_api_key, ...rest } = getSettings();
  return { ...rest, worker_api_key_set: Boolean(worker_api_key) };
}

app.get('/api/settings', wrap((req, res) => res.json(publicSettings())));

app.post('/api/settings', wrap((req, res) => {
  const body = req.body || {};
  const updates = {};

  if (body.bridge_base_url !== undefined) {
    const value = String(body.bridge_base_url).trim().replace(/\/+$/, '');
    if (value) {
      let parsed;
      try {
        parsed = new URL(value);
      } catch {
        return res.status(400).json({ error: 'Bridge URL is not a valid URL' });
      }
      // http is only accepted for a local `wrangler dev` Worker
      const local = ['localhost', '127.0.0.1'].includes(parsed.hostname);
      if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
        return res.status(400).json({ error: 'Bridge URL must start with https://' });
      }
      updates.bridge_base_url = parsed.origin;
    } else {
      updates.bridge_base_url = '';
    }
  }
  // The key is write-only: an empty field keeps the saved key, clear_worker_api_key removes it.
  if (body.clear_worker_api_key) updates.worker_api_key = '';
  else if (body.worker_api_key) updates.worker_api_key = String(body.worker_api_key).trim();

  if (body.delay_ms !== undefined) {
    const delay = parseInt(body.delay_ms, 10);
    if (!(delay >= 0 && delay <= 600_000)) return res.status(400).json({ error: 'Delay must be 0 - 600000 ms' });
    updates.delay_ms = delay;
  }
  if (body.daily_limit !== undefined) {
    const limit = parseInt(body.daily_limit, 10);
    if (!(limit >= 1 && limit <= 1_000_000)) return res.status(400).json({ error: 'Daily limit must be at least 1' });
    updates.daily_limit = limit;
  }
  if (body.default_mode !== undefined && MODES.includes(body.default_mode)) updates.default_mode = body.default_mode;
  if (body.default_action !== undefined && ACTIONS.includes(body.default_action)) updates.default_action = body.default_action;
  if (body.default_strategy !== undefined && STRATEGIES.includes(body.default_strategy)) {
    updates.default_strategy = body.default_strategy;
  }

  saveSettings(updates);
  res.json(publicSettings());
}));

app.post('/api/settings/test-bridge', wrap(async (req, res) => {
  try {
    res.json(await testBridge());
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

/* ----------------------------- start --------------------------- */

const sync = initIndexer();
app.listen(PORT, HOST, () => {
  const q = queueState();
  console.log(`Smart Indexer Pro running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Keys: ${sync.valid} valid, ${sync.invalid.length} invalid, ${sync.missing} missing | pending: ${q.counts.pending}`);
  if (q.dryRun) console.log('DRY RUN is on: Google is NOT contacted and no quota is used.');
});
