interface Env {
	MEDIA: R2Bucket;
	ASSETS: Fetcher;
	/** Owner/admin password (preferred). */
	OWNER_PASSWORD?: string;
	/** Legacy alias accepted as owner password if OWNER_PASSWORD is unset. */
	SHARE_PASSWORD?: string;
}
