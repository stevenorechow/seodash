import { describe, expect, it } from "vitest";
import { checks } from "../src/modules/checks.js";
import { entry } from "../src/modules/entry.js";
import { features } from "../src/modules/features.js";
import { indexingModule } from "../src/modules/indexing.js";

const indexing = indexingModule();
import { meta } from "../src/modules/meta.js";
import { exportSettings, tools } from "../src/modules/tools.js";
import { harness, textOf, valid } from "./helpers.js";

const body = (text: string, extra: unknown[] = []) => [{ _type: "block", style: "normal", children: [{ _type: "span", text }] }, ...extra];
const content = () => ({
	posts: [
		{ id: "p1", slug: "hello", data: { title: "Hello world", excerpt: "A short summary.", content: body("Body text.") }, publishedAt: new Date(Date.now() - 3600 * 1000).toISOString() },
		{ id: "p2", slug: "old", data: { title: "Old news", content: body("Old.") }, publishedAt: "2020-01-01T00:00:00Z" },
		{ id: "p3", slug: "hidden", data: { title: "Hidden" }, seo: { title: null, description: null, image: null, canonical: null, noIndex: true }, publishedAt: new Date().toISOString() },
		{ id: "p4", slug: "draft", status: "draft", data: { title: "Draft" } },
	],
});
const all = [features, meta, entry, indexing, checks, tools];
const site = (http: Parameters<typeof harness>[1] extends infer O ? (O extends { http?: infer H } ? H : never) : never = []) => harness(all, { collections: [{ slug: "posts", label: "Posts" }], content: content(), http });

describe("every page", () => {
	it("renders as valid Block Kit before and after configuration", async () => {
		const h = site();
		for (const page of h.built.admin.pages) valid(await h.page(page.path));
		await h.submit("/settings", "indexing:settings", { indexnow: true, google: true, onPublish: true, collections: "" });
		for (const page of h.built.admin.pages) valid(await h.page(page.path));
		valid(await h.panel("posts", "p1"));
	});

	it("stays on the tab an action came from", async () => {
		const h = site();
		const response = await h.submit("/settings", "checks:settings", { requireDescription: true, requireAlt: false, collections: "" });
		const tabs = response.blocks.find((block) => block.type === "tab") as { panels: Array<{ label: string }>; default_tab?: number };
		expect(tabs.panels[tabs.default_tab ?? 0]!.label).toBe("Publishing");
	});
});

describe("indexing", () => {
	it("sends nothing until switched on", async () => {
		const h = site();
		await h.built.hooks.publish({ collection: "posts", content: { id: "p1" } }, h.ctx);
		expect(h.ctx.requests).toHaveLength(0);
		expect(textOf(await h.panel("posts", "p1"))).not.toContain("indexing:entry");
	});

	it("submits a published entry to IndexNow with a root key file", async () => {
		const h = site([{ match: "api.indexnow.org", status: 202, body: "" }]);
		await h.submit("/settings", "indexing:settings", { indexnow: true, google: false, onPublish: true, collections: "" });
		await h.built.hooks.publish({ collection: "posts", content: { id: "p1" } }, h.ctx);
		expect(h.ctx.requests).toHaveLength(1);
		const sent = JSON.parse(String(h.ctx.requests[0]!.init!.body));
		expect(sent).toMatchObject({ host: "acme.test", keyLocation: "https://acme.test/indexnow-key.txt", urlList: ["https://acme.test/posts/hello"] });
		expect(sent.key).toMatch(/^[0-9a-f]{32}$/);
		expect(textOf(await h.page("/settings"))).toContain("Accepted");
	});

	it("does not announce an entry hidden from search engines, and tells IndexNow when one is taken down", async () => {
		const h = site([{ match: "api.indexnow.org", status: 202, body: "" }]);
		await h.submit("/settings", "indexing:settings", { indexnow: true, google: false, onPublish: true, collections: "" });
		const hide = (noIndex: boolean) => (h.ctx.content as unknown as { update(collection: string, id: string, data: Record<string, unknown>): Promise<unknown> }).update("posts", "p1", { seo: { noIndex } });
		await hide(true);
		await h.built.hooks.publish({ collection: "posts", content: { id: "p1" } }, h.ctx);
		expect(h.ctx.requests).toHaveLength(0);
		await hide(false);
		await h.built.hooks.publish({ collection: "posts", content: { id: "p1" } }, h.ctx);
		await h.built.hooks.unpublish({ collection: "posts", content: { id: "p1" } }, h.ctx);
		expect(h.ctx.requests.map((request) => JSON.parse(String(request.init!.body)).urlList)).toEqual([["https://acme.test/posts/hello"], ["https://acme.test/posts/hello"]]);
	});

	it("only ever submits addresses of this site, and reports a refusal", async () => {
		const h = site([{ match: "api.indexnow.org", status: 403, body: "" }]);
		await h.submit("/settings", "indexing:settings", { indexnow: true, google: false, onPublish: true, collections: "" });
		const response = await h.submit("/settings", "indexing:submit", { urls: "https://evil.test/x\n/posts/hello" });
		expect(JSON.parse(String(h.ctx.requests[0]!.init!.body)).urlList).toEqual(["https://acme.test/posts/hello"]);
		expect(response.toast).toMatchObject({ type: "error" });
	});

	it("respects the collection filter", async () => {
		const h = site([{ match: "api.indexnow.org", status: 200, body: "" }]);
		await h.submit("/settings", "indexing:settings", { indexnow: true, google: false, onPublish: true, collections: ["pages"] });
		await h.built.hooks.publish({ collection: "posts", content: { id: "p1" } }, h.ctx);
		expect(h.ctx.requests).toHaveLength(0);
	});

	it("lists the site's collections to tick, keeping a value saved as text", async () => {
		const h = site();
		// The old form saved a comma-separated list typed by hand, including a collection since removed.
		await h.ctx.settings.set("config:indexing", { indexnow: false, google: false, onPublish: true, collections: "posts, gone", key: "" });
		const field = JSON.parse(textOf(await h.page("/settings"))).blocks.flatMap((block: any) => block.panels ?? []).flatMap((panel: any) => panel.blocks).find((block: any) => block.block_id === "indexing:settings").fields.find((item: any) => item.action_id === "collections");
		expect(field).toMatchObject({ type: "checkbox", initial_value: ["posts", "gone"] });
		expect(field.options.map((option: { value: string }) => option.value)).toEqual(["posts", "gone"]);
		await h.submit("/settings", "indexing:settings", { collections: ["posts"] });
		expect((await h.ctx.settings.get<{ collections: string }>("config:indexing"))!.collections).toBe("posts");
	});
});

