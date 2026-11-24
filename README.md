# R2 Media Stash

Simple Cloudflare Worker that uploads, lists, and deletes files/videos in an R2 bucket.

## Features

- Drag-and-drop or file picker upload (multipart)
- List objects stored in the bound R2 bucket
- Delete objects
- Preview/download via `/api/objects/<key>`

## Prerequisites

1. A Cloudflare account with R2 enabled
2. Node.js 20+
3. Wrangler authenticated (`npx wrangler login`)

## One-time R2 setup

```bash
npx wrangler login
npx wrangler r2 bucket create r2-media-stash
```

The Worker binds to bucket `r2-media-stash` as `MEDIA` (see `wrangler.jsonc`). Change the name in both places if you prefer a different bucket.

## Local development

```bash
npm install
npm run dev
```

Open the printed `localhost` URL. Local mode uses a simulated R2 bucket (not your remote data).

## Deploy

```bash
npm run deploy
```

Wrangler prints the `*.workers.dev` URL after a successful deploy.

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/objects` | List objects |
| `POST` | `/api/upload` | Multipart upload (`file` field) |
| `GET` | `/api/objects/:key` | Download / preview object |
| `DELETE` | `/api/objects/:key` | Delete object |

## Notes

- Max upload size per request: **100 MiB** (Workers request body limit)
- This UI has no auth — protect the Worker (Cloudflare Access, etc.) before exposing it publicly with real data
