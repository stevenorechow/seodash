import { describe, expect, it } from "vitest";
import { type AuditRow, type AuditSummary, audit, auditBatch, auditSummary } from "../src/modules/audit.js";
import { entry } from "../src/modules/entry.js";
import { meta } from "../src/modules/meta.js";
import { type FakeItem, harness, textOf, valid } from "./helpers.js";

const body = (text: string) => [{ _type: "block", style: "normal", children: [{ _type: "span", text }] }];
const seo = (title: string | null, description: string | null, noIndex = false) => ({ title, description, image: null, canonical: null, noIndex });

function content(): Record<string, FakeItem[]> {
	const posts: FakeItem[] = [];
	for (let n = 1; n <= 93; n++) posts.push({ id: `p${n}`, slug: `post-${n}`, data: { title: `Post number ${n}`, excerpt: `Summary of post ${n}.`, content: body(`Text of post ${n}.`) } });
	posts[0]!.seo = seo("Shared title", "A description nobody else has.");
	posts[1]!.seo = seo("Shared title", "The same description.");
	posts[2]!.seo = seo("A title of its own", "The same description.");
	posts[3]!.seo = seo(null, null, true);
	posts[4] = { id: "p5", slug: "post-5", data: { title: "No summary here", content: body("Short.") } };
	posts.push({ id: "draft", slug: "draft", status: "draft", data: { title: "Not published" } });
	const pages: FakeItem[] = [
		{ id: "home", slug: "home", data: { title: "Home", excerpt: "Welcome." } },
		{ id: "about", slug: "about", data: { title: "About us", excerpt: "Who we are." } },
	];
	return { posts, pages, secret: [{ id: "s1", data: { title: "Hidden collection" } }] };
}

const site = (options: Parameters<typeof harness>[1] = {}) =>
	harness([meta, entry, audit], {
		collections: [
			{ slug: "posts", label: "Posts" },
			{ slug: "pages", label: "Pages" },
			{ slug: "secret", label: "Secret", hidden: true },
		],
		content: content(),
		...options,
	});

type Site = ReturnType<typeof site>;
const cron = (h: Site) => h.built.hooks.cron({ name: "audit-scan" }, h.ctx);
const rowsOf = (h: Site) => new Map([...h.ctx.collection("audit").data.entries()].map(([id, row]) => [id, { ...(row as AuditRow), scannedAt: "" }]));
const underWay = (h: Site) => h.ctx.kv.get("audit:cursor");

async function scanAll(h: Site): Promise<number> {
	let runs = 0;
	do {
		await cron(h);
		runs++;
	} while ((await underWay(h)) && runs < 20);
	return runs;
}

describe("site scan", () => {
	it("is cut into several runs and ends with the same rows as one long run", async () => {
		const h = site();
		await cron(h);
		expect(h.ctx.collection("audit").data.size).toBe(42);
		expect(await underWay(h)).toMatchObject({ done: 42 });
		expect(await auditSummary(h.ctx)).toBeNull();
		const runs = 1 + (await scanAll(h));
		expect(runs).toBe(3);

		const whole = site();
		expect(await auditBatch(whole.ctx, whole.env, { items: 10_000, ms: 60_000 })).toEqual({ finished: true, done: 95 });
		expect(rowsOf(h)).toEqual(rowsOf(whole));
		// Published entries of visible collections only.
		expect(h.ctx.collection("audit").data.size).toBe(95);
		expect(h.ctx.collection("audit").data.has("posts:draft")).toBe(false);
		expect(h.ctx.collection("audit").data.has("secret:s1")).toBe(false);
		expect(await underWay(h)).toBeNull();
	});

	it("waits a day after a full pass, then scans again and drops entries that are gone", async () => {
		const h = site();
		await scanAll(h);
		const first = (await auditSummary(h.ctx))!;
		expect(first.entries).toBe(95);

		h.ctx.items.posts = h.ctx.items.posts!.filter((item) => item.id !== "p9");
		await cron(h);
		expect(await underWay(h)).toBeNull();
		expect(h.ctx.collection("audit").data.has("posts:p9")).toBe(true);

		await h.ctx.kv.set("audit:summary", { ...first, scannedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString() });
		await new Promise((resolve) => setTimeout(resolve, 3));
		await scanAll(h);
		expect(h.ctx.collection("audit").data.has("posts:p9")).toBe(false);
		expect((await auditSummary(h.ctx))!.entries).toBe(94);
	});

	it("reports progress from the button and finishes on later presses", async () => {
		const h = site();
		const first = await h.press("/", "audit:scan");
		expect(first.toast).toEqual({ type: "info", message: "Scanned 42 entries. Press again or reload to continue; it also carries on by itself." });
		// Rendering the page after the press carried the scan on by another batch.
		expect(textOf(first)).toContain("Scanning: 82 entries so far.");
		expect(textOf(first)).toContain("Continue the scan");
		valid(first);
		const last = await h.press("/", "audit:scan");
		expect(last.toast).toEqual({ type: "success", message: "Scan complete: 95 entries" });
		// A later scan counts against the entries the last one found.
		const again = await h.press("/", "audit:scan");
		expect(again.toast?.message).toBe("Scanned 42 of 95. Press again or reload to continue; it also carries on by itself.");
		expect(textOf(again)).toContain("Scanning again: 82 of 95.");
	});
});

