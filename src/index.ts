const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MiB per request
const SESSION_COOKIE = "share_auth";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const PUBLIC_PATHS = new Set(["/login", "/api/login", "/api/health"]);

function json(data: unknown, status = 200): Response {
	return Response.json(data, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}

function badRequest(message: string): Response {
	return json({ error: message }, 400);
}

function notFound(message = "Not found"): Response {
	return json({ error: message }, 404);
}

function unauthorized(message = "Password required"): Response {
	return json({ error: message }, 401);
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

function parseCookies(header: string | null): Record<string, string> {
	const out: Record<string, string> = {};
	if (!header) return out;
	for (const part of header.split(";")) {
		const idx = part.indexOf("=");
		if (idx === -1) continue;
		const key = part.slice(0, idx).trim();
		const value = part.slice(idx + 1).trim();
		if (key) out[key] = value;
	}
	return out;
}

async function sha256(bytes: BufferSource): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-256", bytes);
}

async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
	const enc = new TextEncoder();
	const [aHash, bHash] = await Promise.all([sha256(enc.encode(a)), sha256(enc.encode(b))]);
	return crypto.subtle.timingSafeEqual(new Uint8Array(aHash), new Uint8Array(bHash));
}

function toBase64Url(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hmacSign(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	return toBase64Url(sig);
}

async function createSessionToken(password: string): Promise<string> {
	const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
	const payload = `v1.${exp}`;
	const sig = await hmacSign(password, payload);
	return `${payload}.${sig}`;
}

async function verifySessionToken(password: string, token: string): Promise<boolean> {
	const parts = token.split(".");
	if (parts.length !== 3) return false;
	const [version, expStr, sig] = parts;
	if (version !== "v1") return false;
	const exp = Number(expStr);
	if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
	const expected = await hmacSign(password, `${version}.${expStr}`);
	return timingSafeEqualString(sig, expected);
}

function sessionCookieHeader(token: string, requestUrl: URL): string {
	const secure = requestUrl.protocol === "https:" ? "; Secure" : "";
	return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
}

function clearSessionCookieHeader(requestUrl: URL): string {
	const secure = requestUrl.protocol === "https:" ? "; Secure" : "";
	return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
	if (!env.SHARE_PASSWORD) return false;
	const cookies = parseCookies(request.headers.get("Cookie"));
	const token = cookies[SESSION_COOKIE];
	if (!token) return false;
	return verifySessionToken(env.SHARE_PASSWORD, token);
}

function wantsHtml(request: Request): boolean {
	const accept = request.headers.get("Accept") ?? "";
	return accept.includes("text/html");
}

function loginRedirect(url: URL): Response {
	const next = url.pathname + url.search;
	const dest = next && next !== "/" ? `/login?next=${encodeURIComponent(next)}` : "/login";
	return Response.redirect(new URL(dest, url).toString(), 302);
}

function loginPageHtml(error: string | null, configured: boolean): string {
	const err = error
		? `<p class="status error">${error}</p>`
		: configured
			? `<p class="status">Enter the share password to view files.</p>`
			: `<p class="status error">Share password is not configured yet. The owner must set the <code>SHARE_PASSWORD</code> secret.</p>`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Unlock — Vybe</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Figtree:wght@450;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <div class="atmosphere" aria-hidden="true"></div>
  <main class="shell login-shell">
    <header class="brand">
      <p class="mark">Vybe</p>
      <p class="lede">Password-protected files and videos for sharing.</p>
    </header>
    <form class="login-card" method="post" action="/api/login">
      <label class="login-label" for="password">Share password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required ${configured ? "" : "disabled"} />
      <button class="btn primary" type="submit" ${configured ? "" : "disabled"}>Unlock</button>
      ${err}
    </form>
  </main>
</body>
</html>`;
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

async function handleLogin(request: Request, env: Env, url: URL): Promise<Response> {
	if (!env.SHARE_PASSWORD) {
		if (wantsHtml(request) || (request.headers.get("content-type") ?? "").includes("form")) {
			return new Response(loginPageHtml("Share password is not configured.", false), {
				status: 503,
				headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
			});
		}
		return json({ error: "SHARE_PASSWORD secret is not set" }, 503);
	}

	let password = "";
	const contentType = request.headers.get("content-type") ?? "";
	if (contentType.includes("application/json")) {
		const body = (await request.json()) as { password?: string };
		password = typeof body.password === "string" ? body.password : "";
	} else {
		const form = await request.formData();
		const value = form.get("password");
		password = typeof value === "string" ? value : "";
	}

	const ok = await timingSafeEqualString(password, env.SHARE_PASSWORD);
	if (!ok) {
		if (contentType.includes("application/json")) {
			return unauthorized("Incorrect password");
		}
		return new Response(loginPageHtml("Incorrect password. Try again.", true), {
			status: 401,
			headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
		});
	}

	const token = await createSessionToken(env.SHARE_PASSWORD);
	const nextParam = url.searchParams.get("next");
	const next =
		nextParam && nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/";

	if (contentType.includes("application/json")) {
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
				"Set-Cookie": sessionCookieHeader(token, url),
			},
		});
	}

	return new Response(null, {
		status: 303,
		headers: {
			Location: next,
			"Set-Cookie": sessionCookieHeader(token, url),
		},
	});
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		try {
			if (url.pathname === "/api/health") {
				return json({
					ok: true,
					service: "vybe",
					passwordConfigured: Boolean(env.SHARE_PASSWORD),
				});
			}

			if (url.pathname === "/login" && request.method === "GET") {
				const authed = await isAuthenticated(request, env);
				if (authed) return Response.redirect(new URL("/", url).toString(), 302);
				const next = url.searchParams.get("next");
				const action =
					next && next.startsWith("/") && !next.startsWith("//")
						? `/api/login?next=${encodeURIComponent(next)}`
						: "/api/login";
				const html = loginPageHtml(null, Boolean(env.SHARE_PASSWORD)).replace(
					'action="/api/login"',
					`action="${action}"`,
				);
				return new Response(html, {
					headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
				});
			}

			if (url.pathname === "/api/login" && request.method === "POST") {
				return handleLogin(request, env, url);
			}

			if (url.pathname === "/api/logout" && (request.method === "POST" || request.method === "GET")) {
				return new Response(null, {
					status: 303,
					headers: {
						Location: "/login",
						"Set-Cookie": clearSessionCookieHeader(url),
					},
				});
			}

			// Allow login stylesheet without auth so the gate looks right
			if (url.pathname === "/styles.css") {
				return env.ASSETS.fetch(request);
			}

			const authed = await isAuthenticated(request, env);
			if (!authed && !PUBLIC_PATHS.has(url.pathname)) {
				if (url.pathname.startsWith("/api/")) return unauthorized();
				if (wantsHtml(request) || request.method === "GET") return loginRedirect(url);
				return unauthorized();
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
