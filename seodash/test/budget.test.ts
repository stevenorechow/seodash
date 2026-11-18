/**
 * EmDash's sandbox allows about 30 host calls (subrequests) per invocation, and each read or write
 * through the plugin context is one. These tests hold every page, hook and scan batch under that.
 */
import { describe, expect, it } from "vitest";
import { MODULES } from "../src/modules/index.js";
import { countCalls, harness } from "./helpers.js";

const LIMIT = 30;
const body = (text: string) => [{ _type: "block", children: [{ _type: "span", text }] }];
const entries = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}`, slug: `${prefix}-${index}`, data: { title: `${prefix} ${index}`, excerpt: "A summary.", content: body("Hello world.") } }));

function site() {
	// A sandboxed install (no access to EmDash's own settings) with several collections, some of them not pages.
	const h = harness(MODULES, {
		core: null,
		collections: [
			{ slug: "pages", label: "Pages" },
			{ slug: "posts", label: "Posts" },
			{ slug: "lots", label: "Lots" },
			{ slug: "faqs", label: "FAQs", routable: false },
			{ slug: "quotes", label: "Quotes", routable: false },
		],
		content: { pages: entries("page", 12), posts: entries("post", 57), lots: entries("lot", 3), faqs: entries("faq", 30), quotes: entries("quote", 30) },
	});
	return { h, calls: countCalls(h.ctx) };
}

describe("host calls per invocation", () => {
	it("stays under the sandbox limit on every admin page, the entry panel and the hooks", async () => {
		const { h, calls } = site();
		await h.submit("/schema", "schema:output", { enabled: true, publisher: true, website: true, breadcrumbs: true, searchUrl: "" });
		await h.submit("/settings", "checks:settings", { requireDescription: true, requireAlt: true, collections: "" });
		calls();
		const seen: Record<string, number> = {};
		for (const page of h.built.admin.pages) {
			await h.page(page.path);
			seen[page.path] = calls();
		}
		await h.panel("posts", "post0");
		seen.panel = calls();
		await h.panel("posts", "post0", { type: "form_submit", action_id: "entry:search", values: { title: "A title", description: "A description", image: "", canonical: "", noIndex: false } });
		seen["panel save"] = calls();
		await h.head({ content: { collection: "posts", id: "post0" }, pageType: "article" });
		seen.head = calls();
		const event = { collection: "posts", content: { id: "post0" } };
		for (const hook of ["save", "publish", "unpublish", "beforePublish"] as const) {
			await h.built.hooks[hook](event, h.ctx);
			seen[hook] = calls();
		}
		for (const [what, count] of Object.entries(seen)) expect(count, what).toBeLessThan(LIMIT - 5);
		// A public page costs a visitor's time: keep it to a handful.
		expect(seen.head).toBeLessThanOrEqual(4);
	});

	it("scans the whole site in batches that each stay under the limit", async () => {
		const { h, calls } = site();
		calls();
		let most = 0;
		let runs = 0;
		for (; runs < 30; runs++) {
			await h.built.hooks.cron({ name: "audit-scan" }, h.ctx);
			most = Math.max(most, calls());
			if (!(await h.ctx.kv.get("audit:cursor"))) break;
		}
		expect(most).toBeLessThan(LIMIT);
		// 72 entries on pages of ten, two pages a run.
		expect(runs).toBeLessThanOrEqual(6);
		const rows = await h.ctx.collection("audit").query({ limit: 100 });
		expect(rows.items).toHaveLength(72);
		expect(rows.items.every((row) => !/^(faqs|quotes):/.test(row.id))).toBe(true);
		const post = rows.items.find((row) => row.id === "posts:post41")!.data as { url: string };
		expect(post.url).toBe("https://acme.test/posts/post-41");
		// The button does the same work, plus drawing the page.
		await h.press("/overview", "audit:scan");
		expect(calls()).toBeLessThan(LIMIT);
	});
});
