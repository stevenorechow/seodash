/*
 * SEOdash. Copyright (C) 2026 the SEOdash authors. Licensed under GPL-3.0-only; see LICENSE.
 */
/**
 * Site audit: runs the content analysis over every published entry, keeps one compact row per
 * entry, and sums the rows up into site-level findings and an overall score.
 *
 * The scan is resumable (see `scan.ts`): a scheduled job walks the site a batch at a time and
 * starts a new pass a day after the last one finished. Saving, publishing or deleting an entry
 * refreshes its own row straight away.
 */
import { formBlock, type FormSpec, readForm } from "../admin/forms.js";
import { NOT_SCORED, SEVERITY_LABEL, TITLE_LIMIT } from "../core/analysis.js";
import { entryKey } from "../core/entry.js";
import { type Block, type Ctx, type Env, type ListedItem, type Module, type PageState, type Store, ago, all, isRecord, ok, store, note } from "../kit.js";
import { analyzeEntry } from "./entry.js";
import { searchAppearance, titlesSection } from "./meta.js";
import { freshKv, hostCalls, prime } from "../core/scope.js";
import { SANDBOX_SCAN_LIMITS, SCAN_LIMITS, type ScanCursor, type ScanLimits, scanCollections, scanEntries } from "./scan.js";

export interface AuditRow {
	collection: string;
	entryId: string;
	title: string;
	url: string;
	score: number;
	high: number;
	medium: number;
	low: number;
	/** Ids of the checks that did not pass. */
	issues: string[];
	searchTitle: string;
	description: string;
	words: number;
	/** A search title was written for the entry (SEO field or collection template). */
	hasSeoTitle: boolean;
	hasSeoDescription: boolean;
	noIndex: boolean;
	scannedAt: string;
}

export interface AuditFinding {
	id: string;
	label: string;
	/** Entries affected. */
	count: number;
	severity: "high" | "medium" | "low";
	/** The worst-scoring affected entries, at most FINDING_ENTRIES, each with what makes it a finding. */
	entries?: Array<{ collection: string; entryId: string; title: string; detail: string }>;
}

export interface AuditSummary {
	/** Average entry score, 0–100. */
	score: number;
	entries: number;
	needFixing: number;
	toImprove: number;
	hidden: number;
	/** Most severe first; only findings that affect at least one entry. */
	findings: AuditFinding[];
	/** When the last full pass finished (ISO). */
	scannedAt: string;
	/** One score per day, oldest first, at most 30. */
	history: Array<{ date: string; score: number }>;
}

interface View {
	collection: string;
	show: string;
	sort: "asc" | "desc";
}

const KEY = { cursor: "audit:cursor", summary: "audit:summary", view: "audit:view", stale: "audit:stale", lease: "audit:lease" };
/** Sandboxed invocations that have run a batch: the page they render does not start another, which their host call budget cannot cover. */
const RAN = new WeakSet<Ctx>();
/** How long a batch holds the scan before another invocation may take it over (a cut-off run never releases it). */
const LEASE_MS = 30_000;
const DAY = 86400 * 1000;
const PAGE_SIZE = 25;
const MAX_SHOWN = 200;
const HISTORY = 30;
const DEFAULT_VIEW: View = { collection: "all", show: "all", sort: "asc" };

/** Entries listed under each finding on the Overview; the rest are on the Content tab. */
const FINDING_ENTRIES = 10;

