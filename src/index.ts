const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MiB per request (Worker request body limit)

function json(data: unknown, status = 200): Response {
	return Response.json(data, {
		status,
		headers: {
			"Cache-Control": "no-store",
		},
	});
}

function badRequest(message: string): Response {
	return json({ error: message }, 400);
}

function notFound(message = "Not found"): Response {
	return json({ error: message }, 404);
}

/** Sanitize object keys: strip leading slashes, reject path traversal. */
function sanitizeKey(raw: string): string | null {
	const decoded = decodeURIComponent(raw).normalize("NFC").trim();
	if (!decoded || decoded.length > 1024) return null;
	if (decoded.includes("\0")) return null;
	if (decoded.split("/").some((part) => part === ".." || part === "")) return null;
	return decoded.replace(/^\/+/, "");
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function listObjects(env: Env, cursor: string | undefined): Promise<Response> {
	const listed = await env.MEDIA.list({
		limit: 1000,
		cursor,
		include: ["httpMetadata", "customMetadata"],
	});

	const objects = listed.objects.map((obj) => ({
		key: obj.key,
		size: obj.size,
		sizeLabel: formatBytes(obj.size),
		uploaded: obj.uploaded.toISOString(),
		etag: obj.etag,
		httpEtag: obj.httpEtag,
		contentType: obj.httpMetadata?.contentType ?? null,
	}));

	return json({
		objects,
		truncated: listed.truncated,
		cursor: listed.truncated ? listed.cursor : null,
	});
}

async function uploadObject(request: Request, env: Env): Promise<Response> {
	const contentType = request.headers.get("content-type") ?? "";

	if (contentType.includes("multipart/form-data")) {
		const form = await request.formData();
		const file = form.get("file");
		if (!(file instanceof File)) {
			return badRequest('Expected multipart field "file"');
		}

		const overrideKey = form.get("key");
		const keyRaw =
			typeof overrideKey === "string" && overrideKey.trim()
				? overrideKey.trim()
				: file.name;
		const key = sanitizeKey(keyRaw);
		if (!key) return badRequest("Invalid object key");

		if (file.size > MAX_UPLOAD_BYTES) {
			return badRequest(`File exceeds ${formatBytes(MAX_UPLOAD_BYTES)} limit`);
		}

		const put = await env.MEDIA.put(key, file.stream(), {
			httpMetadata: {
				contentType: file.type || "application/octet-stream",
			},
			customMetadata: {
				originalName: file.name,
			},
		});

		return json(
			{
				key: put.key,
				size: put.size,
				etag: put.etag,
				uploaded: put.uploaded.toISOString(),
				contentType: put.httpMetadata?.contentType ?? null,
			},
			201,
		);
	}

	// Raw body upload: ?key=filename required
	const url = new URL(request.url);
	const key = sanitizeKey(url.searchParams.get("key") ?? "");
	if (!key) return badRequest('Query param "key" is required for raw uploads');

	const lengthHeader = request.headers.get("content-length");
	if (lengthHeader && Number(lengthHeader) > MAX_UPLOAD_BYTES) {
		return badRequest(`File exceeds ${formatBytes(MAX_UPLOAD_BYTES)} limit`);
	}

	if (!request.body) return badRequest("Empty body");

	const put = await env.MEDIA.put(key, request.body, {
		httpMetadata: {
			contentType: request.headers.get("content-type") ?? "application/octet-stream",
		},
	});

	return json(
		{
			key: put.key,
			size: put.size,
			etag: put.etag,
			uploaded: put.uploaded.toISOString(),
			contentType: put.httpMetadata?.contentType ?? null,
		},
		201,
	);
}

async function getObject(env: Env, key: string): Promise<Response> {
	const object = await env.MEDIA.get(key);
	if (!object) return notFound("Object not found");

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set("etag", object.httpEtag);
	headers.set("Cache-Control", "private, max-age=60");
	headers.set("Content-Disposition", `inline; filename="${key.split("/").pop()}"`);

	return new Response(object.body, { headers });
}

async function deleteObject(env: Env, key: string): Promise<Response> {
	const existing = await env.MEDIA.head(key);
	if (!existing) return notFound("Object not found");
	await env.MEDIA.delete(key);
	return json({ deleted: key });
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		try {
			if (url.pathname === "/api/health") {
				return json({ ok: true, service: "r2-media-stash" });
			}

			if (url.pathname === "/api/objects" && request.method === "GET") {
				return await listObjects(env, url.searchParams.get("cursor") ?? undefined);
			}

			if (url.pathname === "/api/upload" && request.method === "POST") {
				return await uploadObject(request, env);
			}

			const objectMatch = url.pathname.match(/^\/api\/objects\/(.+)$/);
			if (objectMatch) {
				const key = sanitizeKey(objectMatch[1]);
				if (!key) return badRequest("Invalid object key");

				if (request.method === "GET") return await getObject(env, key);
				if (request.method === "DELETE") return await deleteObject(env, key);
				return json({ error: "Method not allowed" }, 405);
			}

			if (url.pathname.startsWith("/api/")) {
				return notFound("Unknown API route");
			}

			return env.ASSETS.fetch(request);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Internal error";
			console.error(JSON.stringify({ level: "error", message }));
			return json({ error: message }, 500);
		}
	},
} satisfies ExportedHandler<Env>;
