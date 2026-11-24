/**
 * Regression tests for the defects confirmed by the production-readiness audit of 2026-11-15
 * (docs/audit/REPORT.md). Each one fails against revision cb00442 and describes the behaviour
 * the fix has to produce. They are written before any fix, at the owner's request.
 *
 * They were committed as `it.fails` (a4674e6) and switched to `it` with the fixes. The cases after
 * them cover the rest of the approved fixes: the site URL fallback (L2) and the sitemap notes (L4).
 */
import { describe, expect, it } from "vitest";
import { MODULES } from "../src/modules/index.js";
import { harness } from "./helpers.js";

type Any = Record<string, any>;
const posts = { collections: [{ slug: "posts", label: "Posts" }], content: { posts: [{ id: "p1", slug: "hello", data: { title: "Hello" } }] } };
const article = { url: "https://acme.test/posts/hello", path: "/posts/hello", pageType: "article", title: "Hello", content: { collection: "posts", id: "p1", slug: "hello" } };
const OUTPUT = { enabled: true, publisher: false, website: false, searchUrl: "", breadcrumbs: false };
function walk(blocks: Any[], out: Any[] = []): Any[] {
	for (const block of blocks ?? []) {
		out.push(block);
		walk(block.blocks, out);
		for (const panel of block.panels ?? []) walk(panel.blocks, out);
		if (block.type === "columns") for (const column of block.columns) walk(column, out);
	}
	return out;
}
const types = async (h: ReturnType<typeof harness>) => ((await h.head(article)) ?? []).filter((tag: Any) => tag.kind === "jsonld").flatMap((tag: Any) => (Array.isArray(tag.graph) ? tag.graph : [tag.graph]).map((node: Any) => node["@type"]));

describe("audit A1: settings export", () => {
	it("includes the publisher, local business and automatic rules, so an import restores them", async () => {
		const h = harness(MODULES, posts);
		await h.submit("/schema", "schema:publisher", { type: "Organization", name: "Acme Works" });
		await h.submit("/schema", "schema:local", { enabled: true, name: "Acme Shop" });
		await h.submit("/schema", "schema:rule-save/new/faq", { ruleCollection: "posts", questions: "Q? | A." });
		const code = walk((await h.page("/settings")).blocks as Any[]).find((block) => block.type === "code")!.code as string;
		const exported = JSON.parse(code);
		expect(Object.keys(exported)).toEqual(expect.arrayContaining(["config:schemaPublisher", "config:schemaLocal", "config:schemaRules"]));
		const other = harness(MODULES, posts);
		await other.submit("/settings", "tools:import", { json: code });
		expect(await other.ctx.settings.get("config:schemaPublisher")).toMatchObject({ name: "Acme Works" });
		expect(((await other.ctx.settings.get<{ rules: unknown[] }>("config:schemaRules")) ?? { rules: [] }).rules).toHaveLength(1);
	});
});

describe("audit A2: duplicate structured data", () => {
	it("prints one Product node when two rules of that type cover the same collection", async () => {
		const h = harness(MODULES, posts);
		await h.submit("/schema", "schema:output", OUTPUT);
		for (let i = 0; i < 2; i++) await h.submit("/schema", "schema:rule-save/new/product", { ruleCollection: "posts", name: "%%post_title%%", sku: "S-1" });
		expect((await types(h)).filter((type: string) => type === "Product")).toHaveLength(1);
	});

	it("prints one FAQPage when an entry is given a second FAQ", async () => {
		const h = harness(MODULES, posts);
		await h.submit("/schema", "schema:output", OUTPUT);
		for (const questions of ["First? | Yes.", "Second? | Also yes."]) await h.panel("posts", "p1", { type: "form_submit", action_id: "schema:save/new/faq", values: { questions } });
		expect((await types(h)).filter((type: string) => type === "FAQPage")).toHaveLength(1);
	});
});