/** Each finding: its label, how severe it is, what to do about it, and what to show next to an entry. */
const FINDINGS: Array<{ id: string; short: string; label: string; severity: AuditFinding["severity"]; todo: string; detail: (row: AuditRow) => string }> = [
	{ id: "duplicate-titles", short: "Same title", label: "Search title used by more than one entry", severity: "high", todo: "Give each its own SEO title.", detail: (row) => row.searchTitle },
	{ id: "no-description", short: "No description", label: "No description", severity: "high", todo: "Write a meta description or an excerpt.", detail: () => "" },
	{ id: "alt", short: "No alt text", label: "Images without alt text", severity: "high", todo: "Add alt text to each image.", detail: () => "" },
	{ id: "duplicate-descriptions", short: "Same description", label: "Description used by more than one entry", severity: "medium", todo: "Give each its own meta description.", detail: (row) => row.description },
	{ id: "long-titles", short: "Long title", label: `Search title longer than ${TITLE_LIMIT} characters`, severity: "medium", todo: "Shorten the SEO title.", detail: (row) => `${row.searchTitle.length} characters` },
	{ id: "thin", short: "Thin", label: "Thin content", severity: "medium", todo: "Add to the content: 300 words or more.", detail: (row) => plural(row.words, "word") },
	{ id: "no-image", short: "No image", label: "No sharing image", severity: "medium", todo: "Choose an OG image or a featured image.", detail: () => "" },
	{ id: "hidden", short: "Hidden", label: "Hidden from search engines", severity: "low", todo: "Switch off \"Hide from search engines\" if it should be found.", detail: () => "" },
];

const SHOW = [
	{ label: "All entries", value: "all" },
	{ label: "Needs fixing", value: "fix" },
	{ label: "No search title", value: "notitle" },
	...FINDINGS.map((finding) => ({ label: finding.label, value: finding.id })),
];

const rows = (ctx: Ctx): Store<AuditRow> => store<AuditRow>(ctx, "audit");
const rowId = (collection: string, id: string) => `${collection}:${id}`;
const fold = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** Row ids of visible entries that share a value with another entry. */
function duplicated(list: AuditRow[], pick: (row: AuditRow) => string): Set<string> {
	const groups = new Map<string, string[]>();
	for (const row of list) {
		const value = fold(pick(row));
		if (!value || row.noIndex) continue;
		const group = groups.get(value) ?? [];
		group.push(rowId(row.collection, row.entryId));
		groups.set(value, group);
	}
	return new Set([...groups.values()].filter((group) => group.length > 1).flat());
}

async function buildRow(ctx: Ctx, env: Env, collection: string, id: string, listed?: ListedItem): Promise<AuditRow | null> {
	const entry = await env.entry(ctx, collection, id, listed);
	if (!entry || entry.status !== "published") return null;
	const appearance = await searchAppearance(ctx, env, entry);
	const analysis = await analyzeEntry(ctx, env, entry, appearance);
	const failed = analysis.checks.filter((check) => check.severity !== "good" && check.severity !== "info");
	const count = (severity: string) => failed.filter((check) => check.severity === severity).length;
	return {
		collection,
		entryId: id,
		title: clip(entry.title, 200),
		url: entry.url ?? "",
		score: analysis.score ?? 0,
		high: count("high"),
		medium: count("medium"),
		low: count("low"),
		issues: failed.map((check) => check.id),
		searchTitle: clip(appearance.title, 300),
		description: clip(appearance.description, 500),
		words: analysis.words,
		hasSeoTitle: appearance.titleSource !== "entry",
		hasSeoDescription: appearance.descriptionSource === "seo" || appearance.descriptionSource === "template",
		noIndex: entry.seo?.noIndex === true,
		scannedAt: new Date().toISOString(),
	};
}

/** Re-analyzes one entry, or drops its row when it is gone or no longer published. */
async function refresh(ctx: Ctx, env: Env, collection: string, id: string): Promise<void> {
	if (!id) return;
	const row = await buildRow(ctx, env, collection, id);
	if (row) await rows(ctx).put(rowId(collection, id), row);
	else await rows(ctx).delete(rowId(collection, id));
	await ctx.kv.set(KEY.stale, true);
}

/** Tells which findings an entry is part of. Built once per list: duplicates depend on the other entries. */
function matcher(list: AuditRow[]): (id: string, row: AuditRow) => boolean {
	const sameTitle = duplicated(list, (row) => row.searchTitle);
	const sameDescription = duplicated(list, (row) => row.description);
	const id = (row: AuditRow) => rowId(row.collection, row.entryId);
	const tests: Record<string, (row: AuditRow) => boolean> = {
		"duplicate-titles": (row) => sameTitle.has(id(row)),
		"no-description": (row) => !row.description && !row.noIndex,
		alt: (row) => row.issues.includes("alt"),
		"duplicate-descriptions": (row) => sameDescription.has(id(row)),
		"long-titles": (row) => row.searchTitle.length > TITLE_LIMIT,
		thin: (row) => row.issues.includes("depth"),
		"no-image": (row) => row.issues.includes("image"),
		hidden: (row) => row.noIndex,
	};
	return (finding, row) => tests[finding]?.(row) ?? false;
}

