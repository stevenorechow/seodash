/** Behaviour settled while reviewing the plugin on a real site. */
import { describe, expect, it } from "vitest";
import { analyze } from "../src/core/analysis.js";
import { imageUrl } from "../src/core/text.js";
import { MODULES } from "../src/modules/index.js";
import { harness, textOf, valid } from "./helpers.js";

const base = { title: "A title", titleIsCustom: true, description: "A description.", descriptionIsCustom: true, slug: "a", url: "https://acme.test/a", siteUrl: "https://acme.test", canonical: null, noIndex: false, nofollow: false, hasImage: true, hasSchema: true, updatedAt: null, keywords: [], heading: "A" };
const outline = (levels: number[]) => ({ text: "Some words here.", headings: levels.map((level) => ({ level, text: "Heading" })), links: [], images: [] });
const severity = (input: Parameters<typeof analyze>[0], id: string) => analyze(input).checks.find((check) => check.id === id)?.severity;

describe("content analysis", () => {
	it("treats one H1 in the content as worth a look and several as a fault", () => {
		expect(severity({ ...base, outline: outline([2, 3]) }, "h1")).toBe("good");
		expect(severity({ ...base, outline: outline([1, 2]) }, "h1")).toBe("low");
		expect(severity({ ...base, outline: outline([1, 1]) }, "h1")).toBe("high");
	});

	it("points out a hidden entry without calling it a fault", () => {
		expect(severity({ ...base, noIndex: true, outline: outline([]) }, "robots")).toBe("info");
	});

	it("finds the address of an image from the media library", () => {
		expect(imageUrl({ id: "m1", provider: "local", meta: { storageKey: "abc.jpg" } })).toBe("/_emdash/api/media/file/abc.jpg");
		expect(imageUrl({ id: "m1", provider: "other", meta: { storageKey: "abc.jpg" } })).toBe("");
		expect(imageUrl({ url: "https://cdn.test/a.jpg", meta: { storageKey: "abc.jpg" } })).toBe("https://cdn.test/a.jpg");
	});
});

describe("site audit", () => {
	it("counts hidden entries but leaves them out of the score and the to-do counts", async () => {
		const seo = { title: null, description: null, image: null, canonical: null, noIndex: true };
		const h = harness(MODULES, {
			collections: [{ slug: "posts", label: "Posts" }],
			content: { posts: [{ id: "p1", slug: "shown", data: { title: "Shown", excerpt: "Summary." } }, { id: "p2", slug: "hidden", data: { title: "Hidden" }, seo }] },
		});
		await h.press("/overview", "audit:scan");
		const summary = (await h.ctx.kv.get<{ entries: number; needFixing: number; hidden: number; score: number }>("audit:summary"))!;
		expect(summary).toMatchObject({ entries: 2, hidden: 1 });
		const alone = harness(MODULES, { collections: [{ slug: "posts", label: "Posts" }], content: { posts: [{ id: "p1", slug: "shown", data: { title: "Shown", excerpt: "Summary." } }] } });
		await alone.press("/overview", "audit:scan");
		const single = (await alone.ctx.kv.get<{ needFixing: number; score: number }>("audit:summary"))!;
		expect(summary.score).toBe(single.score);
		expect(summary.needFixing).toBe(single.needFixing);
		expect(textOf(await h.page("/overview"))).toContain("Hidden from search engines");
	});
});

type Any = Record<string, any>;
const posts = { collections: [{ slug: "posts", label: "Posts" }], content: { posts: [{ id: "p1", slug: "hello", data: { title: "Hello" } }] } };
/** Every block, walking into tabs, accordions and columns. */
function walk(blocks: Any[], out: Any[] = []): Any[] {
	for (const block of blocks ?? []) {
		out.push(block);
		walk(block.blocks, out);
		for (const panel of block.panels ?? []) walk(panel.blocks, out);
		if (block.type === "columns") for (const column of block.columns) walk(column, out);
	}
	return out;
}
const article = { url: "https://acme.test/posts/hello", path: "/posts/hello", pageType: "article", title: "Hello", content: { collection: "posts", id: "p1", slug: "hello" } };

