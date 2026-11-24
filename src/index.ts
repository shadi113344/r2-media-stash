import {
	authenticatePassword,
	clearSessionCookieHeader,
	hashFriendPassword,
	ownerPasswordConfigured,
	readSession,
	sessionCookieHeader,
	type Session,
} from "./auth";
import {
	isReservedKey,
	loadConfig,
	publicFriend,
	saveConfig,
	type AppConfig,
	type FriendRecord,
} from "./config";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
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

function forbidden(message = "Forbidden"): Response {
	return json({ error: message }, 403);
}

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

function wantsHtml(request: Request): boolean {
	return (request.headers.get("Accept") ?? "").includes("text/html");
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
			? `<p class="status">Owner or friend password unlocks your share.</p>`
			: `<p class="status error">Owner password is not configured. Set <code>OWNER_PASSWORD</code> (or legacy <code>SHARE_PASSWORD</code>) with Wrangler.</p>`;

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
      <p class="lede">Private file and video sharing.</p>
    </header>
    <form class="login-card" method="post" action="/api/login">
      <label class="login-label" for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required ${configured ? "" : "disabled"} />
      <button class="btn primary" type="submit" ${configured ? "" : "disabled"}>Unlock</button>
      ${err}
    </form>
  </main>
</body>
</html>`;
}

function mapObject(obj: R2Object) {
	return {
		key: obj.key,
		size: obj.size,
		sizeLabel: formatBytes(obj.size),
		uploaded: obj.uploaded.toISOString(),
		etag: obj.etag,
		httpEtag: obj.httpEtag,
		contentType: obj.httpMetadata?.contentType ?? null,
	};
}

async function listAllMedia(env: Env): Promise<R2Object[]> {
	const objects: R2Object[] = [];
	let cursor: string | undefined;
	do {
		const listed = await env.MEDIA.list({
			limit: 1000,
			cursor,
			include: ["httpMetadata", "customMetadata"],
		});
		for (const obj of listed.objects) {
			if (!isReservedKey(obj.key)) objects.push(obj);
		}
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);
	return objects;
}

async function listObjects(env: Env, session: Session): Promise<Response> {
	const all = await listAllMedia(env);
	const filtered =
		session.role === "owner"
			? all
			: all.filter((obj) => session.objectKeys.includes(obj.key));
	return json({ objects: filtered.map(mapObject), truncated: false, cursor: null });
}

async function uploadObject(request: Request, env: Env): Promise<Response> {
	const contentType = request.headers.get("content-type") ?? "";
	if (!contentType.includes("multipart/form-data")) {
		return badRequest("Expected multipart upload");
	}

	const form = await request.formData();
	const file = form.get("file");
	if (!(file instanceof File)) return badRequest('Expected multipart field "file"');

	const overrideKey = form.get("key");
	const keyRaw =
		typeof overrideKey === "string" && overrideKey.trim() ? overrideKey.trim() : file.name;
	const key = sanitizeKey(keyRaw);
	if (!key) return badRequest("Invalid object key");
	if (isReservedKey(key)) return badRequest("Reserved key");

	if (file.size > MAX_UPLOAD_BYTES) {
		return badRequest(`File exceeds ${formatBytes(MAX_UPLOAD_BYTES)} limit`);
	}

	const put = await env.MEDIA.put(key, file.stream(), {
		httpMetadata: { contentType: file.type || "application/octet-stream" },
		customMetadata: { originalName: file.name },
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

async function getObject(env: Env, session: Session, key: string): Promise<Response> {
	if (isReservedKey(key)) return notFound("Object not found");
	if (session.role === "friend" && !session.objectKeys.includes(key)) {
		return forbidden("Not assigned to you");
	}

	const object = await env.MEDIA.get(key);
	if (!object) return notFound("Object not found");

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set("etag", object.httpEtag);
	headers.set("Cache-Control", "private, max-age=60");
	headers.set("Content-Disposition", `inline; filename="${key.split("/").pop()}"`);
	return new Response(object.body, { headers });
}

async function deleteObject(env: Env, config: AppConfig, key: string): Promise<Response> {
	if (isReservedKey(key)) return badRequest("Reserved key");
	const existing = await env.MEDIA.head(key);
	if (!existing) return notFound("Object not found");
	await env.MEDIA.delete(key);

	let changed = false;
	for (const friend of config.friends) {
		const next = friend.objectKeys.filter((k) => k !== key);
		if (next.length !== friend.objectKeys.length) {
			friend.objectKeys = next;
			friend.updatedAt = new Date().toISOString();
			changed = true;
		}
	}
	if (changed) await saveConfig(env.MEDIA, config);

	return json({ deleted: key });
}

async function handleLogin(request: Request, env: Env, url: URL, config: AppConfig): Promise<Response> {
	if (!ownerPasswordConfigured(env)) {
		if (wantsHtml(request) || (request.headers.get("content-type") ?? "").includes("form")) {
			return new Response(loginPageHtml("Owner password is not configured.", false), {
				status: 503,
				headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
			});
		}
		return json({ error: "OWNER_PASSWORD (or SHARE_PASSWORD) secret is not set" }, 503);
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

	const result = await authenticatePassword(password, env, config);
	if (!result) {
		if (contentType.includes("application/json")) return unauthorized("Incorrect password");
		return new Response(loginPageHtml("Incorrect password. Try again.", true), {
			status: 401,
			headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
		});
	}

	const nextParam = url.searchParams.get("next");
	const next =
		nextParam && nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/";

	if (contentType.includes("application/json")) {
		return new Response(JSON.stringify({ ok: true, role: result.session.role }), {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
				"Set-Cookie": sessionCookieHeader(result.token, url),
			},
		});
	}

	return new Response(null, {
		status: 303,
		headers: {
			Location: next,
			"Set-Cookie": sessionCookieHeader(result.token, url),
		},
	});
}

function sanitizeObjectKeys(raw: unknown): string[] | null {
	if (!Array.isArray(raw)) return null;
	const keys: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") return null;
		const key = sanitizeKey(item);
		if (!key || isReservedKey(key)) return null;
		keys.push(key);
	}
	return [...new Set(keys)];
}

async function createFriend(env: Env, config: AppConfig, body: Record<string, unknown>): Promise<Response> {
	const label = typeof body.label === "string" ? body.label.trim() : "";
	const password = typeof body.password === "string" ? body.password : "";
	const objectKeys = sanitizeObjectKeys(body.objectKeys);
	if (!label) return badRequest("label is required");
	if (password.length < 4) return badRequest("password must be at least 4 characters");
	if (!objectKeys) return badRequest("objectKeys must be an array of keys");

	const { salt, hash } = await hashFriendPassword(password);
	const now = new Date().toISOString();
	const friend: FriendRecord = {
		id: crypto.randomUUID(),
		label,
		passwordSalt: salt,
		passwordHash: hash,
		objectKeys,
		createdAt: now,
		updatedAt: now,
	};
	config.friends.push(friend);
	await saveConfig(env.MEDIA, config);
	return json(publicFriend(friend), 201);
}

async function updateFriend(
	env: Env,
	config: AppConfig,
	id: string,
	body: Record<string, unknown>,
): Promise<Response> {
	const friend = config.friends.find((f) => f.id === id);
	if (!friend) return notFound("Friend not found");

	if (typeof body.label === "string") {
		const label = body.label.trim();
		if (!label) return badRequest("label cannot be empty");
		friend.label = label;
	}
	if (body.objectKeys !== undefined) {
		const objectKeys = sanitizeObjectKeys(body.objectKeys);
		if (!objectKeys) return badRequest("objectKeys must be an array of keys");
		friend.objectKeys = objectKeys;
	}
	if (typeof body.password === "string" && body.password.length > 0) {
		if (body.password.length < 4) return badRequest("password must be at least 4 characters");
		const { salt, hash } = await hashFriendPassword(body.password);
		friend.passwordSalt = salt;
		friend.passwordHash = hash;
	}

	friend.updatedAt = new Date().toISOString();
	await saveConfig(env.MEDIA, config);
	return json(publicFriend(friend));
}

async function deleteFriend(env: Env, config: AppConfig, id: string): Promise<Response> {
	const idx = config.friends.findIndex((f) => f.id === id);
	if (idx === -1) return notFound("Friend not found");
	const [removed] = config.friends.splice(idx, 1);
	await saveConfig(env.MEDIA, config);
	return json({ deleted: removed.id });
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		try {
			const config = await loadConfig(env.MEDIA);

			if (url.pathname === "/api/health") {
				return json({
					ok: true,
					service: "vybe",
					passwordConfigured: ownerPasswordConfigured(env),
					friendCount: config.friends.length,
				});
			}

			if (url.pathname === "/login" && request.method === "GET") {
				const session = await readSession(request, env, config);
				if (session) return Response.redirect(new URL("/", url).toString(), 302);
				const next = url.searchParams.get("next");
				const action =
					next && next.startsWith("/") && !next.startsWith("//")
						? `/api/login?next=${encodeURIComponent(next)}`
						: "/api/login";
				const html = loginPageHtml(null, ownerPasswordConfigured(env)).replace(
					'action="/api/login"',
					`action="${action}"`,
				);
				return new Response(html, {
					headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
				});
			}

			if (url.pathname === "/api/login" && request.method === "POST") {
				return handleLogin(request, env, url, config);
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

			if (url.pathname === "/styles.css") {
				return env.ASSETS.fetch(request);
			}

			const session = await readSession(request, env, config);
			if (!session) {
				if (url.pathname.startsWith("/api/")) return unauthorized();
				if (wantsHtml(request) || request.method === "GET") return loginRedirect(url);
				return unauthorized();
			}

			if (url.pathname === "/api/me" && request.method === "GET") {
				if (session.role === "owner") return json({ role: "owner", label: "Owner" });
				return json({
					role: "friend",
					friendId: session.friendId,
					label: session.label,
					objectKeys: session.objectKeys,
				});
			}

			if (url.pathname === "/api/objects" && request.method === "GET") {
				return listObjects(env, session);
			}

			if (url.pathname === "/api/upload" && request.method === "POST") {
				if (session.role !== "owner") return forbidden("Owner only");
				return uploadObject(request, env);
			}

			if (url.pathname === "/api/friends" && request.method === "GET") {
				if (session.role !== "owner") return forbidden("Owner only");
				return json({ friends: config.friends.map(publicFriend) });
			}

			if (url.pathname === "/api/friends" && request.method === "POST") {
				if (session.role !== "owner") return forbidden("Owner only");
				const body = (await request.json()) as Record<string, unknown>;
				return createFriend(env, config, body);
			}

			const friendMatch = url.pathname.match(/^\/api\/friends\/([^/]+)$/);
			if (friendMatch) {
				if (session.role !== "owner") return forbidden("Owner only");
				const id = decodeURIComponent(friendMatch[1]);
				if (request.method === "PUT") {
					const body = (await request.json()) as Record<string, unknown>;
					return updateFriend(env, config, id, body);
				}
				if (request.method === "DELETE") return deleteFriend(env, config, id);
				return json({ error: "Method not allowed" }, 405);
			}

			const objectMatch = url.pathname.match(/^\/api\/objects\/(.+)$/);
			if (objectMatch) {
				const key = sanitizeKey(objectMatch[1]);
				if (!key) return badRequest("Invalid object key");
				if (request.method === "GET") return getObject(env, session, key);
				if (request.method === "DELETE") {
					if (session.role !== "owner") return forbidden("Owner only");
					return deleteObject(env, config, key);
				}
				return json({ error: "Method not allowed" }, 405);
			}

			if (url.pathname.startsWith("/api/")) return notFound("Unknown API route");

			return env.ASSETS.fetch(request);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Internal error";
			console.error(JSON.stringify({ level: "error", message }));
			return json({ error: message }, 500);
		}
	},
} satisfies ExportedHandler<Env>;