function findingsOf(list: AuditRow[]): AuditFinding[] {
	const matches = matcher(list);
	const order = { high: 0, medium: 1, low: 2 };
	return FINDINGS.map((finding) => {
		const affected = list.filter((row) => matches(finding.id, row)).sort((a, b) => a.score - b.score || a.title.localeCompare(b.title));
		return {
			id: finding.id,
			label: finding.label,
			count: affected.length,
			severity: finding.severity,
			entries: affected.slice(0, FINDING_ENTRIES).map((row) => ({ collection: row.collection, entryId: row.entryId, title: clip(row.title || "Untitled", 80), detail: clip(finding.detail(row), 80) })),
		};
	})
		.filter((finding) => finding.count > 0)
		.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
}

/** Sums the rows up and saves the result. `pass` is set when a full pass has just finished. */
async function summarize(ctx: Ctx, pass: boolean, known?: AuditRow[]): Promise<AuditSummary> {
	const previous = await ctx.kv.get<AuditSummary>(KEY.summary);
	const list = known ?? (await all(rows(ctx))).map((item) => item.data);
	const now = new Date().toISOString();
	// Entries hidden from search engines are counted, but not scored: there is nothing to fix on them.
	const shown = list.filter((row) => !row.noIndex);
	const score = shown.length ? Math.round(shown.reduce((sum, row) => sum + row.score, 0) / shown.length) : 0;
	const history = [...(previous?.history ?? [])];
	if (pass || history.length) {
		const date = now.slice(0, 10);
		if (history.at(-1)?.date === date) history[history.length - 1] = { date, score };
		else history.push({ date, score });
	}
	const summary: AuditSummary = {
		score,
		entries: list.length,
		needFixing: shown.filter((row) => row.high > 0).length,
		toImprove: shown.filter((row) => row.high === 0 && row.medium > 0).length,
		hidden: list.filter((row) => row.noIndex).length,
		findings: [...findingsOf(shown), ...findingsOf(list).filter((finding) => finding.id === "hidden")],
		scannedAt: pass ? now : (previous?.scannedAt ?? now),
		history: history.slice(-HISTORY),
	};
	await ctx.kv.set(KEY.summary, summary);
	await ctx.kv.delete(KEY.stale);
	return summary;
}

/** The summary of the last full pass, or null before the first one. Reads KV only. */
export async function auditSummary(ctx: Ctx): Promise<AuditSummary | null> {
	const summary = await ctx.kv.get<AuditSummary>(KEY.summary);
	return isRecord(summary) && typeof summary.score === "number" && Array.isArray(summary.findings) ? summary : null;
}

/** The summary, brought up to date when entries changed since it was computed. */
async function currentSummary(ctx: Ctx): Promise<AuditSummary | null> {
	const summary = await auditSummary(ctx);
	if (!summary || !(await ctx.kv.get<boolean>(KEY.stale))) return summary;
	try {
		return await summarize(ctx, false);
	} catch {
		return summary;
	}
}

/**
 * Scans the next batch of entries. When the pass is complete, rows of entries that no longer
 * exist are removed and the summary is computed.
 */
/** Host calls kept back for finishing a pass, and the most an invocation has made when it is still "fresh". */
const FINISH_CALLS = 6;
const FRESH_CALLS = 8;