describe("the sandboxed entry panel and EmDash's SEO fields", () => {
	it("shows them read-only from the first paint, and refuses a save without claiming success", async () => {
		const h = harness(MODULES, { ...posts, core: null });
		let writes = 0;
		(h.ctx.content as { update: unknown }).update = async () => {
			writes++;
			throw new Error("EmDashValidationError: Unknown field 'seo' in collection 'posts'");
		};
		const first = await h.panel("posts", "p1");
		valid(first);
		expect(textOf(first)).not.toContain('"block_id":"entry:search"');
		expect(textOf(first)).not.toContain("edited here");
		expect(textOf(first)).toContain("SEO section of the editor");
		const values = { title: "New", description: "", image: "", canonical: "", noIndex: false };
		const refused = await h.panel("posts", "p1", { type: "form_submit", action_id: "entry:search", values });
		expect(refused.toast).toMatchObject({ type: "error" });
		expect(refused.refresh).toBeUndefined();
		expect(writes).toBe(0);
	});

	it("stay editable in the trusted build, where a save either succeeds or fails, never both", async () => {
		const h = harness(MODULES, posts);
		expect(textOf(await h.panel("posts", "p1"))).toContain('"block_id":"entry:search"');
		const values = { title: "New", description: "", image: "", canonical: "", noIndex: false };
		const saved = await h.panel("posts", "p1", { type: "form_submit", action_id: "entry:search", values });
		expect(saved.toast).toMatchObject({ type: "success" });
		(h.ctx.content as { update: unknown }).update = async () => {
			throw new Error("database is locked");
		};
		const failed = await h.panel("posts", "p1", { type: "form_submit", action_id: "entry:search", values: { ...values, title: "Other" } });
		expect(failed.toast).toMatchObject({ type: "error" });
		expect(failed.refresh).toBeUndefined();
	});
});

describe("structured data on a single entry", () => {
	it("is printed only while the output is switched on, and the panel says when it is off", async () => {
		const h = harness(MODULES, posts);
		const jsonld = async () => ((await h.head(article)) ?? []).filter((tag: Any) => tag.kind === "jsonld");
		await h.panel("posts", "p1", { type: "form_submit", action_id: "schema:save/new/faq", values: { questions: "Open on Sundays? | No." } });
		expect(await jsonld()).toEqual([]);
		const panel = await h.panel("posts", "p1");
		expect(textOf(panel)).toContain("Structured data is switched off");
		expect(textOf(panel)).not.toContain('"Printed"');
		await h.submit("/schema", "schema:output", { enabled: true, publisher: false, website: false, searchUrl: "", breadcrumbs: false });
		const tags = await jsonld();
		expect(tags.map((tag: Any) => tag.graph["@type"])).toEqual(["FAQPage"]);
		expect(textOf(await h.panel("posts", "p1"))).not.toContain("Structured data is switched off");
	});
});

describe("hints on settings", () => {
	it("are shown as text, because EmDash does not show a form field's description", async () => {
		for (const build of [{}, { core: null }]) {
			const h = harness(MODULES, { ...posts, ...build });
			for (const page of ["/overview", "/content", "/titles", "/social", "/schema", "/settings"]) {
				const response = await h.page(page);
				valid(response);
				for (const block of walk(response.blocks as Any[])) if (block.type === "form") for (const field of block.fields) expect(field.description, `${page} ${field.label}`).toBeUndefined();
			}
			const settings = walk((await h.page("/settings")).blocks as Any[]);
			expect(settings.some((block) => block.type === "context" && block.text.includes("This applies to entries hidden from search engines too"))).toBe(true);
		}
	});
});

describe("the Content list", () => {
	it("shows a dash, not 0, for an entry that is not scored", async () => {
		const h = harness(MODULES, { collections: [{ slug: "posts", label: "Posts" }], content: { posts: [{ id: "p1", slug: "hidden", data: { title: "Hidden" }, seo: { title: null, description: null, image: null, canonical: null, noIndex: true } }] } });
		await h.press("/overview", "audit:scan");
		const table = walk((await h.page("/content")).blocks as Any[]).find((block) => block.type === "table")!;
		expect(table.rows[0].score).toBe("—");
	});
});

