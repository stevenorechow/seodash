/*
 * SEOdash. Copyright (C) 2026 the SEOdash authors. Licensed under GPL-3.0-only; see LICENSE.
 */
/**
 * Instant indexing: tells search engines about new and changed pages as they are published.
 *
 * - IndexNow (Bing, Yandex, Seznam, Naver and others) needs a key file at the site root. The
 *   trusted build serves it through `seodashRoutes()`; the key itself is generated here.
 * - Google's Indexing API, in builds that pass the engine in `google-indexing.ts` (it uses the
 *   service-account key shared with the other Google features). The free build leaves it out.
 *
 * Off by default: it makes outbound requests.
 */
import { formBlock, type FormSpec, readForm, readSecrets, withCollections, textField, toggleField } from "../admin/forms.js";
import { defineSection, secrets } from "../core/settings.js";
import { type ActResult, type Block, type Ctx, type Module, ago, fail, ok, store, note } from "../kit.js";

export interface IndexingSettings {
	indexnow: boolean;
	google: boolean;
	/** Submit automatically when an entry is published or updated. */
	onPublish: boolean;
	/** Collection slugs to submit, comma-separated. Empty: every collection with public pages. */
	collections: string;
	/** IndexNow key, generated the first time the tab is opened. */
	key: string;
	/**
	 * The site owner confirmed a `<key>.txt` file at the site root. Required in the sandbox, which
	 * cannot serve a file there; the trusted build serves `/indexnow-key.txt` itself.
	 */
	keyFile: boolean;
	/** The sandbox serves the key file at the site root through a redirect in EmDash's Redirects. */
	served: boolean;
}

export const indexingSection = defineSection<IndexingSettings>("indexing", { indexnow: false, google: false, onPublish: true, collections: "", key: "", keyFile: false, served: false });

export interface LogRow {
	url: string;
	engine: "IndexNow" | "Google";
	action: "updated" | "removed";
	status: number;
	ok: boolean;
	message: string;
	entryKey: string;
	at: string;
}

const LOG_LIMIT = 200;
const MAX_URLS = 100;

const log = (ctx: Ctx) => store<LogRow>(ctx, "indexing");