export async function auditBatch(ctx: Ctx, env: Env, limits: ScanLimits = env.trusted ? SCAN_LIMITS : SANDBOX_SCAN_LIMITS): Promise<{ finished: boolean; done: number; busy?: boolean }> {
	// One batch at a time: a second press, a page load and the scheduled run would otherwise share
	// one cursor and remove each other's rows. KV has no compare-and-set, so the lease is written,
	// then read back. Two batches can still both pass that check when one reads before the other
	// writes, so a batch finishes (removes old rows, saves the summary) and releases the lease only
	// while the lease is still its own; the other ends as "already running".
	const held = await freshKv<{ token: string; until: number }>(ctx, KEY.lease);
	if (held && held.until > Date.now()) return { finished: false, done: 0, busy: true };
	const token = crypto.randomUUID();
	await ctx.kv.set(KEY.lease, { token, until: Date.now() + LEASE_MS });
	const mine = async () => (await freshKv<{ token: string }>(ctx, KEY.lease))?.token === token;
	if (!(await mine())) return { finished: false, done: 0, busy: true };
	try {
		RAN.add(ctx);
		// Releasing the lease costs a call; checking it first fits in the margin below the host's limit (budget test).
		return await runBatch(ctx, env, limits.calls === undefined ? limits : { ...limits, calls: limits.calls - 1 }, mine);
	} finally {
		if (await mine().catch(() => false)) await ctx.kv.delete(KEY.lease).catch(() => undefined);
	}
}

async function runBatch(ctx: Ctx, env: Env, limits: ScanLimits, mine: () => Promise<boolean>): Promise<{ finished: boolean; done: number; busy?: boolean }> {
	const collection = rows(ctx);
	// Each page of entries is read and written in bulk: one call per kind of record, not per entry.
	let pending: Array<{ id: string; data: AuditRow }> = [];
	const result = await scanEntries(
		ctx,
		KEY.cursor,
		limits,
		async (slug, id, _startedAt, item) => {
			const row = await buildRow(ctx, env, slug, id, item);
			if (row) pending.push({ id: rowId(slug, id), data: row });
		},
		Date.now(),
		{
			async before(slug, items) {
				const ids = items.map((item) => item.id);
				await prime(
					ctx,
					"entries",
					ids.map((id) => entryKey(slug, id)),
				);
				for (const module of env.modules) await module.prepare?.(ctx, env, slug, ids);
			},
			async after() {
				if (pending.length) await collection.putMany(pending);
				pending = [];
			},
		},
	);
	if (!result.finished) return { finished: false, done: result.done };
	// Finishing reads every row; when this invocation has no calls left for that, the next one does it.
	if (limits.calls !== undefined && hostCalls(ctx) > (result.done > 300 ? FRESH_CALLS : limits.calls - FINISH_CALLS)) return { finished: false, done: result.done };
	if (!(await mine())) return { finished: false, done: result.done, busy: true };
	const stored = await all(collection);
	const gone = stored.filter((item) => item.data.scannedAt < result.startedAt).map((item) => item.id);
	for (let at = 0; at < gone.length; at += 100) await collection.deleteMany(gone.slice(at, at + 100));
	await summarize(
		ctx,
		true,
		stored.filter((item) => item.data.scannedAt >= result.startedAt).map((item) => item.data),
	);
	await ctx.kv.delete(KEY.cursor);
	return { finished: true, done: result.done };
}

async function loadView(ctx: Ctx): Promise<View> {
	const saved = await ctx.kv.get<Partial<View>>(KEY.view);
	return {
		collection: typeof saved?.collection === "string" ? saved.collection : DEFAULT_VIEW.collection,
		show: SHOW.some((option) => option.value === saved?.show) ? (saved!.show as string) : DEFAULT_VIEW.show,
		sort: saved?.sort === "desc" ? "desc" : "asc",
	};
}

async function filterForm(ctx: Ctx): Promise<FormSpec> {
	const slugs = await scanCollections(ctx);
	const labels = new Map(((await ctx.schema?.listCollections()) ?? []).map((collection) => [collection.slug, collection.label]));
	return {
		id: "audit:filter",
		submitLabel: "Apply",
		fields: [
			{ kind: "select", key: "collection", label: "Collection", options: [{ label: "All collections", value: "all" }, ...slugs.map((slug) => ({ label: labels.get(slug) ?? slug, value: slug }))] },
			{ kind: "select", key: "show", label: "Show", options: SHOW },
		],
	};
}

const scanButton = (label: string, primary = false): Block => ({ type: "actions", elements: [{ type: "button", label, action_id: "audit:scan", ...(primary ? { style: "primary" as const } : {}) }] });

/** "12 of 14" once a finished scan says how many entries there are; otherwise "12 entries". */
const progress = (done: number, summary: AuditSummary | null) => (summary && summary.entries >= done ? `${done} of ${summary.entries}` : plural(done, "entry", "entries"));