describe("audit A3: a refused save", () => {
	it("renders the form under a new identity, so EmDash resets the switch the user turned on", async () => {
		// EmDash keys blocks by block_id (@emdash-cms/blocks dist/index.js:1151) and a toggle keeps
		// its own state (index.js:416); only a new key makes it show the saved value again.
		const h = harness(MODULES, { ...posts, core: null });
		const before = walk((await h.page("/settings")).blocks as Any[]).find((block) => String(block.block_id).startsWith("indexing:settings"))!;
		// Refused: someone else's redirect already sits at the key file's address.
		const { key } = (await h.ctx.settings.get<{ key: string }>("config:indexing"))!;
		h.ctx.rules.set("other", { id: "other", source: `/${key}.txt`, destination: "/elsewhere", type: 301, groupName: null, rev: 1 });
		const refused = await h.submit("/settings", "indexing:settings", { indexnow: true, google: false, onPublish: true, collections: [] });
		expect(refused.toast).toMatchObject({ type: "error" });
		const after = walk(refused.blocks as Any[]).find((block) => block.type === "form" && block.submit?.action_id === "indexing:settings")!;
		expect(after.fields.find((field: Any) => field.action_id === "indexnow").initial_value).toBe(false);
		expect(after.block_id).not.toBe(before.block_id);
	});
});

describe("audit A4: the entry panel", () => {
	it("shows the whole search title and description, not only in a truncating fields block", async () => {
		const title = "A search title that is quite a bit longer than twenty characters";
		const description = "A description long enough that the panel's two-column fields block cuts it off after a few words.";
		const h = harness(MODULES, { collections: posts.collections, content: { posts: [{ id: "p1", slug: "hello", data: { title: "Hello" }, seo: { title, description, image: null, canonical: null, noIndex: false } }] }, core: null });
		// Only what is visible without expanding a section; a fields value is cut off after a few words.
		const top = ((await h.panel("posts", "p1")).blocks as Any[]).filter((block) => block.type !== "accordion");
		const outsideFields = JSON.stringify(top.filter((block) => block.type !== "fields" && block.type !== "form"));
		expect(outsideFields).toContain(title);
		expect(outsideFields).toContain(description);
	});
});

describe("audit A5: overlapping scans", () => {
	it("does not run a second batch while one is already running", async () => {
		const many = { collections: [{ slug: "posts", label: "Posts" }], content: { posts: Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, slug: `p-${i}`, data: { title: `Post ${i}` } })) } };
		const h = harness(MODULES, { ...many, core: null });
		let lists = 0;
		const list = h.ctx.content!.list.bind(h.ctx.content);
		(h.ctx.content as { list: unknown }).list = async (...args: Parameters<typeof list>) => {
			lists++;
			await new Promise((resolve) => setTimeout(resolve, 5));
			return list(...args);
		};
		const [first, second] = await Promise.all([h.press("/overview", "audit:scan"), h.press("/overview", "audit:scan")]);
		const single = harness(MODULES, { ...many, core: null });
		let alone = 0;
		const listAlone = single.ctx.content!.list.bind(single.ctx.content);
		(single.ctx.content as { list: unknown }).list = async (...args: Parameters<typeof listAlone>) => {
			alone++;
			return listAlone(...args);
		};
		await single.press("/overview", "audit:scan");
		expect(lists).toBeLessThanOrEqual(alone);
		expect([first.toast?.message, second.toast?.message].join(" ")).toMatch(/already|under way|in progress/i);
	});
	it("lets only one of two batches finish when both passed the lease check", async () => {
		// The second batch reads the lease before the first writes it (KV has no compare-and-set), so
		// both start. Only the one whose lease is still in place may remove rows and save the summary.
		const many = { collections: [{ slug: "posts", label: "Posts" }], content: { posts: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, slug: `p-${i}`, data: { title: `Post ${i}` } })) } };
		// Trusted, so a batch can finish the pass in one invocation.
		const h = harness(MODULES, many);
		const kv = h.ctx.kv as unknown as { get: (key: string) => Promise<unknown> };
		const get = kv.get.bind(kv);
		let reads = 0;
		let firstChecked!: () => void;
		const checked = new Promise<void>((resolve) => (firstChecked = resolve));
		kv.get = async (key: string) => {
			if (key !== "audit:lease") return get(key);
			reads++;
			if (reads === 2) {
				const stale = await get(key);
				await checked;
				return stale;
			}
			const value = await get(key);
			if (reads === 3) firstChecked();
			return value;
		};
		const [first, second] = await Promise.all([h.press("/overview", "audit:scan"), h.press("/overview", "audit:scan")]);
		const messages = [first.toast?.message, second.toast?.message];
		expect(messages.filter((message) => message === "A scan is already running.")).toHaveLength(1);
		expect(messages.filter((message) => /^Scan complete/.test(message ?? ""))).toHaveLength(1);
		expect(await get("audit:lease")).toBeNull();
		const summary = (await get("audit:summary")) as { entries: number };
		expect(summary.entries).toBe(6);
	});
});

