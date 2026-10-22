# Smart Indexer Pro

A local dashboard that submits URLs to the Google Indexing API in bulk. It rotates across several service account keys and has two submission modes:

- **DIRECT**: the URL itself is submitted. Use this for domains you have verified in Search Console.
- **BRIDGE**: the app registers a short slug on your Cloudflare Worker (`https://idx.yourdomain.com/abc123xyz`) and submits that bridge URL. The Worker then redirects to the target, or serves a small page that links to it.

```
smart-indexer/
├── server.js              Express API + static dashboard
├── indexer.js             key scanning, quota tracking, queue processor, Google/Worker calls
├── database.js            SQLite schema (service_accounts, submissions, settings)
├── public/index.html      dashboard (Tailwind CDN + vanilla JS)
├── keys/                  your service account .json files (git-ignored)
├── data/                  SQLite database (created on first run)
└── cloudflare-worker/
    ├── worker.js          bridge Worker
    └── wrangler.toml
```

## 1. Run the app

```bash
npm install
npm start
```

Open http://127.0.0.1:3000.

To try the queue without touching Google, run `npm run dry-run`. Google calls are simulated and no quota is used, but bridge registration with the Worker still happens for real.

Optional settings go in a `.env` file (see `.env.example`): `PORT`, `HOST`, `KEYS_DIR`, `DB_PATH`, `DRY_RUN`.

## 2. Google setup (once per key)

1. In Google Cloud Console, create a project and enable the **Web Search Indexing API**.
2. Create a service account in that project, add a **JSON key**, and save the file in `./keys/`.
3. In Search Console, open each property you will submit URLs for, go to **Settings → Users and permissions**, and add the service account email (`...@...iam.gserviceaccount.com`) as an **Owner**. In BRIDGE mode, the property you need is the bridge domain (`idx.yourdomain.com`), not the target sites.
4. In the dashboard, click **Sync Keys**, then **Test auth** on the key.

**How quota works:** Google gives each Cloud **project** 200 publish requests per day. That is a per-project limit, not per key. Two keys from the same project share one 200 pool. Keys from different projects each add another 200. The dashboard groups keys by project and counts quota that way. Quotas reset at midnight Pacific time. If Google answers `429`, the app marks that project as exhausted for the day. When every project is exhausted, the queue pauses and resumes on its own after the reset.

Google officially supports the Indexing API only for pages with `JobPosting` or `BroadcastEvent` markup. Google may ignore other URLs, or revoke access if it sees misuse. Using extra projects to raise your quota can break Google's API terms. That risk is on you.

## 3. Deploy the Cloudflare Worker (BRIDGE mode)

Requirements: a Cloudflare account, and your domain's DNS on Cloudflare.

```bash
cd cloudflare-worker
npx wrangler login
npx wrangler kv namespace create LINKS_KV      # paste the printed id into wrangler.toml
npx wrangler secret put API_KEY                # choose a long random string
npx wrangler deploy
```

Then attach your bridge subdomain. Either uncomment the `routes` block in `wrangler.toml` and deploy again, or add it in the dashboard under **Workers → smart-indexer-bridge → Settings → Domains & Routes → Custom Domain** (for example `idx.yourdomain.com`).

Check that it works:

```bash
curl -H "X-API-KEY: <your key>" https://idx.yourdomain.com/api/health
```

In the app, open **Settings**, enter `https://idx.yourdomain.com` and the same API key, then click **Test Bridge**.

Verify `idx.yourdomain.com` (or the whole `yourdomain.com` domain property) in Search Console, and add the service account emails as Owners. Without that, Google rejects the bridge URLs with "Failed to verify the URL ownership".

### Bridge strategies

| Strategy | What visitors and Googlebot get |
| --- | --- |
| `301_REDIRECT` | `301 Moved Permanently` to the target URL |
| `HTML_BRIDGE` | A small indexable page with title/description meta tags, a 3-second meta refresh, and a plain link to the target |

Worker API (every call needs the `X-API-KEY` header):

- `POST /api/create` with `{ "slug": "abc123xyz", "targetUrl": "https://…", "mode": "HTML_BRIDGE" }`
- `GET /api/health`
- `GET /api/link/:slug`, `DELETE /api/link/:slug`

## API reference (local app)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/stats` | keys, quota, today's counts, queue state |
| POST | `/api/submit` | `{ urls, mode, action, strategy }`, where `urls` is a newline-separated string or an array |
| GET | `/api/logs` | `?status=&mode=&search=&limit=&offset=` |
| GET | `/api/logs/export` | CSV export (same filters) |
| POST | `/api/retry-failed` | put failed URLs back in the queue |
| POST | `/api/queue/pause` · `/resume` · `/clear` | queue control |
| GET/POST | `/api/settings` | bridge URL, worker key (write-only), delay, daily limit |
| POST | `/api/settings/test-bridge` | call the Worker's `/api/health` |
| POST | `/api/sync-keys` | rescan `./keys` |
| POST | `/api/keys/:id/test` · `/toggle` | check a key's auth, or enable/disable it |