function notScanned(cursor: ScanCursor | null): Block {
	return {
		type: "empty",
		title: "The site has not been scanned yet",
		description: cursor ? `Scanning: ${progress(cursor.done, null)} so far.` : "A scan checks the search title, description and content of every published entry.",
		actions: [{ type: "button", label: cursor ? "Continue the scan" : "Scan the site", action_id: "audit:scan", style: "primary" }],
	};
}

const editLink = (row: { collection: string; entryId: string }) => ({ type: "link", label: "Edit", target: { kind: "content", collection: row.collection, id: row.entryId } });

/** One finding on the Overview: what is wrong, what to do, and the entries to open. */
function findingBlock(finding: AuditFinding, labels: Map<string, string>, open: boolean): Block {
	const spec = FINDINGS.find((candidate) => candidate.id === finding.id);
	const listed = finding.entries ?? [];
	const content: Block[] = [note(spec?.todo ?? "")];
	if (listed.length) {
		content.push({
			type: "table",
			page_action_id: `audit:finding/${finding.id}`,
			columns: [
				{ key: "entry", label: "Entry" },
				{ key: "edit", label: "", format: "element" },
				{ key: "collection", label: "Collection" },
				...(listed.some((row) => row.detail) ? [{ key: "detail", label: "Now" }] : []),
			],
			rows: listed.map((row) => ({
				entry: row.title,
				edit: editLink(row),
				collection: labels.get(row.collection) ?? row.collection,
				detail: row.detail,
			})),
		});
	}
	// Summaries saved before entries were listed per finding, or more entries than fit here: the Content tab has them all.
	if (finding.count > listed.length) content.push({ type: "actions", elements: [{ type: "button", label: listed.length ? `Show all ${finding.count}` : "Show the entries", action_id: "audit:show", value: finding.id }] });
	return { type: "accordion", label: `${SEVERITY_LABEL[finding.severity]}: ${finding.label} (${plural(finding.count, "entry", "entries")})`, default_open: open, blocks: content };
}

async function overview(ctx: Ctx, env: Env): Promise<Block[]> {
	const blocks: Block[] = [];
	const core = await env.core(ctx);
	if (core?.staging) blocks.push({ type: "banner", variant: "alert", title: "The site is in staging mode", description: "Search engines are asked not to index the site until staging mode is switched off." });
	// Opening the page carries a scan under way on by one batch.
	if ((env.trusted || !RAN.has(ctx)) && (await ctx.kv.get(KEY.cursor))) await auditBatch(ctx, env).catch(() => undefined);
	const summary = await currentSummary(ctx);
	const cursor = await ctx.kv.get<ScanCursor>(KEY.cursor);
	if (!summary) return [...blocks, notScanned(cursor)];
	blocks.push(
		{ type: "meter", label: "SEO score", value: summary.score, custom_value: `${summary.score} / 100` },
		// Three cards: the host's stats row does not wrap, and a fourth runs off a phone screen. Hidden entries are a finding below.
		{
			type: "stats",
			items: [
				{ label: "Entries scanned", value: summary.entries },
				{ label: "Need fixing", value: summary.needFixing },
				{ label: "To improve", value: summary.toImprove },
			],
		},
	);
	if (summary.history.length >= 2) {
		blocks.push({
			type: "chart",
			config: { chart_type: "timeseries", series: [{ name: "SEO score", data: summary.history.map((point) => [Date.parse(point.date), point.score] as [number, number]) }], y_axis_name: "Score", style: "line", height: 220 },
		});
	}
	if (summary.findings.length) {
		const labels = new Map(((await ctx.schema?.listCollections().catch(() => [])) ?? []).map((collection) => [collection.slug, collection.label]));
		summary.findings.forEach((finding, index) => blocks.push(findingBlock(finding, labels, index === 0)));
	} else {
		blocks.push(note("No problems found. New and changed entries are checked when they are saved."));
	}
	// A template's noindex reaches the page but not EmDash's sitemap, which reads only the entry's own setting.
	if (env.modules.some((module) => module.id === "meta")) {
		const hidden = Object.entries((await titlesSection.load(ctx.settings)).collections).filter(([, titles]) => titles.noindex).map(([slug]) => slug);
		const labels = hidden.length ? new Map(((await ctx.schema?.listCollections()) ?? []).map((collection) => [collection.slug, collection.label])) : null;
		if (labels) blocks.push(note(`${hidden.map((slug) => labels.get(slug) ?? slug).join(", ")}: hidden from search engines by a template, but EmDash's sitemap still lists these entries.`));
	}
	blocks.push(note(cursor ? `Last scanned ${ago(summary.scannedAt).toLowerCase()}. Scanning again: ${progress(cursor.done, summary)}.` : `Last scanned ${ago(summary.scannedAt).toLowerCase()}.`), scanButton(cursor ? "Continue the scan" : "Scan now"));
	return blocks;
}

