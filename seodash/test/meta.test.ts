import { describe, expect, it } from "vitest";
import { robotsContent, twitterHandle } from "../src/core/head.js";
import { entry } from "../src/modules/entry.js";
import { meta } from "../src/modules/meta.js";
import { harness, textOf, valid } from "./helpers.js";

const post = { id: "p1", slug: "hello-world", data: { title: "Hello world", excerpt: "A short summary.", content: [{ _type: "block", style: "normal", children: [{ _type: "span", text: "Body text here." }] }] } };
const site = () => harness([meta, entry], { collections: [{ slug: "posts", label: "Posts" }, { slug: "notes", label: "Notes", hasSeo: false }], content: { posts: [structuredClone(post)], notes: [{ id: "n1", data: { title: "A note" } }] } });
const article = { url: "https://acme.test/posts/hello-world", path: "/posts/hello-world", pageType: "article", title: "Hello world", description: "A short summary.", canonical: "https://acme.test/posts/hello-world", content: { collection: "posts", id: "p1", slug: "hello-world" } };

describe("head output", () => {
	it("adds nothing until something is configured", async () => {
		const h = site();
		expect(await h.head(article)).toBeNull();
		expect(await h.head({})).toBeNull();
	});

	it("applies a collection template only where the entry has no SEO value", async () => {
		const h = site();
		await h.submit("/titles", "meta:collection/posts", { title: "%%post_title%% %%sep%% %%sitetitle%%", description: "Read: %%post_excerpt%%", noindex: false, nofollow: false });
		const tags = (await h.head(article)) ?? [];
		expect(tags).toContainEqual({ kind: "property", property: "og:title", content: "Hello world | Acme" });
		expect(tags).toContainEqual({ kind: "meta", name: "description", content: "Read: A short summary." });
		h.ctx.items.posts![0]!.seo = { title: "Custom", description: "Mine", image: null, canonical: null, noIndex: false };
		expect(await h.head(article)).toBeNull();
	});

	it("merges robots directives into the page's own", async () => {
		const h = site();
		await h.submit("/titles", "meta:robots", { nofollow: false, noimageindex: true, nosnippet: false });
		expect(await h.head({ ...article, seo: { robots: "noindex, nofollow" } })).toContainEqual({ kind: "meta", name: "robots", content: "noindex, nofollow, noimageindex" });
		expect(robotsContent("index, follow", ["noindex"])).toBe("noindex, follow");
		expect(robotsContent("noindex", ["noindex"])).toBeNull();
	});

	it("credits the site's profiles only when asked, using EmDash's own settings", async () => {
		const h = harness([meta, entry], { core: { profiles: { twitter: "acme", facebook: "https://www.facebook.com/acme" } as never } });
		expect(await h.head(article)).toBeNull();
		await h.submit("/social", "meta:sharing", { ogEnabled: true, twitterEnabled: true, twitterCard: "summary_large_image", creditProfiles: true, fbAppId: "", fbPages: "" });
		const tags = (await h.head(article)) ?? [];
		expect(tags).toContainEqual({ kind: "meta", name: "twitter:site", content: "@acme" });
		expect(tags).toContainEqual({ kind: "property", property: "article:publisher", content: "https://www.facebook.com/acme" });
		expect(twitterHandle("https://x.com/acme")).toBe("@acme");
	});

	it("leaves Google and Bing verification to EmDash, and prints them itself in the sandbox", async () => {
		const trusted = site();
		expect(textOf(await trusted.page("/settings"))).not.toContain("Google Search Console verification code");
		const sandbox = harness([meta, entry], { core: null });
		expect(textOf(await sandbox.page("/settings"))).toContain("Google Search Console verification code");
		await sandbox.submit("/settings", "meta:site", { google: "abc123" });
		expect(await sandbox.head({})).toContainEqual({ kind: "meta", name: "google-site-verification", content: "abc123" });
	});

	it("applies entry social overrides and robots extras", async () => {
		const h = site();
		await h.panel("posts", "p1", { type: "form_submit", action_id: "entry:social", values: { ogTitle: "Share me", ogImage: "/img/share.jpg" } });
		await h.panel("posts", "p1", { type: "form_submit", action_id: "entry:robots", values: { nosnippet: true } });
		const tags = (await h.head(article)) ?? [];
		expect(tags).toContainEqual({ kind: "property", property: "og:title", content: "Share me" });
		expect(tags).toContainEqual({ kind: "property", property: "og:image", content: "https://acme.test/img/share.jpg" });
		expect(tags).toContainEqual({ kind: "meta", name: "robots", content: "nosnippet" });
	});
});

describe("admin pages", () => {
	it("renders every page as valid Block Kit", async () => {
		const h = site();
		for (const page of h.built.admin.pages) valid(await h.page(page.path));
	});

	it("ignores a template for an unknown collection", async () => {
		const h = site();
		const response = await h.submit("/titles", "meta:collection/nope", { title: "x" });
		expect(response.toast).toBeUndefined();
	});
});

describe("entry panel", () => {
	it("edits EmDash's own SEO fields in place and asks the editor to refresh", async () => {
		const h = site();
		valid(await h.panel("posts", "p1"));
		const response = await h.panel("posts", "p1", { type: "form_submit", action_id: "entry:search", values: { title: "Better title", description: "", canonical: "", noIndex: false } });
		expect(response).toMatchObject({ refresh: true, toast: { type: "success" } });
		expect(h.ctx.items.posts![0]!.seo).toMatchObject({ title: "Better title", description: null, noIndex: false });
		// SEOdash keeps no copy of those values.
		expect(h.ctx.collection("entries").data.size).toBe(0);
		valid(response);
	});

	it("writes only the fields that changed", async () => {
		const h = site();
		h.ctx.items.posts![0]!.seo = { title: "Kept", description: "Old", image: "media-1", canonical: null, noIndex: false };
		let written: unknown;
		const update = h.ctx.content!.update!.bind(h.ctx.content);
		(h.ctx.content as { update: unknown }).update = async (collection: string, id: string, data: Record<string, unknown>) => ((written = data), update(collection, id, data));
		await h.panel("posts", "p1", { type: "form_submit", action_id: "entry:search", values: { title: "Kept", description: "New", canonical: "", noIndex: false } });
		expect(written).toEqual({ seo: { description: "New" } });
		expect(h.ctx.items.posts![0]!.seo?.image).toBe("media-1");
	});

	it("explains when a collection has SEO fields switched off", async () => {
		const h = site();
		const response = await h.panel("notes", "n1");
		expect(textOf(response)).toContain("switched off for this collection");
		expect(textOf(response)).not.toContain("entry:search");
	});

	it("shows an empty state for a missing entry", async () => {
		const h = site();
		expect(textOf(await h.panel("posts", "missing"))).toContain("Save this entry");
	});
});
