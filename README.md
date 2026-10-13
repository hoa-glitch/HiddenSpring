# HOA Website

A static HTML/CSS/JS site with one small Lambda API for announcements, downloadable documents, and an email list.
Step-by-step AWS setup lives in the "HOA Website Setup Guide" document.

## How it fits together

```
GitHub repo ──(push)──> Amplify Hosting ──> serves site/ on your domain (HTTPS)

Browser ──> Amplify (site/)
   │
   └──> Lambda function URL (api/) ──> RDS PostgreSQL
                    ├──> S3 documents bucket (signed upload/download links)
                    └──> SES (confirmation + announcement emails)
```

Board members sign in with a username and password (HTTP Basic auth over HTTPS).
Passwords are stored only as PBKDF2-SHA256 hashes in the Lambda's ADMIN_USERS setting.

## Project layout

```
amplify.yml                 Tells Amplify to publish site/ as is (no build step)
site/                       The website Amplify serves
  js/config.js              <-- set hoaName and apiBaseUrl (your function URL)
api/
  hoa-api.zip               Lambda package (handler: src/index.handler); not in git, rebuild it
  src/                      Lambda source (Node.js 22+, ES modules)
  src/sql/schema.sql        Tables, created by the "setup-database" test event
  tools/make-password.html  Makes ADMIN_USERS lines; runs locally, sends nothing
  tools/make-password.mjs   Same, for the command line
db/schema.sql, db/seed.sql  Schema (keep in sync with api/src/sql/schema.sql) and sample data
```

## Lambda environment variables

| Name | Example |
|---|---|
| DATABASE_URL | `postgres://user:pass@host.rds.amazonaws.com:5432/dbname` (URL-encode special characters) |
| DOCS_BUCKET | `yourhoa-documents` |
| SES_FROM | `Maple Ridge HOA <board@yourhoa.org>` |
| ADMIN_USERS | `jane:600000:<salt>:<hash>,tom:600000:<salt>:<hash>` |
| SITE_URL | `https://yourhoa.org` (or the `amplifyapp.com` address while testing) |
| ALLOWED_ORIGIN | `https://yourhoa.org,https://www.yourhoa.org` |
| API_URL | `https://abc123.lambda-url.us-east-1.on.aws` |
| PGSSL | Optional. `false` only for a local database without SSL |

## API routes

| Method | Path | Who |
|---|---|---|
| GET | /announcements | Public |
| POST | /announcements | Board (optionally emails subscribers) |
| PUT, DELETE | /announcements/{id} | Board |
| GET | /documents | Public |
| GET | /documents/{id}/download | Public (5-minute signed S3 link) |
| POST | /documents, /documents/{id}/complete | Board (signed upload link, then confirm) |
| DELETE | /documents/{id} | Board |
| POST | /subscribe, /subscribe/confirm | Public (double opt-in) |
| POST | /unsubscribe, /unsubscribe/one-click | Public (token-based) |
| GET | /subscribers, /admin/check | Board |
| GET, POST | /minutes | Board: list, or start a draft upload |
| GET, PUT, DELETE | /minutes/{id} | Board: detail; approve/return to draft; delete |
| GET | /minutes/{id}/view | Board: 5-minute link (PDFs open in the browser) |
| POST | /minutes/{id}/revise, /minutes/{id}/complete | Board: upload a new version, then confirm |
| POST, DELETE | /minutes/{id}/comments[/{commentId}] | Board: comment; remove your own |
| POST, DELETE | /minutes/{id}/signoff | Board: mark or unmark "I've reviewed this version" |

Console-only event: `{"action": "setup-database"}` creates the tables (safe to re-run; ignored for web requests).

## Notes for whoever maintains this next

- The S3 client sets `requestChecksumCalculation: 'WHEN_REQUIRED'`. Without it, newer AWS SDKs add checksum
  parameters to signed upload links and browser uploads fail.
- Meeting minutes are board-only. Files live under `board/minutes/` in the documents bucket, every
  `/minutes` route calls `requireAdmin`, and no public route reads the minutes tables.
  Uploading a revised version clears sign-offs (they were for the old file) and deletes the old file.
- `src/db.mjs` returns DATE columns as 'YYYY-MM-DD' text and BIGINT as numbers; the pages rely on both.
- `S3_ENDPOINT` (optional) points the code at a local S3 stand-in for testing; never set it on AWS.
- Announcement emails are sent in a loop inside the request; fine for a few hundred homes. For more, move sends to SQS.
- Rebuild the Lambda zip: `cd api && npm install --omit=dev && npm run package`.
- Local preview of the static site: `cd site && python3 -m http.server 8080`.
- Website changes deploy automatically: push to the branch Amplify watches (usually `main`).
- API changes do not deploy on push. Rebuild the zip and upload it in the Lambda console.
- Amplify's "Rewrites and redirects" should hold one rule: source `/<*>`, target `/404.html`, type 404.