async function entriesTab(ctx: Ctx, state: PageState): Promise<Block[]> {
	const list = (await all(rows(ctx))).map((item) => item.data);
	if (!list.length) return [notScanned(await ctx.kv.get<ScanCursor>(KEY.cursor))];
	const view = await loadView(ctx);
	const matches = matcher(list);
	const keep: Record<string, (row: AuditRow) => boolean> = {
		all: () => true,
		fix: (row) => row.high > 0 && !row.noIndex,
		notitle: (row) => !row.hasSeoTitle,
	};
	for (const finding of FINDINGS) keep[finding.id] = (row) => matches(finding.id, row);
	const direction = view.sort === "desc" ? -1 : 1;
	const shown = list
		.filter((row) => view.collection === "all" || row.collection === view.collection)
		.filter(keep[view.show] ?? keep.all!)
		.sort((a, b) => Number(a.noIndex) - Number(b.noIndex) || (a.score - b.score) * direction || a.title.localeCompare(b.title));
	const paging = state.action?.module === "audit" && state.action.id === "entries" && isRecord(state.action.value) ? Number(state.action.value.cursor) : 0;
	const end = Math.min(MAX_SHOWN, (Number.isFinite(paging) && paging > 0 ? paging : 0) + PAGE_SIZE);
	const blocks: Block[] = [
		formBlock(await filterForm(ctx), view),
		{
			type: "table",
			page_action_id: "audit:entries",
			empty_text: "No entries match.",
			columns: [
				{ key: "entry", label: "Entry" },
				// Next to the entry, so it stays on screen when a narrow window scrolls the table sideways.
				{ key: "edit", label: "", format: "element" },
				{ key: "score", label: "Score", format: "number", sortable: true },
				{ key: "searchTitle", label: "Search title" },
				{ key: "description", label: "Description" },
				{ key: "issues", label: "Issues" },
			],
			rows: shown.slice(0, end).map((row) => ({
				entry: clip(row.title || "Untitled", 80),
				edit: editLink(row),
				score: row.noIndex ? "—" : row.score,
				searchTitle: clip(row.searchTitle, 80) || "Not set",
				description: clip(row.description, 90) || "Not set",
				issues: issuesOf(row),
			})),
			...(shown.length > end && end < MAX_SHOWN ? { next_cursor: String(end) } : {}),
		},
	];
	function issuesOf(row: AuditRow): string {
		if (row.noIndex) return NOT_SCORED;
		const names = FINDINGS.filter((finding) => finding.id !== "hidden" && matches(finding.id, row)).map((finding) => finding.short);
		return names.length ? names.join(", ") : row.high + row.medium ? "See the entry's SEO panel" : "None";
	}
	const total = plural(shown.length, "entry", "entries");
	blocks.push(note(shown.length > MAX_SHOWN && end >= MAX_SHOWN ? `Showing the first ${MAX_SHOWN} of ${total}. Use the filters to narrow the list.` : total));
	return blocks;
}

