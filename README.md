# Vybe

Password-gated file/video sharing on Cloudflare Workers + R2.

## Live

- **Share URL:** https://vybe.mottazen.com
- **workers.dev:** https://r2-media-stash.shadisherif1347.workers.dev

## Secrets

```bash
npx wrangler secret put SHARE_PASSWORD
```

Everything (upload, list, view, delete) is behind the same share password and an HttpOnly session cookie.

## Local

```bash
cp .dev.vars.example .dev.vars   # set SHARE_PASSWORD
npm install
npm run dev
```

## Deploy

```bash
npm run deploy
```

Custom domain `vybe.mottazen.com` is configured in `wrangler.jsonc` (`routes` + `custom_domain`).
