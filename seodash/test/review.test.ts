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
		expect(textOf(first)).toContain("editor's SEO section");
		// Nothing is shown that the panel cannot change.
		expect(textOf(first)).not.toContain("Canonical URL");
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

	it("leave the OG image to the editor's own picker and never clear it", async () => {
		const h = harness(MODULES, { ...posts, content: { posts: [{ id: "p1", slug: "hello", data: { title: "Hello" }, seo: { title: null, description: null, image: "/media/og.jpg", canonical: null, noIndex: false } }] } });
		let written: Any = {};
		(h.ctx.content as { update: unknown }).update = async (_c: string, _id: string, data: Any) => {
			written = data;
			return {};
		};
		const panel = await h.panel("posts", "p1");
		const ids = walk(panel.blocks as Any[]).flatMap((block) => (block.fields ?? []).map((field: Any) => field.action_id));
		expect(ids).not.toContain("image");
		expect(ids).not.toContain("ogImage");
		expect(ids).not.toContain("twitterImage");
		expect(textOf(panel)).toContain("Choose the image under OG Image");
		// A stale form that still sends an empty image changes only the title.
		await h.panel("posts", "p1", { type: "form_submit", action_id: "entry:search", values: { title: "New", image: "" } });
		expect(written).toEqual({ seo: { title: "New" } });
	});

	it("still show a sharing image or X override saved before, so it can be cleared", async () => {
		const h = harness(MODULES, posts);
		await h.ctx.storage.entries!.put("posts:p1", { collection: "posts", entryId: "p1", ogImage: "/old.jpg", twitterTitle: "Old" });
		const ids = walk((await h.panel("posts", "p1")).blocks as Any[]).flatMap((block) => (block.fields ?? []).map((field: Any) => field.action_id));
		expect(ids).toEqual(expect.arrayContaining(["ogImage", "twitterTitle", "twitterDescription", "twitterImage"]));
		await h.panel("posts", "p1", { type: "form_submit", action_id: "entry:social", values: { ogTitle: "", ogDescription: "", ogImage: "", twitterTitle: "", twitterDescription: "", twitterImage: "" } });
		const after = walk((await h.panel("posts", "p1")).blocks as Any[]).flatMap((block) => (block.fields ?? []).map((field: Any) => field.action_id));
		expect(after).not.toContain("ogImage");
		expect(after).not.toContain("twitterTitle");
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
			expect(settings.some((block) => block.type === "context" && block.text.includes("hidden entries included"))).toBe(true);
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
	const ROUTE = "/_emdash/api/plugins/seodash/indexnow-key";
	const on = { indexnow: true, google: false, onPublish: true, collections: "" };
	const off = { ...on, indexnow: false };
	const config = async (h: ReturnType<typeof harness>) => (await h.ctx.settings.get<{ key: string; keyFile: boolean; served?: boolean; indexnow: boolean }>("config:indexing"))!;

	it("serves the key file at the site root with a redirect when IndexNow is switched on", async () => {
		const h = harness(MODULES, { ...posts, core: null, http: [{ match: "api.indexnow.org", status: 202, body: "" }] });
		const tab = await h.page("/settings");
		valid(tab);
		const { key } = await config(h);
		expect(key).toMatch(/^[0-9a-f]{32}$/);
		const form = walk(tab.blocks as Any[]).find((block) => block.block_id === "indexing:settings")!;
		expect(form.fields.find((field: Any) => field.action_id === "file")).toMatchObject({ initial_value: `https://acme.test/${key}.txt`, condition: { field: "indexnow", eq: true } });
		// Nothing to confirm by hand any more.
		expect(form.fields.map((field: Any) => field.action_id)).not.toContain("keyFile");
		expect(textOf(tab)).toContain("with a redirect");
		// No download step before anything is switched on.
		expect(textOf(tab)).not.toContain("Download key file");
		expect(await h.built.extraRoutes["indexnow-key"]!.handler({}, h.ctx, h.built.env)).toEqual({
			status: 200,
			body: key,
			headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="${key}.txt"` },
		});
		expect(h.ctx.rules.size).toBe(0);
		const saved = await h.submit("/settings", "indexing:settings", on);
		expect(saved.toast).toMatchObject({ type: "success" });
		expect([...h.ctx.rules.values()]).toEqual([expect.objectContaining({ source: `/${key}.txt`, destination: ROUTE, type: 301, groupName: "IndexNow" })]);
		expect(await config(h)).toMatchObject({ indexnow: true, keyFile: true, served: true });
		const served = await h.page("/settings");
		expect(textOf(served)).toContain("A redirect under Redirects serves the key file");
		// The file still comes as a download, for EmDash 1.5, which ignores the redirect.
		const link = walk(served.blocks as Any[]).flatMap((block) => block.elements ?? []).find((element: Any) => element.label === "Download key file")!;
		expect(link.target).toEqual({ kind: "external", url: `https://acme.test${ROUTE}` });
		// Saving again does not add a second rule.
		await h.submit("/settings", "indexing:settings", on);
		expect(h.ctx.rules.size).toBe(1);
		await h.submit("/settings", "indexing:submit", { urls: "https://acme.test/posts/hello" });
		expect(JSON.parse(String(h.ctx.requests[0]!.init!.body))).toMatchObject({ key, keyLocation: `https://acme.test/${key}.txt` });
	});

	it("never replaces a redirect someone else made at the key file's address", async () => {
		const h = harness(MODULES, { ...posts, core: null });
		await h.page("/settings");
		const { key } = await config(h);
		h.ctx.rules.set("mine", { id: "mine", source: `/${key}.txt`, destination: "/elsewhere", type: 302, groupName: null, rev: 1 });
		const refused = await h.submit("/settings", "indexing:settings", on);
		expect(refused.toast).toMatchObject({ type: "error" });
		expect((await config(h)).indexnow).toBe(false);
		expect([...h.ctx.rules.values()]).toEqual([expect.objectContaining({ id: "mine", destination: "/elsewhere" })]);
		// Switching off leaves it alone too.
		await h.submit("/settings", "indexing:settings", off);
		expect(h.ctx.rules.has("mine")).toBe(true);
	});

	it("removes its redirect when IndexNow, the feature or the plugin goes, and only its own", async () => {
		const h = harness(MODULES, { ...posts, core: null, redirects: [{ source: "/old", destination: "/new" }] });
		await h.page("/settings");
		await h.submit("/settings", "indexing:settings", on);
		expect(h.ctx.rules.size).toBe(2);
		await h.submit("/settings", "indexing:settings", off);
		expect([...h.ctx.rules.values()].map((rule) => rule.source)).toEqual(["/old"]);
		expect(await config(h)).toMatchObject({ indexnow: false, keyFile: false, served: false });
		// Off means off: the feature switch takes the redirect with it, and brings it back.
		await h.submit("/settings", "indexing:settings", on);
		await h.submit("/settings", "features:save", { indexing: false });
		expect(h.ctx.rules.size).toBe(1);
		await h.submit("/settings", "features:save", { indexing: true });
		expect(h.ctx.rules.size).toBe(2);
		await h.built.hooks.uninstall({ deleteData: false }, h.ctx);
		expect([...h.ctx.rules.values()].map((rule) => rule.source)).toEqual(["/old"]);
	});

	it("adds no redirect for a site that already put the key file in place by hand", async () => {
		const h = harness(MODULES, { ...posts, core: null });
		await h.ctx.settings.set("config:indexing", { indexnow: false, google: false, onPublish: true, collections: "", key: "0123456789abcdef0123456789abcdef", keyFile: true });
		const tab = await h.page("/settings");
		expect(textOf(tab)).not.toContain("Download key file");
		await h.submit("/settings", "indexing:settings", on);
		expect(h.ctx.rules.size).toBe(0);
		expect((await config(h)).indexnow).toBe(true);
	});

	it("leaves Google's Indexing API out of the free build", async () => {
		const h = harness(MODULES, { ...posts, core: null });
		const form = walk((await h.page("/settings")).blocks as Any[]).find((block) => block.block_id === "indexing:settings")!;
		expect(form.fields.map((field: Any) => field.action_id)).not.toContain("google");
		expect(form.fields.map((field: Any) => field.action_id)).not.toContain("googleKey");
		// Nor does the build ask for Google's hosts or a key.
		expect(h.built.allowedHosts).toEqual(["api.indexnow.org"]);
		expect(JSON.stringify(h.built)).not.toContain("googleapis");
	});

	it("does nothing for a site that had only Google switched on before 1.0.3", async () => {
		const h = harness(MODULES, { ...posts, core: null, http: [{ match: "", status: 200, body: "" }] });
		await h.ctx.settings.set("config:indexing", { indexnow: false, google: true, onPublish: true, collections: "", key: "", keyFile: false });
		valid(await h.page("/settings"));
		await h.built.hooks.publish({ collection: "posts", content: { id: "p1" } }, h.ctx);
		expect(h.ctx.requests).toEqual([]);
		const sent = await h.submit("/settings", "indexing:submit", { urls: "https://acme.test/posts/hello" });
		expect(sent.toast).toMatchObject({ type: "error" });
		expect(h.ctx.requests).toEqual([]);
	});
});

describe("image fields", () => {
	const field = (response: unknown, form: string, key: string) => walk((response as { blocks: Any[] }).blocks).find((block) => block.block_id === form)!.fields.find((element: Any) => element.action_id === key);

	// Plugins only get sign-in addresses for media library items, which crawlers cannot open, so the
	// public address is pasted from the media library.
	it("take the public address copied from the media library, with a link to it", async () => {
		const h = harness(MODULES, { ...posts, core: null });
		for (const [page, form, key] of [["/schema", "schema:publisher", "logo"], ["/schema", "schema:local", "image"], ["/settings", "meta:site", "defaultImage"]] as const) {
			const response = await h.page(page);
			valid(response);
			expect(field(response, form, key), key).toMatchObject({ type: "text_input", placeholder: "Paste the address from Media (Copy URL)" });
			const link = walk((response as { blocks: Any[] }).blocks).flatMap((block) => block.elements ?? []).find((element: Any) => element.label === "Open media library");
			expect(link?.target).toEqual({ kind: "external", url: "https://acme.test/_emdash/admin/media" });
		}
		await h.submit("/schema", "schema:publisher", { type: "Organization", name: "Acme", logo: "https://acme.test/_emdash/api/media/file/logo.png" });
		expect(field(await h.page("/schema"), "schema:publisher", "logo").initial_value).toBe("https://acme.test/_emdash/api/media/file/logo.png");
	});

	it("ask for no media access, and only the sandbox asks to add redirects", () => {
		const sandboxed = harness(MODULES, { ...posts, core: null });
		const trusted = harness(MODULES, posts);
		expect(sandboxed.built.capabilities).toContain("redirects:write");
		expect(trusted.built.capabilities).not.toContain("redirects:write");
		for (const h of [sandboxed, trusted]) expect(h.built.capabilities.filter((capability: string) => capability.startsWith("media:"))).toEqual([]);
	});
});

describe("a site without collections", () => {
	it("still renders every settings form", async () => {
		const h = harness(MODULES, { collections: [], content: {}, core: null });
		for (const page of ["/overview", "/content", "/titles", "/social", "/schema", "/settings"]) valid(await h.page(page));
	});
});