describe("the audit scan", () => {
	const many = { collections: ["events", "locations", "pages", "posts", "products"].map((slug) => ({ slug, label: slug })), content: Object.fromEntries(["events", "locations", "pages", "posts", "products"].map((slug, n) => [slug, Array.from({ length: [1, 1, 3, 8, 1][n]! }, (_, i) => ({ id: `${slug}${i}`, slug: `${slug}-${i}`, data: { title: `${slug} ${i}` } }))])) };

	it("carries on each time the Overview is opened, and counts against the last scan", async () => {
		const h = harness(MODULES, { ...many, core: null });
		const done = async () => ((await h.ctx.kv.get<{ done: number }>("audit:cursor")) ?? { done: -1 }).done;
		await h.press("/overview", "audit:scan");
		const afterPress = await done();
		expect(afterPress).toBeGreaterThan(0);
		await h.page("/overview");
		const afterLoad = await done();
		expect(afterLoad === -1 || afterLoad > afterPress).toBe(true);
		for (let i = 0; i < 5 && (await done()) !== -1; i++) await h.page("/overview");
		expect(await done()).toBe(-1);
		// A second pass reports progress against the entries the first one found.
		const again = await h.press("/overview", "audit:scan");
		expect(again.toast).toBeUndefined();
		expect(textOf(again)).toMatch(/Scanning again: \d+ of 14|Last scanned/);
		expect(textOf(await h.page("/overview"))).toMatch(/Scanning again: \d+ of 14|Last scanned/);
	});
});

describe("IndexNow in the sandbox", () => {
	it("asks for a key file at the site root and cannot be switched on until it is confirmed", async () => {
		const h = harness(MODULES, { ...posts, core: null, http: [{ match: "api.indexnow.org", status: 202, body: "" }] });
		expect(h.built.extraRoutes["indexnow-key"]).toBeUndefined();
		const tab = await h.page("/settings");
		valid(tab);
		const key = (await h.ctx.settings.get<{ key: string }>("config:indexing"))!.key;
		expect(key).toMatch(/^[0-9a-f]{32}$/);
		const form = walk(tab.blocks as Any[]).find((block) => block.block_id === "indexing:settings")!;
		const file = form.fields.find((field: Any) => field.action_id === "file");
		expect(file).toMatchObject({ initial_value: `https://acme.test/${key}.txt`, condition: { field: "indexnow", eq: true } });
		expect(file.label).toContain(key);
		expect(form.fields.find((field: Any) => field.action_id === "keyFile")).toMatchObject({ type: "toggle", condition: { field: "indexnow", eq: true } });
		const refused = await h.submit("/settings", "indexing:settings", { indexnow: true, keyFile: false, google: false, onPublish: true, collections: "" });
		expect(refused.toast).toMatchObject({ type: "error" });
		expect((await h.ctx.settings.get<{ indexnow: boolean }>("config:indexing"))!.indexnow).toBe(false);
		const saved = await h.submit("/settings", "indexing:settings", { indexnow: true, keyFile: true, google: false, onPublish: true, collections: "" });
		expect(saved.toast).toMatchObject({ type: "success" });
		await h.submit("/settings", "indexing:submit", { urls: "https://acme.test/posts/hello" });
		expect(JSON.parse(String(h.ctx.requests[0]!.init!.body))).toMatchObject({ key, keyLocation: `https://acme.test/${key}.txt` });
	});

	it("shows the Google key field under its switch in the same form", async () => {
		// Where the Search Console reports are installed, the key is entered under Integrations instead.
		const h = harness(MODULES.filter((module) => module.id !== "reports"), { ...posts, core: null });
		const form = walk((await h.page("/settings")).blocks as Any[]).find((block) => block.block_id === "indexing:settings")!;
		expect(form.fields.find((field: Any) => field.action_id === "googleKey")).toMatchObject({ type: "secret_input", condition: { field: "google", eq: true } });
		expect(walk((await h.page("/settings")).blocks as Any[]).some((block) => block.block_id === "indexing:google-key")).toBe(false);
	});
});