describe("findings", () => {
	it("finds duplicate titles and descriptions, missing descriptions and hidden entries", async () => {
		const h = site();
		await scanAll(h);
		const summary = (await auditSummary(h.ctx))!;
		const count = (id: string) => summary.findings.find((finding) => finding.id === id)?.count ?? 0;
		expect(count("duplicate-titles")).toBe(2);
		expect(count("duplicate-descriptions")).toBe(2);
		expect(count("no-description")).toBe(1);
		expect(count("hidden")).toBe(1);
		expect(summary.hidden).toBe(1);
		expect(summary.score).toBeGreaterThan(0);
		expect(summary.history).toHaveLength(1);
		expect(summary.findings[0]!.severity).toBe("high");

		const row = h.ctx.collection("audit").data.get("posts:p1") as AuditRow;
		expect(row).toMatchObject({ collection: "posts", entryId: "p1", title: "Post number 1", url: "https://acme.test/posts/post-1", searchTitle: "Shared title", hasSeoTitle: true, hasSeoDescription: true, noIndex: false });
		expect(row.issues).toContain("image");
		expect(row.high + row.medium + row.low).toBe(row.issues.length);
	});
});

describe("single entries", () => {
	it("refreshes a row on save and removes it on unpublish and delete", async () => {
		const h = site();
		await scanAll(h);
		const before = (h.ctx.collection("audit").data.get("posts:p1") as AuditRow).searchTitle;
		expect(before).toBe("Shared title");
		h.ctx.items.posts![0]!.seo = seo("A new title", "A description nobody else has.");
		await h.built.hooks.save({ collection: "posts", content: { id: "p1" } }, h.ctx);
		expect((h.ctx.collection("audit").data.get("posts:p1") as AuditRow).searchTitle).toBe("A new title");
		// The overview catches up without a new scan.
		const page = await h.page("/");
		expect(textOf(page)).not.toContain("Search title used by more than one entry");

		h.ctx.items.posts![1]!.status = "draft";
		await h.built.hooks.unpublish({ collection: "posts", content: { id: "p2" } }, h.ctx);
		expect(h.ctx.collection("audit").data.has("posts:p2")).toBe(false);

		await h.built.hooks.remove({ collection: "posts", id: "p3" }, h.ctx);
		expect(h.ctx.collection("audit").data.has("posts:p3")).toBe(false);

		// A newly published entry gets a row straight away.
		h.ctx.items.pages!.push({ id: "new", slug: "new", data: { title: "Brand new" } });
		await h.built.hooks.publish({ collection: "pages", content: { id: "new" } }, h.ctx);
		expect(h.ctx.collection("audit").data.has("pages:new")).toBe(true);
	});
});

