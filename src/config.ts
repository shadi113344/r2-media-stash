export const CONFIG_KEY = "__vybe/config.json";
export const RESERVED_PREFIX = "__vybe/";

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
