import type { AppConfig, FriendRecord } from "./config";

export const SESSION_COOKIE = "vybe_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export type Session =
	| { role: "owner" }
	| { role: "friend"; friendId: string; label: string; objectKeys: string[] };

function ownerPassword(env: Env): string | null {
	return env.OWNER_PASSWORD || env.SHARE_PASSWORD || null;
}

export function ownerPasswordConfigured(env: Env): boolean {
	return Boolean(ownerPassword(env));
}

export function signingSecret(env: Env): string | null {
	return ownerPassword(env);
}

async function sha256(bytes: BufferSource): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-256", bytes);
}

export async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
	const enc = new TextEncoder();
	const [aHash, bHash] = await Promise.all([sha256(enc.encode(a)), sha256(enc.encode(b))]);
	return crypto.subtle.timingSafeEqual(new Uint8Array(aHash), new Uint8Array(bHash));
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function toBase64Url(buf: ArrayBuffer): string {
	return bytesToBase64Url(new Uint8Array(buf));
}

function fromBase64Url(value: string): Uint8Array {
	const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
	const binary = atob(padded);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
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

export async function hashFriendPassword(password: string, salt?: Uint8Array): Promise<{ salt: string; hash: string }> {
	const saltBytes = salt ?? crypto.getRandomValues(new Uint8Array(16));
	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", salt: saltBytes, iterations: 100_000, hash: "SHA-256" },
		keyMaterial,
		256,
	);
	return { salt: bytesToBase64Url(saltBytes), hash: toBase64Url(bits) };
}

export async function verifyFriendPassword(password: string, friend: FriendRecord): Promise<boolean> {
	const salt = fromBase64Url(friend.passwordSalt);
	const { hash } = await hashFriendPassword(password, salt);
	return timingSafeEqualString(hash, friend.passwordHash);
}

export async function createSessionToken(
	secret: string,
	subject: "owner" | { friendId: string },
): Promise<string> {
	const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
	const sub = subject === "owner" ? "owner" : `friend:${subject.friendId}`;
	const payload = `v2.${sub}.${exp}`;
	const sig = await hmacSign(secret, payload);
	return `${payload}.${sig}`;
}

export async function verifySessionToken(
	secret: string,
	token: string,
	config: AppConfig,
): Promise<Session | null> {
	const parts = token.split(".");
	if (parts.length !== 4) return null;
	const [version, sub, expStr, sig] = parts;
	if (version !== "v2") return null;
	const exp = Number(expStr);
	if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
	const expected = await hmacSign(secret, `${version}.${sub}.${expStr}`);
	if (!(await timingSafeEqualString(sig, expected))) return null;

	if (sub === "owner") return { role: "owner" };
	if (sub.startsWith("friend:")) {
		const friendId = sub.slice("friend:".length);
		const friend = config.friends.find((f) => f.id === friendId);
		if (!friend) return null;
		return {
			role: "friend",
			friendId: friend.id,
			label: friend.label,
			objectKeys: [...friend.objectKeys],
		};
	}
	return null;
}

export function parseCookies(header: string | null): Record<string, string> {
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

export function sessionCookieHeader(token: string, requestUrl: URL): string {
	const secure = requestUrl.protocol === "https:" ? "; Secure" : "";
	return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
}

export function clearSessionCookieHeader(requestUrl: URL): string {
	const secure = requestUrl.protocol === "https:" ? "; Secure" : "";
	return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export async function readSession(request: Request, env: Env, config: AppConfig): Promise<Session | null> {
	const secret = signingSecret(env);
	if (!secret) return null;
	const token = parseCookies(request.headers.get("Cookie"))[SESSION_COOKIE];
	if (!token) return null;
	return verifySessionToken(secret, token, config);
}

export async function authenticatePassword(
	password: string,
	env: Env,
	config: AppConfig,
): Promise<{ session: Session; token: string } | null> {
	const secret = signingSecret(env);
	if (!secret) return null;

	const owner = ownerPassword(env);
	if (owner && (await timingSafeEqualString(password, owner))) {
		const token = await createSessionToken(secret, "owner");
		return { session: { role: "owner" }, token };
	}

	for (const friend of config.friends) {
		if (await verifyFriendPassword(password, friend)) {
			const token = await createSessionToken(secret, { friendId: friend.id });
			return {
				session: {
					role: "friend",
					friendId: friend.id,
					label: friend.label,
					objectKeys: [...friend.objectKeys],
				},
				token,
			};
		}
	}
	return null;
}