describe("audit D1: a full export round-trips", () => {
	it("restores every section on a fresh site, unchanged", async () => {
		const h = harness(MODULES, posts);
		await h.submit("/titles", "meta:collection/posts", { title: "%%post_title%% x", description: "D", noindex: true, nofollow: false });
		await h.submit("/schema", "schema:output", { ...OUTPUT, publisher: true });
		await h.submit("/schema", "schema:publisher", { type: "Organization", name: "Acme Works", logo: "https://acme.test/logo.png" });
		await h.submit("/schema", "schema:local", { enabled: true, name: "Acme Shop" });
		await h.submit("/schema", "schema:rule-save/new/faq", { ruleCollection: "posts", questions: "Q? | A." });
		await h.submit("/settings", "checks:settings", { requireDescription: true, requireAlt: false, collections: [] });
		const code = walk((await h.page("/settings")).blocks as Any[]).find((block) => block.type === "code")!.code as string;
		const fresh = harness(MODULES, posts);
		const imported = await fresh.submit("/settings", "tools:import", { json: code });
		expect(imported.toast).toMatchObject({ type: "success" });
		const again = walk((await fresh.page("/settings")).blocks as Any[]).find((block) => block.type === "code")!.code as string;
		expect(JSON.parse(again)).toEqual(JSON.parse(code));
		expect(Object.keys(JSON.parse(code))).toEqual(expect.arrayContaining(["config:titles", "config:schema", "config:schemaPublisher", "config:schemaLocal", "config:schemaRules", "config:checks", "config:features"]));
	});
});

describe("audit D3: one node per type", () => {
	it("refuses a second rule of the same type for the same collection", async () => {
		const h = harness(MODULES, posts);
		await h.submit("/schema", "schema:rule-save/new/product", { ruleCollection: "posts", name: "%%post_title%%" });
		const second = await h.submit("/schema", "schema:rule-save/new/product", { ruleCollection: "posts", name: "Other" });
		expect(second.toast).toMatchObject({ type: "error", message: "Posts already has an automatic Product rule. Edit that one instead." });
		expect(((await h.ctx.settings.get<{ rules: unknown[] }>("config:schemaRules")) ?? { rules: [] }).rules).toHaveLength(1);
	});

	it("merges an entry's FAQ items into one FAQPage with every question", async () => {
		const h = harness(MODULES, posts);
		await h.submit("/schema", "schema:output", OUTPUT);
		for (const questions of ["First? | Yes.", "Second? | Also yes."]) await h.panel("posts", "p1", { type: "form_submit", action_id: "schema:save/new/faq", values: { questions } });
		const graphs = ((await h.head(article)) ?? []).filter((tag: Any) => tag.kind === "jsonld").map((tag: Any) => tag.graph);
		const faq = graphs.find((graph: Any) => graph["@type"] === "FAQPage");
		expect(faq.mainEntity.map((question: Any) => question.name)).toEqual(["First?", "Second?"]);
	});

	it("prints the first of two Products and says so in the panel", async () => {
		const h = harness(MODULES, posts);
		await h.submit("/schema", "schema:output", OUTPUT);
		for (const name of ["One", "Two"]) await h.panel("posts", "p1", { type: "form_submit", action_id: "schema:save/new/product", values: { name } });
		const graphs = ((await h.head(article)) ?? []).filter((tag: Any) => tag.kind === "jsonld").map((tag: Any) => tag.graph);
		expect(graphs.filter((graph: Any) => graph["@type"] === "Product").map((graph: Any) => graph.name)).toEqual(["One"]);
		const panel = JSON.stringify((await h.panel("posts", "p1", { type: "form_submit", action_id: "schema:list" })).blocks);
		expect(panel).toContain("Only the first Product is printed");
		expect(panel).toContain("Not printed");
	});
});