describe("overview", () => {
	it("offers a scan before the first one", async () => {
		const h = site();
		for (const path of ["/", "/content"]) {
			const page = await h.page(path);
			valid(page);
			expect(textOf(page)).toContain("The site has not been scanned yet");
			expect(textOf(page)).toContain("Scan the site");
		}
		const widget = await h.page("widget:health");
		valid(widget);
		expect(textOf(widget)).toContain("Not scanned yet");
		expect(h.built.admin.widgets).toEqual([{ id: "health", title: "SEO health", size: "half" }]);
	});

	it("shows the score, counts and findings after a scan", async () => {
		const h = site();
		await scanAll(h);
		const page = await h.page("/");
		valid(page);
		const text = textOf(page);
		expect(text).toContain("Entries scanned");
		expect(text).toContain("Search title used by more than one entry");
		expect(text).toContain("Scan now");
		expect(text).not.toContain('"chart"');
		// A single tab shows without a tab bar.
		expect(text).not.toContain('"tab"');

		const widget = await h.page("widget:health");
		valid(widget);
		expect(textOf(widget)).toContain("Need fixing");
		expect((widget.blocks.find((block) => block.type === "table") as { rows: unknown[] }).rows).toHaveLength(3);
	});

	it("draws the trend once there are two scores", async () => {
		const h = site();
		await scanAll(h);
		const summary = (await auditSummary(h.ctx)) as AuditSummary;
		await h.ctx.kv.set("audit:summary", { ...summary, history: [{ date: "2026-11-01", score: 50 }, ...summary.history] });
		const page = await h.page("/");
		valid(page);
		expect(textOf(page)).toContain('"chart"');
	});

	it("warns when the site is in staging mode", async () => {
		const h = site({ core: { staging: true } });
		const page = await h.page("/");
		valid(page);
		expect(textOf(page)).toContain("staging mode");
		expect(textOf(await site().page("/"))).not.toContain("staging mode");
	});
});

describe("entries table", () => {
	const table = (response: { blocks: Array<{ type: string }> }) => response.blocks.find((block) => block.type === "table") as unknown as { rows: Array<Record<string, any>>; next_cursor?: string };

	it("links each entry to its editor, worst score first, and pages through the list", async () => {
		const h = site();
		await scanAll(h);
		const page = await h.page("/content");
		valid(page);
		const first = table(page);
		expect(first.rows).toHaveLength(25);
		expect(first.next_cursor).toBe("25");
		expect(first.rows[0]!.edit).toMatchObject({ type: "link", target: { kind: "content", collection: "posts" } });
		const scores = first.rows.map((row) => row.score as number);
		expect(scores).toEqual([...scores].sort((a, b) => a - b));

		const more = await h.press("/content", "audit:entries", { cursor: "25", sort: null });
		valid(more);
		expect(table(more).rows).toHaveLength(50);
	});

	it("keeps the chosen filters and sort order", async () => {
		const h = site();
		await scanAll(h);
		const pages = await h.submit("/content", "audit:filter", { collection: "pages", show: "all" });
		valid(pages);
		expect(table(pages).rows.map((row) => row.entry).sort()).toEqual(["About us", "Home"]);
		expect(await h.ctx.kv.get("audit:view")).toMatchObject({ collection: "pages", show: "all" });
		// A fresh page load still has the filter.
		expect(table(await h.page("/content")).rows).toHaveLength(2);

		const duplicates = await h.submit("/content", "audit:filter", { collection: "all", show: "duplicates" });
		expect(table(duplicates).rows.map((row) => row.edit.target.id).sort()).toEqual(["p1", "p2", "p3"]);
		const missing = await h.submit("/content", "audit:filter", { collection: "posts", show: "nodescription" });
		expect(table(missing).rows.map((row) => row.edit.target.id)).toEqual(["p5"]);
		const untitled = await h.submit("/content", "audit:filter", { collection: "pages", show: "notitle" });
		expect(table(untitled).rows).toHaveLength(2);
		const fix = await h.submit("/content", "audit:filter", { collection: "all", show: "fix" });
		valid(fix);
		expect(table(fix).rows.map((row) => row.edit.target.id)).toContain("p5");

		await h.submit("/content", "audit:filter", { collection: "all", show: "all" });
		const sorted = await h.press("/content", "audit:entries", { sort: { key: "score", dir: "desc" } });
		const scores = table(sorted).rows.map((row) => row.score as number);
		expect(scores).toEqual([...scores].sort((a, b) => b - a));
		expect(await h.ctx.kv.get("audit:view")).toMatchObject({ sort: "desc" });
		expect(table(await h.page("/content")).rows[0]!.score).toBe(scores[0]);
	});
});
