export const CONFIG_KEY = "__vybe/config.json";
export const RESERVED_PREFIX = "__vybe/";
export const THUMB_PREFIX = "__vybe/thumbs/";

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array {
	const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
	const binary = atob(padded);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

export function thumbKeyFor(objectKey: string): string {
	return `${THUMB_PREFIX}${bytesToBase64Url(new TextEncoder().encode(objectKey))}.jpg`;
}

export function objectKeyFromThumbKey(thumbKey: string): string | null {
	if (!thumbKey.startsWith(THUMB_PREFIX) || !thumbKey.endsWith(".jpg")) return null;
	const encoded = thumbKey.slice(THUMB_PREFIX.length, -".jpg".length);
	try {
		return new TextDecoder().decode(fromBase64Url(encoded));
	} catch {
		return null;
	}
}

export type FriendRecord = {
	id: string;
	label: string;
	passwordSalt: string;
	passwordHash: string;
	objectKeys: string[];
	createdAt: string;
	updatedAt: string;
};

export type AppConfig = {
	version: 1;
	friends: FriendRecord[];
};

export function emptyConfig(): AppConfig {
	return { version: 1, friends: [] };
}

export async function loadConfig(bucket: R2Bucket): Promise<AppConfig> {
	const obj = await bucket.get(CONFIG_KEY);
	if (!obj) return emptyConfig();
	try {
		const data = (await obj.json()) as AppConfig;
		if (!data || data.version !== 1 || !Array.isArray(data.friends)) return emptyConfig();
		return data;
	} catch {
		return emptyConfig();
	}
}

export async function saveConfig(bucket: R2Bucket, config: AppConfig): Promise<void> {
	await bucket.put(CONFIG_KEY, JSON.stringify(config, null, 2), {
		httpMetadata: { contentType: "application/json" },
	});
}

export function isReservedKey(key: string): boolean {
	return key === CONFIG_KEY || key.startsWith(RESERVED_PREFIX);
}

export function publicFriend(friend: FriendRecord) {
	return {
		id: friend.id,
		label: friend.label,
		objectKeys: friend.objectKeys,
		createdAt: friend.createdAt,
		updatedAt: friend.updatedAt,
	};
}