const newKey = () => [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Where the IndexNow key file is. A key file only covers pages under its own folder, so it must sit
 * at the site root: a plugin route cannot serve it.
 */
export const keyLocation = (siteUrl: string, settings: Pick<IndexingSettings, "key" | "keyFile">) => `${siteUrl.replace(/\/+$/, "")}/${settings.keyFile ? settings.key : "indexnow-key"}.txt`;

const keyRoute = (ctx: Ctx) => `/_emdash/api/plugins/${ctx.plugin.id}/indexnow-key`;

/** The redirect at `/<key>.txt`, if there is one. */
async function rootRule(ctx: Ctx, key: string) {
	const { items } = (await ctx.redirects?.list({ search: key, limit: 10 })) ?? { items: [] };
	return items.find((rule) => rule.source === `/${key}.txt`);
}

/**
 * Serves the key file at the site root with a redirect to the key route (EmDash applies redirects
 * to file addresses from 1.6). A redirect someone else made there is left alone. Returns why not.
 */
async function serveKey(ctx: Ctx, key: string): Promise<string | null> {
	const rule = await rootRule(ctx, key);
	if (rule) return rule.destination === keyRoute(ctx) ? null : `/${key}.txt already redirects elsewhere. Remove that redirect first.`;
	if (!ctx.redirects?.create) return "Redirects are not allowed.";
	await ctx.redirects.create({ source: `/${key}.txt`, destination: keyRoute(ctx), type: 301, groupName: "IndexNow" });
	return null;
}

/** Removes the redirect `serveKey` made, and only that one. */
async function unserveKey(ctx: Ctx, key: string): Promise<void> {
	const rule = await rootRule(ctx, key);
	const current = rule?.destination === keyRoute(ctx) ? await ctx.redirects?.get(rule.id) : null;
	if (current) await ctx.redirects?.delete?.(current.redirect.id, { _rev: current._rev });
}

async function record(ctx: Ctx, rows: LogRow[]): Promise<void> {
	const collection = log(ctx);
	for (const [index, row] of rows.entries()) await collection.put(`${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 8)}`, row);
	// Keep the log short.
	const total = await collection.count();
	if (total > LOG_LIMIT) {
		const oldest = await collection.query({ orderBy: { at: "asc" }, limit: Math.min(100, total - LOG_LIMIT) });
		await collection.deleteMany(oldest.items.map((item) => item.id));
	}
}

async function submitIndexNow(ctx: Ctx, settings: IndexingSettings, urls: string[], entryKey: string): Promise<LogRow[]> {
	const site = new URL(ctx.site.url);
	const at = new Date().toISOString();
	let status = 0;
	let message = "";
	try {
		const response = await ctx.http!.fetch("https://api.indexnow.org/indexnow", {
			method: "POST",
			headers: { "content-type": "application/json; charset=utf-8" },
			body: JSON.stringify({ host: site.host, key: settings.key, keyLocation: keyLocation(ctx.site.url, settings), urlList: urls }),
			signal: AbortSignal.timeout(15000),
		});
		status = response.status;
		message = status === 200 || status === 202 ? "Accepted" : status === 403 ? "Key file not found at the site root" : status === 422 ? "URL does not belong to this site" : status === 429 ? "Too many requests" : `HTTP ${status}`;
	} catch (error) {
		message = error instanceof Error ? error.message.slice(0, 120) : "Request failed";
	}
	return urls.map((url) => ({ url, engine: "IndexNow", action: "updated", status, ok: status === 200 || status === 202, message, entryKey, at }));
}

/** A second engine: Google's Indexing API, passed in by the builds that include it. */
export interface GoogleEngine {
	/** The plugin secret holding the service-account key. */
	secret: string;
	hosts: string[];
	/** Null when the pasted text is not a service-account key. */
	parse(json: string): unknown;
	submit(ctx: Ctx, urls: string[], action: "updated" | "removed", entryKey: string): Promise<LogRow[]>;
}

/** Only URLs of this site are ever submitted. */
function ownUrls(ctx: Ctx, urls: string[]): string[] {
	let host = "";
	try {
		host = new URL(ctx.site.url).host;
	} catch {
		return [];
	}
	const out = new Set<string>();
	for (const raw of urls) {
		try {
			const url = new URL(raw.trim(), ctx.site.url);
			if (url.host === host && /^https?:$/.test(url.protocol)) out.add(url.toString());
		} catch {
			// Not a URL.
		}
	}
	return [...out].slice(0, MAX_URLS);
}

/** Submits URLs to every engine that is switched on. Returns the log rows written. */
async function submitUrls(ctx: Ctx, google: GoogleEngine | undefined, urls: string[], action: "updated" | "removed" = "updated", entryKey = ""): Promise<LogRow[]> {
	const settings = await indexingSection.load(ctx.settings);
	const list = ownUrls(ctx, urls);
	if (!list.length || !ctx.http) return [];
	const rows: LogRow[] = [];
	// IndexNow has no "removed" signal: a removed URL is simply re-fetched and found gone.
	if (settings.indexnow && settings.key) rows.push(...(await submitIndexNow(ctx, settings, list, entryKey)));
	if (google && settings.google) rows.push(...(await google.submit(ctx, list, action, entryKey)));
	if (rows.length) await record(ctx, rows);
	return rows;
}

const covers = (settings: IndexingSettings, collection: string) => {
	const wanted = settings.collections.split(",").map((slug) => slug.trim()).filter(Boolean);
	return !wanted.length || wanted.includes(collection);
};

const summary = (rows: LogRow[]): ActResult => {
	if (!rows.length) return fail("Nothing was sent. Switch on an engine first.");
	const failed = rows.filter((row) => !row.ok);
	return failed.length ? fail(`${failed[0]!.engine}: ${failed[0]!.message}`) : ok(`Sent to ${[...new Set(rows.map((row) => row.engine))].join(" and ")}`);
};

/**
 * One form: each service's own fields sit under its switch and show as soon as it is on. `file` is
 * the key file's address, shown for copying and never read back. `trusted` builds serve the file
 * themselves; `askKey` is false where the Google key is entered under Integrations instead.
 */
function settingsForm(trusted: boolean, google: boolean, askKey: boolean, file = ""): FormSpec {
	const on = { field: "indexnow", eq: true };
	return {
		id: "indexing:settings",
		fields: [
			toggleField("indexnow", "IndexNow (Bing, Yandex, Naver and others)"),
			...(trusted
				? file ? [textField("file", "Key file, served automatically", { when: on })] : []
				: file ? [textField("file", "Key file address", { when: on })] : []),
			...(google ? [toggleField("google", "Google Indexing API", { description: "Google only acts on these for job postings and livestream pages." })] : []),
			...(google && askKey ? [{ kind: "secret", key: "googleKey", label: "Google service account key (JSON)", when: { field: "google", eq: true } } as const] : []),
			toggleField("onPublish", "Send automatically when an entry is published or updated"),
			{ kind: "collections", key: "collections", label: "Only these collections (none ticked means all)" },
		],
	};
}
const MANUAL: FormSpec = { id: "indexing:submit", submitLabel: "Send", fields: [textField("urls", "Pages to send (one address per line)", { multiline: true })] };

/** The instant indexing module, with Google's Indexing API where the build passes it in. */
export const indexingModule = (google?: GoogleEngine): Module => {
	/** Some engine is switched on (Google counts only where the build has it). */
	const anyOn = (settings: IndexingSettings) => settings.indexnow || (google !== undefined && settings.google);
	return {
	id: "indexing",
	panelActions: ["entry"],
	feature: { label: "Instant indexing", description: "Tells search engines about new and changed pages right away." },
	...(google ? { secrets: { [google.secret]: "Google service account key" } } : {}),
	capabilities: ["network:request", "content:read"],
	// The trusted build serves the key file at the site root itself.
	sandboxCapabilities: ["redirects:write"],
	allowedHosts: ["api.indexnow.org", ...(google?.hosts ?? [])],
	storage: { indexing: { indexes: ["at", "entryKey", ["entryKey", "at"]] } },
	routes: {
		// The key file as a download, named the way IndexNow expects. The key is public by design.
		"indexnow-key": {
			public: true,
			methods: ["GET"],
			request: { body: "none" },
			response: "raw",
			async handler(_input, ctx) {
				const { key } = await indexingSection.load(ctx.settings);
				if (!/^[a-f0-9]{32}$/.test(key)) return { status: 404, body: "Not found", headers: { "Content-Type": "text/plain" } };
				return { status: 200, body: key, headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="${key}.txt"` } };
			},
		},
	},
	tabs: [
		{
			page: "/settings",
			label: "Indexing",
			order: 10,
			async render(ctx, env) {
				const settings = await indexingSection.load(ctx.settings);
				// The key is needed before IndexNow is on, so the site owner can add the file first.
				if (!settings.key) await indexingSection.save(ctx.settings, { ...settings, key: newKey() });
				const key = settings.key || (await indexingSection.load(ctx.settings)).key;
				const file = keyLocation(ctx.site.url, { key, keyFile: !env.trusted });
				const hasKey = google ? await secrets.has(ctx.settings, google.secret) : false;
				const askKey = !env.modules.some((module) => module.id === "reports");
				const blocks: Block[] = [note("Tell search engines about new and changed pages right away.")];
				// A sandboxed plugin cannot serve a file at the site root, so the owner adds it once.
				if (!env.trusted && ctx.site.url && (settings.served || !settings.keyFile)) {
					// The download is only for EmDash 1.5, which ignores redirects for file addresses.
					blocks.push(
						note(settings.served ? "A redirect under Redirects serves the key file at the site root. EmDash 1.5 ignores it: download the file and add it to the site's public folder." : "Switching IndexNow on serves its key file at the site root with a redirect (EmDash 1.6 or later)."),
						...(settings.served ? [{ type: "actions", elements: [{ type: "link", label: "Download key file", target: { kind: "external", url: `${ctx.site.url.replace(/\/+$/, "")}/_emdash/api/plugins/${ctx.plugin.id}/indexnow-key` }, appearance: "secondary" }] } as Block] : []),
					);
				}
				blocks.push(
					formBlock(await withCollections(ctx, settingsForm(env.trusted, !!google, askKey, file)), { ...settings, file }, { googleKey: hasKey }),
				);
				if (google && settings.google && !askKey && !hasKey) {
					blocks.push({ type: "banner", variant: "alert", description: "Add the Google service account key under Integrations to use the Google Indexing API." });
				}
				if (anyOn(settings)) {
					blocks.push({ type: "divider" }, formBlock(MANUAL, { urls: "" }));
					const recent = await log(ctx).query({ orderBy: { at: "desc" }, limit: 20 });
					blocks.push({
						type: "table",
						page_action_id: "indexing:history",
						empty_text: "Nothing has been sent yet.",
						columns: [
							{ key: "url", label: "Page" },
							{ key: "engine", label: "Sent to" },
							{ key: "result", label: "Result", format: "badge" },
							{ key: "at", label: "When", format: "relative_time" },
						],
						rows: recent.items.map(({ data }) => ({ url: data.url, engine: data.engine, result: data.ok ? (data.action === "removed" ? "Removal sent" : "Accepted") : data.message, at: data.at })),
					});
				}
				return blocks;
			},
		},
	],
	panel: [
		{
			id: "indexing",
			label: "Indexing",
			order: 50,
			async render(ctx, _env, entry) {
				const settings = await indexingSection.load(ctx.settings);
				if (!anyOn(settings)) return [];
				if (!entry.url) return [note("Publish this entry to send it to search engines.")];
				const last = await log(ctx).query({ where: { entryKey: `${entry.collection}:${entry.id}` }, orderBy: { at: "desc" }, limit: 4 });
				return [
					{
						type: "section",
						text: last.items.length ? last.items.map(({ data }) => `${data.engine}: ${data.ok ? "accepted" : data.message} (${ago(data.at)})`).join(" · ") : "Not sent yet.",
						accessory: { type: "button", label: "Send now", action_id: "indexing:entry" },
					},
				];
			},
		},
	],

	async act(ctx, env, action, entry) {
		if (action.id === "entry" && entry) {
			if (!entry.url) return fail("This entry has no public address yet.");
			return summary(await submitUrls(ctx, google, [entry.url], "updated", `${entry.collection}:${entry.id}`));
		}
		if (!action.values) return null;
		if (action.id === "settings") {
			const spec = settingsForm(env.trusted, !!google, !env.modules.some((module) => module.id === "reports"));
			const next = readForm(spec, action.values, await indexingSection.load(ctx.settings));
			next.key ||= newKey();
			if (!env.trusted && next.indexnow && !next.keyFile) {
				const why = await serveKey(ctx, next.key);
				if (why) return fail(why);
				next.keyFile = next.served = true;
			}
			if (!next.indexnow && next.served) {
				await unserveKey(ctx, next.key);
				next.keyFile = next.served = false;
			}
			const key = google && readSecrets(spec, action.values).googleKey;
			if (key && !google.parse(key)) return fail("That is not a service account key. Paste the whole JSON file.");
			if (key) await secrets.set(ctx.settings, google.secret, key);
			await indexingSection.save(ctx.settings, next);
			return ok("Saved");
		}
		if (action.id === "submit") {
			const urls = String(action.values.urls ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
			if (!urls.length) return fail("Enter at least one address.");
			return summary(await submitUrls(ctx, google, urls));
		}
		return null;
	},

	on: {
		// Off means off: the redirect goes with the feature and comes back with it.
		async toggle(ctx, _env, on) {
			const settings = await indexingSection.load(ctx.settings);
			if (settings.served && settings.indexnow) await (on ? serveKey(ctx, settings.key) : unserveKey(ctx, settings.key));
		},
		async uninstall(ctx) {
			const settings = await indexingSection.load(ctx.settings);
			if (settings.served) await unserveKey(ctx, settings.key);
		},
		async publish(ctx, _env, event) {
			const settings = await indexingSection.load(ctx.settings);
			if (!settings.onPublish || !anyOn(settings) || !covers(settings, event.collection)) return;
			// An entry hidden from search engines is not announced to them.
			const entry = (await ctx.content?.get(event.collection, event.id).catch(() => null)) as { seo?: { noIndex?: boolean } } | null | undefined;
			if (entry?.seo?.noIndex) return;
			const url = await ctx.content?.getPublicUrl?.(event.collection, event.id);
			if (url) await submitUrls(ctx, google, [url], "updated", `${event.collection}:${event.id}`);
		},
		async unpublish(ctx, _env, event) {
			const settings = await indexingSection.load(ctx.settings);
			if (!settings.onPublish || !anyOn(settings) || !covers(settings, event.collection)) return;
			// The page no longer has a public address; use the last one that was sent.
			const last = await log(ctx).query({ where: { entryKey: `${event.collection}:${event.id}` }, orderBy: { at: "desc" }, limit: 1 });
			const url = last.items[0]?.data.url;
			if (url) await submitUrls(ctx, google, [url], "removed", `${event.collection}:${event.id}`);
		},
	},
};
};
