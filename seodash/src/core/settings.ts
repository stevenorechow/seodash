/**
 * Plugin settings: one JSON document per section, kept in the plugin's settings store under
 * `config:<section>` (site code can read them with `getPluginSetting("<plugin id>", "config:<section>")`).
 *
 * Every default is "off" or empty. An empty value means "leave the site's own output alone":
 * The plugin only acts once a value has been entered for it.
 */

/** The slice of the plugin context a settings section needs (`ctx.settings`). */
export interface SettingsLike {
	get<T>(key: string): Promise<T | null>;
	set(key: string, value: unknown): Promise<void>;
	delete?(key: string): Promise<boolean>;
}

export interface Section<T extends object> {
	id: string;
	defaults: T;
	load(settings: SettingsLike): Promise<T>;
	save(settings: SettingsLike, value: T): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stored values over defaults; a stored value of the wrong type is ignored. */
export function merge<T extends object>(defaults: T, stored: unknown): T {
	if (!isRecord(stored)) return structuredClone(defaults);
	const out: Record<string, unknown> = structuredClone(defaults) as Record<string, unknown>;
	for (const [name, fallback] of Object.entries(defaults)) {
		const value = stored[name];
		if (value === undefined || value === null) continue;
		if (Array.isArray(fallback)) {
			if (Array.isArray(value)) out[name] = value;
		} else if (isRecord(fallback)) {
			if (isRecord(value)) out[name] = value;
		} else if (typeof value === typeof fallback) {
			out[name] = value;
		}
	}
	return out as T;
}

export const sectionKey = (id: string) => `config:${id}`;

export function defineSection<T extends object>(id: string, defaults: T, refine?: (value: T) => T): Section<T> {
	return {
		id,
		defaults,
		async load(settings) {
			const merged = merge(defaults, await settings.get<unknown>(sectionKey(id)));
			return refine ? refine(merged) : merged;
		},
		async save(settings, value) {
			await settings.set(sectionKey(id), value);
		},
	};
}

/**
 * API keys and tokens, stored one per key under `secret:<name>`. They are write-only in the admin:
 * forms show whether a value is saved, never the value.
 */
export const secrets = {
	key: (name: string) => `secret:${name}`,
	async get(settings: SettingsLike, name: string): Promise<string> {
		try {
			const value = await settings.get<unknown>(secrets.key(name));
			return typeof value === "string" ? value : "";
		} catch {
			return "";
		}
	},
	async has(settings: SettingsLike, name: string): Promise<boolean> {
		return (await secrets.get(settings, name)) !== "";
	},
	async set(settings: SettingsLike, name: string, value: string): Promise<void> {
		if (!value) {
			if (settings.delete) await settings.delete(secrets.key(name));
			else await settings.set(secrets.key(name), "");
			return;
		}
		try {
			await settings.set(secrets.key(name), value);
		} catch (error) {
			// EmDash encrypts secrets and refuses to store one without a key to encrypt it with.
			if (/ENCRYPTION|encrypt/i.test(String((error as { code?: unknown })?.code ?? "") + String(error))) throw new Error("The key was not saved: this site has no encryption key. Set EMDASH_ENCRYPTION_KEY in the site's environment, then save again.");
			throw error;
		}
	},
};