async function widget(ctx: Ctx): Promise<Block[]> {
	const summary = await auditSummary(ctx);
	const open: Block = { type: "actions", elements: [{ type: "link", label: "Open SEO overview", target: { kind: "plugin-page", path: "/overview" }, appearance: "secondary" }] };
	if (!summary) return [{ type: "empty", title: "Not scanned yet", description: "The first scan starts within five minutes, or start it from the overview.", size: "sm" }, open];
	const blocks: Block[] = [
		{ type: "meter", label: "SEO score", value: summary.score, custom_value: `${summary.score} / 100` },
		{
			type: "stats",
			items: [
				{ label: "Entries", value: summary.entries },
				{ label: "Need fixing", value: summary.needFixing },
				{ label: "To improve", value: summary.toImprove },
			],
		},
	];
	// The worst entry of each of the top findings, to open straight from the dashboard.
	// Each finding offers its worst entry not already listed, so the rows are three different entries where possible.
	const used = new Set<string>();
	const first = summary.findings.slice(0, 3).flatMap((finding) => {
		const list = finding.entries ?? [];
		const row = list.find((candidate) => !used.has(candidate.entryId)) ?? list[0];
		if (!row) return [];
		used.add(row.entryId);
		return [{ finding, row }];
	});
	if (first.length) {
		blocks.push({
			type: "table",
			page_action_id: "audit:widget",
			columns: [
				{ key: "entry", label: "Fix first" },
				{ key: "finding", label: "Finding" },
				{ key: "edit", label: "", format: "element" },
			],
			rows: first.map(({ finding, row }) => ({ entry: row.title, finding: finding.label, edit: editLink(row) })),
		});
	}
	blocks.push(note(`Last scanned ${ago(summary.scannedAt).toLowerCase()}.`), open);
	return blocks;
}

export const audit: Module = {
	id: "audit",
	feature: { label: "Site audit", description: "Scores every entry and lists what to fix." },
	capabilities: ["content:read", "schema:read"],
	storage: { audit: { indexes: ["collection", "score", "scannedAt"] } },
	tabs: [
		{ page: "/", label: "Overview", order: 10, render: (ctx, env) => overview(ctx, env) },
		{ page: "/content", label: "Entries", order: 10, render: (ctx, _env, state) => entriesTab(ctx, state) },
	],
	widgets: [{ id: "health", title: "SEO health", size: "half", render: (ctx) => widget(ctx) }],

	async act(ctx, env, action) {
		if (action.id === "scan") {
			const result = await auditBatch(ctx, env);
			if (result.busy) return { toast: { type: "info", message: "A scan is already running." } };
			if (result.finished) return ok(`Scan complete: ${plural(result.done, "entry", "entries")}`);
			// The page shows how far the scan has got; a message here would show an older count.
			return {};
		}
		if (action.id === "show" && typeof action.value === "string" && FINDINGS.some((finding) => finding.id === action.value)) {
			await ctx.kv.set(KEY.view, { ...DEFAULT_VIEW, show: action.value });
			return { page: "/content" };
		}
		if (action.id === "filter" && action.values) {
			const view = await loadView(ctx);
			await ctx.kv.set(KEY.view, readForm(await filterForm(ctx), action.values, view));
			return {};
		}
		if (action.id === "entries") {
			// Sorting and paging of the entries table; the page itself comes from the action value.
			const sort = isRecord(action.value) && isRecord(action.value.sort) ? action.value.sort : null;
			if (sort?.key === "score" && (sort.dir === "asc" || sort.dir === "desc")) await ctx.kv.set(KEY.view, { ...(await loadView(ctx)), sort: sort.dir });
			return {};
		}
		return null;
	},

	on: {
		save: (ctx, env, event) => refresh(ctx, env, event.collection, event.id),
		publish: (ctx, env, event) => refresh(ctx, env, event.collection, event.id),
		unpublish: (ctx, env, event) => refresh(ctx, env, event.collection, event.id),
		async delete(ctx, _env, event) {
			await rows(ctx).delete(rowId(event.collection, event.id));
			await ctx.kv.set(KEY.stale, true);
		},
	},

	cron: [
		{
			name: "audit-scan",
			schedule: "*/5 * * * *",
			async run(ctx, env) {
				// A new pass starts a day after the last one finished; a pass under way always continues.
				const underWay = await ctx.kv.get<ScanCursor>(KEY.cursor);
				const summary = await auditSummary(ctx);
				if (!underWay && summary && Date.now() - Date.parse(summary.scannedAt) < DAY) return;
				await auditBatch(ctx, env);
			},
		},
	],
};