describe("audit L2: an empty site address", () => {
	const page = (url: string) => ({ ...article, url, image: null });
	const setUp = async (url = "") => {
		const h = harness(MODULES, { ...posts, site: { url }, core: null });
		await h.ctx.storage.entries!.put("posts:p1", { collection: "posts", entryId: "p1", ogImage: "/og-audit.png" });
		await h.panel("posts", "p1", { type: "form_submit", action_id: "entry:social", values: { ogTitle: "Shared", ogDescription: "" } });
		await h.submit("/schema", "schema:output", { ...OUTPUT, publisher: true, website: true });
		await h.submit("/schema", "schema:publisher", { type: "Organization", name: "Acme Works", logo: "/logo.png" });
		return h;
	};
	const relative = (tags: Any[]) => JSON.stringify(tags).match(/"(content|url|@id|logo)":"(\/|#)[^"]*"/g) ?? [];

	it("builds addresses and ids from the address the page was requested at", async () => {
		const h = await setUp();
		const tags = (await h.head(page("https://shop.example/posts/hello"))) ?? [];
		expect(tags).toContainEqual(expect.objectContaining({ property: "og:image", content: "https://shop.example/og-audit.png" }));
		const publisher = (tags as Any[]).find((tag) => tag.graph?.["@type"] === "Organization")!.graph;
		expect(publisher).toMatchObject({ "@id": "https://shop.example/#publisher", url: "https://shop.example/", logo: { url: "https://shop.example/logo.png" } });
		expect(relative(tags)).toEqual([]);
	});

	it("leaves out what needs an address when there is none, and prints nothing relative", async () => {
		const h = await setUp();
		const tags = (await h.head(page("/posts/hello"))) ?? [];
		expect(tags.some((tag: Any) => tag.property === "og:image")).toBe(false);
		expect(relative(tags)).toEqual([]);
		expect(JSON.stringify(tags)).not.toContain('"#publisher"');
	});

	it("ignores a loopback address stored while developing when the page is served from a real host", async () => {
		const h = await setUp("http://localhost:4321");
		const tags = (await h.head(page("https://shop.example/posts/hello"))) ?? [];
		expect(tags).toContainEqual(expect.objectContaining({ property: "og:image", content: "https://shop.example/og-audit.png" }));
		expect(JSON.stringify(tags)).not.toMatch(/localhost|127\.0\.0\.1/);
		expect(relative(tags)).toEqual([]);
	});

	it("keeps the loopback address on a site that is served from it", async () => {
		const h = await setUp("http://localhost:4321");
		const tags = (await h.head(page("http://localhost:4321/posts/hello"))) ?? [];
		expect(tags).toContainEqual(expect.objectContaining({ property: "og:image", content: "http://localhost:4321/og-audit.png" }));
	});
});

describe("audit L4: noindex by template and EmDash's sitemap", () => {
	it("says next to the switch and on the Overview that the sitemap still lists the entries", async () => {
		const h = harness(MODULES, { ...posts, core: null });
		expect(JSON.stringify((await h.page("/titles")).blocks)).toContain("EmDash's sitemap still lists them");
		await h.submit("/titles", "meta:collection/posts", { title: "", description: "", noindex: true, nofollow: false });
		await h.press("/overview", "audit:scan");
		expect(JSON.stringify((await h.page("/overview")).blocks)).toContain("Posts: hidden from search engines by a template, but EmDash's sitemap still lists these entries.");
	});
});
