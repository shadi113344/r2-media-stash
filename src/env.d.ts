interface Env {
	MEDIA: R2Bucket;
	ASSETS: Fetcher;
	/** Shared unlock password — set with `npx wrangler secret put SHARE_PASSWORD` */
	SHARE_PASSWORD?: string;
}