describe("publishing checks", () => {
	it("allow everything by default, then enforce the chosen rules", async () => {
		const h = site();
		const publish = (id: string, data: Record<string, unknown>) => h.built.hooks.beforePublish({ collection: "posts", content: { id, data } }, h.ctx);
		expect(await publish("p2", { title: "Old news" })).toBeUndefined();
		await h.submit("/settings", "checks:settings", { requireDescription: true, requireAlt: true, collections: "" });
		expect(await publish("p2", { title: "Old news" })).toMatchObject({ cancel: true });
		expect(await publish("p1", { title: "Hello world", excerpt: "A short summary." })).toBeUndefined();
		expect(await publish("p1", { excerpt: "x", content: body("x", [{ _type: "image", alt: "" }]) })).toMatchObject({ cancel: true, reason: expect.stringContaining("alt text") });
	});

	it("say that the alt text rule applies to hidden entries too", async () => {
		const h = site();
		expect(textOf(await h.page("/settings"))).toContain("Alt text is checked on every image, hidden entries included.");
	});

	it("do not ask a hidden entry for a search description, but still ask it for alt text", async () => {
		const h = site();
		const publish = (id: string, data: Record<string, unknown>) => h.built.hooks.beforePublish({ collection: "posts", content: { id, data } }, h.ctx);
		await h.submit("/settings", "checks:settings", { requireDescription: true, requireAlt: true, collections: "" });
		expect(await publish("p2", { title: "Old news" })).toMatchObject({ cancel: true, reason: expect.stringContaining("description") });
		expect(await publish("p3", { title: "Hidden" })).toBeUndefined();
		expect(await publish("p3", { title: "Hidden", content: body("x", [{ _type: "image", alt: "" }]) })).toMatchObject({ cancel: true, reason: expect.stringContaining("alt text") });
	});
});

describe("tools", () => {
	it("exports settings without secrets and imports them elsewhere", async () => {
		const a = site();
		await a.submit("/titles", "meta:home", { homeTitle: "Welcome", homeDescription: "" });
		await a.ctx.settings.set("secret:ai-openai", "sk-secret");
		const exported = await exportSettings(a.ctx);
		expect(JSON.stringify(exported)).not.toContain("sk-secret");
		const b = site();
		expect((await b.submit("/settings", "tools:import", { json: JSON.stringify(exported) })).toast).toMatchObject({ type: "success" });
		expect(textOf(await b.page("/titles"))).toContain("Welcome");
		expect((await b.submit("/settings", "tools:import", { json: "{nope" })).toast).toMatchObject({ type: "error" });
	});
});
