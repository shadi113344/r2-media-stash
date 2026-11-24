# Vybe

Password-gated file/video sharing on Cloudflare Workers + R2, with per-friend access.

## Live

- **Share URL:** https://vybe.mottazen.com
- **workers.dev:** https://r2-media-stash.shadisherif1347.workers.dev

## Owner password

```bash
npx wrangler secret put OWNER_PASSWORD
```

Legacy: `SHARE_PASSWORD` still works as the owner password if `OWNER_PASSWORD` is unset.

Friend passwords are **not** Wrangler secrets — the owner sets them in the Friends UI. Hashes are stored in R2 at `__vybe/config.json`.

## How it works

1. Owner logs in with `OWNER_PASSWORD`
2. Owner uploads files
3. Owner adds a friend (name + unique password + assigned files)
4. Friend opens https://vybe.mottazen.com, enters their password, and only sees assigned files

## Local

```bash
cp .dev.vars.example .dev.vars
npm install
npm run dev
```

## Deploy

```bash
npm run deploy
```
