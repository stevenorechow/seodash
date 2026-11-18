/**
 * A view of the plugin context for one invocation (one hook call or one route call) that
 * remembers what it has already read: settings, key-value entries and collection schemas.
 *
 * Every host call is a subrequest in EmDash's sandbox, which allows about 30 per invocation, and
 * several modules read the same settings while handling one request. Writes update what is
 * remembered. Nothing outlives the invocation, so another request never sees a stale value.
 */
import type { Ctx } from "../kit.js";

type Reads = {
	get(key: string): Promise<unknown>;
	set?(key: string, value: unknown): Promise<unknown>;
	delete?(key: string): Promise<unknown>;
	list?(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
};

/** With `prefix`, the first read of a key under it fetches every key under it in one call. */
function remembering<T extends object>(target: T, prefix?: string): T {
	const source = target as unknown as Reads;
	const known = new Map<string, Promise<unknown>>();
	const copy = (value: unknown) => (value !== null && typeof value === "object" ? structuredClone(value) : value);
	let group: Promise<Map<string, unknown> | null> | undefined;
	const fromGroup = (key: string): Promise<unknown> => {
		group ??= source.list!(prefix).then(
			(items) => new Map(items.map((item) => [item.key, item.value])),
			() => null,
		);
		return group.then((values) => (values ? (values.get(key) ?? null) : source.get(key)));
	};
	const own: Reads = {
		get(key) {
			if (!known.has(key)) known.set(key, prefix && key.startsWith(prefix) && typeof source.list === "function" ? fromGroup(key) : source.get(key));
			// Callers may change what they get back, so each one gets its own copy.
			return known.get(key)!.then(copy);
		},
		set(key, value) {
			known.set(key, Promise.resolve(copy(value)));
			return source.set!(key, value);
		},
		delete(key) {
			known.set(key, Promise.resolve(null));
			return source.delete!(key);
		},
	};
	(own as Reads & { fresh(key: string): Promise<unknown> }).fresh = (key) => {
		known.set(key, source.get(key));
		return known.get(key)!.then(copy);
	};
	return over(target, own as unknown as Partial<T>);
}

function once<T extends object>(target: T, methods: string[]): T {
	const known = new Map<string, Promise<unknown>>();
	const own: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
	for (const method of methods) {
		own[method] = (...args) => {
			const key = `${method}:${JSON.stringify(args)}`;
			if (!known.has(key)) known.set(key, (target as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[method]!(...args));
			return known.get(key)!;
		};
	}
	return over(target, own as Partial<T>);
}

/** `target` with some members replaced; everything else still runs against `target` itself. */
function over<T extends object>(target: T, own: Partial<T>): T {
	return new Proxy(target, {
		get(object, name) {
			if (Object.prototype.hasOwnProperty.call(own, name)) return (own as Record<PropertyKey, unknown>)[name];
			const value = Reflect.get(object, name, object) as unknown;
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(object) : value;
		},
	});
}

interface Scope {
	/** Host calls made so far in this invocation. */
	calls: number;
	/** Storage records already read, by collection name then id. */
	records: Map<string, Map<string, unknown>>;
}

const SCOPE = Symbol("scope");
const scopeOf = (ctx: Ctx) => (ctx as unknown as Record<symbol, Scope | undefined>)[SCOPE];

/** `target` with every method call counted. */
function counted<T extends object>(target: T, scope: Scope): T {
	return new Proxy(target, {
		get(object, name) {
			const value = Reflect.get(object, name, object) as unknown;
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				scope.calls++;
				return (value as (...args: unknown[]) => unknown).apply(object, args);
			};
		},
	});
}

type Records = {
	get(id: string): Promise<unknown>;
	put(id: string, data: unknown): Promise<unknown>;
	delete(id: string): Promise<unknown>;
	putMany?(items: Array<{ id: string; data: unknown }>): Promise<unknown>;
	deleteMany?(ids: string[]): Promise<unknown>;
};

/** A storage collection whose single-record reads are remembered (and seeded by `prime`). */
function recordsOf(target: object, known: Map<string, unknown>): object {
	const source = target as Records;
	const copy = (value: unknown) => (value !== null && typeof value === "object" ? structuredClone(value) : value);
	const own: Records = {
		async get(id) {
			if (!known.has(id)) known.set(id, await source.get(id));
			return copy(known.get(id));
		},
		put(id, data) {
			known.set(id, copy(data));
			return source.put(id, data);
		},
		delete(id) {
			known.set(id, null);
			return source.delete(id);
		},
		putMany(items) {
			for (const item of items) known.set(item.id, copy(item.data));
			return source.putMany!(items);
		},
		deleteMany(ids) {
			for (const id of ids) known.set(id, null);
			return source.deleteMany!(ids);
		},
	};
	return over(target, own as Partial<object>);
}

export function scoped(ctx: Ctx): Ctx {
	if (scopeOf(ctx)) return ctx;
	const scope: Scope = { calls: 0, records: new Map() };
	const loose = ctx as unknown as Record<string, object | undefined>;
	const own: Record<PropertyKey, unknown> = { [SCOPE]: scope, settings: remembering(counted(ctx.settings, scope), "config:"), kv: remembering(counted(ctx.kv, scope)) };
	if (ctx.schema) own.schema = once(counted(ctx.schema, scope), ["listCollections", "getCollection"]);
	for (const part of ["content", "http", "media", "taxonomies", "email", "cron", "users"]) if (loose[part]) own[part] = counted(loose[part]!, scope);
	const collections = new Map<string, object>();
	own.storage = new Proxy(ctx.storage as object, {
		get(object, name) {
			const found = Reflect.get(object, name, object) as object | undefined;
			if (typeof name !== "string" || !found || typeof found !== "object") return found;
			if (!collections.has(name)) {
				if (!scope.records.has(name)) scope.records.set(name, new Map());
				collections.set(name, recordsOf(counted(found, scope), scope.records.get(name)!));
			}
			return collections.get(name);
		},
	});
	return over(ctx, own as Partial<Ctx>);
}

/** Reads a key from the host rather than from what this invocation remembers: for a value another invocation may change. */
export function freshKv<T>(ctx: Ctx, key: string): Promise<T | null> {
	const kv = ctx.kv as unknown as { fresh?: (key: string) => Promise<T | null> };
	return kv.fresh ? kv.fresh(key) : ctx.kv.get<T>(key);
}

/** Host calls made so far in this invocation; 0 outside one. */
export const hostCalls = (ctx: Ctx): number => scopeOf(ctx)?.calls ?? 0;

/**
 * Reads several records of one storage collection in a single call, so the `get` of each one
 * that follows in this invocation costs nothing. Does nothing outside an invocation.
 */
export async function prime(ctx: Ctx, name: string, ids: string[]): Promise<void> {
	const scope = scopeOf(ctx);
	const collection = (ctx.storage as unknown as Record<string, { getMany?(ids: string[]): Promise<Map<string, unknown>> } | undefined>)[name];
	if (!scope || !collection?.getMany || !ids.length) return;
	const known = scope.records.get(name) ?? new Map<string, unknown>();
	scope.records.set(name, known);
	const wanted = ids.filter((id) => !known.has(id));
	if (!wanted.length) return;
	try {
		const found = await collection.getMany(wanted);
		for (const id of wanted) known.set(id, found.get(id) ?? null);
	} catch {
		// Each record is then read on its own.
	}
}
