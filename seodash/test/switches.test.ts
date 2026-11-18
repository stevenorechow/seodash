import { describe, expect, it } from "vitest";
import { MODULES } from "../src/modules/index.js";
import { harness, textOf, valid } from "./helpers.js";

const site = () => harness(MODULES, { features: "default", collections: [{ slug: "posts", label: "Posts" }], content: { posts: [{ id: "p1", slug: "hello", data: { title: "Hello" } }] } });

type Tabs = { panels: Array<{ label: string; blocks: unknown[] }>; default_tab?: number };
const tabsOf = (response: { blocks: Array<{ type: string }> }) => response.blocks.find((block) => block.type === "tab") as unknown as Tabs;
const toggles = (response: { blocks: Array<{ type: string }> }) => {
	const form = (tabsOf(response).panels[0]!.blocks as Array<{ type: string; fields?: Array<{ action_id: string; initial_value: boolean }> }>).find((block) => block.type === "form");
	return Object.fromEntries((form?.fields ?? []).map((field) => [field.action_id, field.initial_value]));
};

describe("feature switches", () => {
	it("lists every feature, all on for a new install", async () => {
		const h = site();
		const page = await h.page("/settings");
		valid(page);
		expect(tabsOf(page).panels[0]!.label).toBe("Features");
		expect(toggles(page)).toEqual({ meta: true, schema: true, audit: true, indexing: true, checks: true });
	});

	it("ignores the actions of a switched-off feature", async () => {
		const h = site();
		await h.submit("/settings", "features:save", { audit: false });
		await h.press("/overview", "audit:scan");
		expect(h.ctx.collection("audit").data.size).toBe(0);
		await h.submit("/settings", "features:save", { audit: true });
		await h.press("/overview", "audit:scan");
		expect(h.ctx.collection("audit").data.size).toBeGreaterThan(0);
	});

	it("goes quiet when switched off: no tags, tabs, panel sections, widget, rules or scheduled work", async () => {
		const h = site();
		await h.submit("/titles", "meta:robots", { nofollow: true });
		await h.submit("/settings", "checks:settings", { requireDescription: true, requireAlt: false, collections: "" });
		const page = { pageType: "article", title: "Hello", content: { collection: "posts", id: "p1", slug: "hello" } };
		const publish = () => h.built.hooks.beforePublish({ collection: "posts", content: { id: "p1", data: { title: "Hello" } } }, h.ctx);
		expect(textOf(await h.head(page))).toContain("nofollow");
		expect(await publish()).toMatchObject({ cancel: true });
		const saved = await h.submit("/settings", "features:save", { meta: false, schema: false, audit: false, checks: false });
		expect(saved.toast).toMatchObject({ type: "success" });
		expect(await h.head(page)).toBeNull();
		expect(await publish()).toBeUndefined();
		const schema = await h.page("/schema");
		valid(schema);
		expect(textOf(schema)).toContain("Structured data is off");
		expect(textOf(schema)).toContain("features:on");
		const panel = textOf(await h.panel("posts", "p1"));
		expect(panel).not.toContain("Social sharing");
		expect(panel).not.toContain('"label":"Structured data"');
		expect(panel).toContain("SEO score");
		expect(textOf(await h.built.routes.admin({ type: "page_load", page: "widget:health" }, h.ctx))).toContain("switched off");
		expect(tabsOf(await h.page("/settings")).panels.map((tab) => tab.label)).not.toContain("Publishing");
		await h.built.hooks.cron({ name: "audit-scan" }, h.ctx);
		expect(h.ctx.collection("audit").data.size).toBe(0);
		// Settings are kept, so switching back on restores the output.
		expect((await h.press("/schema", "features:on", "schema")).toast).toMatchObject({ type: "success" });
		await h.submit("/settings", "features:save", { meta: true });
		expect(textOf(await h.head(page))).toContain("nofollow");
		expect(textOf(await h.page("/schema"))).not.toContain("Structured data is off");
		await h.submit("/settings", "features:save", { audit: true });
		await h.built.hooks.cron({ name: "audit-scan" }, h.ctx);
		expect(h.ctx.collection("audit").data.size).toBe(1);
	});
});

describe("collections that are not pages", () => {
	it("are left out of templates, rules, the scan and the entry panel", async () => {
		const h = harness(MODULES, {
			collections: [
				{ slug: "posts", label: "Posts" },
				{ slug: "quotes", label: "Customer quotes", routable: false },
			],
			content: { posts: [{ id: "p1", slug: "hello", data: { title: "Hello" } }], quotes: [{ id: "q1", slug: "q", data: { title: "Great" } }] },
		});
		expect(textOf(await h.page("/titles"))).not.toContain("Customer quotes");
		expect(textOf(await h.page("/schema"))).not.toContain("Customer quotes");
		const panel = await h.panel("quotes", "q1");
		valid(panel);
		expect(textOf(panel)).toContain("No page of its own");
		expect(textOf(panel)).not.toContain("Search title");
		await h.press("/overview", "audit:scan");
		expect(textOf(await h.page("/content"))).not.toContain("Great");
	});
});

describe("uninstall", () => {
	it("cancels the plugin's scheduled jobs, so none is left behind in EmDash", async () => {
		const h = site();
		await h.built.hooks.activate({}, h.ctx);
		expect(h.ctx.scheduled.size).toBeGreaterThan(0);
		await h.built.hooks.uninstall({ deleteData: false }, h.ctx);
		expect(h.ctx.scheduled.size).toBe(0);
	});
});

describe("the entry panel", () => {
	// The panel route is open to anyone who may edit the entry (an Author). Admin actions must not be reachable through it.
	const settings = (h: ReturnType<typeof site>) => JSON.stringify([...(h.ctx.settings as unknown as { data: Map<string, unknown> }).data.entries()]);

	it("ignores admin actions sent through it", async () => {
		const h = site();
		await h.panel("posts", "p1");
		const before = settings(h);
		const attempts: Array<[string, Record<string, unknown>]> = [
			["features:save", { meta: false, schema: false, audit: false, indexing: false, checks: false }],
			["tools:import", { json: JSON.stringify({ "config:advanced": { pinterest: "attacker" } }) }],
			["meta:verification", { pinterest: "attacker", yandex: "", baidu: "" }],
			["meta:robots", { nofollow: true, noimageindex: true, nosnippet: true }],
			["checks:settings", { requireDescription: false, requireAlt: false, collections: "" }],
			["indexing:settings", { indexnow: true, google: false, onPublish: true, collections: "" }],
			["schema:output", { enabled: true, publisher: true, website: true, searchUrl: "", breadcrumbs: true }],
		];
		for (const [action_id, values] of attempts) {
			const response = await h.panel("posts", "p1", { type: "form_submit", action_id, values });
			expect(response.toast, action_id).toBeUndefined();
		}
		for (const action_id of ["features:on", "audit:scan"]) await h.panel("posts", "p1", { type: "block_action", action_id, value: "indexing" });
		expect(settings(h)).toBe(before);
	});

	it("still saves what belongs to the entry", async () => {
		const h = site();
		const response = await h.panel("posts", "p1", { type: "form_submit", action_id: "entry:social", values: { ogTitle: "Shared", ogDescription: "", ogImage: "", twitterTitle: "", twitterDescription: "", twitterImage: "" } });
		expect(response.toast?.type).toBe("success");
	});
});

describe("panel actions", () => {
	it("every control the panel shows is one its module declares for the panel", async () => {
		const h = harness(MODULES, { collections: [{ slug: "posts", label: "Posts" }], content: { posts: [{ id: "p1", slug: "hello", status: "published", data: { title: "Hello" } }] } });
		const ids: string[] = [];
		const walk = (value: unknown): void => {
			if (Array.isArray(value)) return value.forEach(walk);
			if (!value || typeof value !== "object") return;
			for (const [key, inner] of Object.entries(value)) {
				if ((key === "action_id" || key === "page_action_id" || key === "block_id") && typeof inner === "string" && inner.includes(":")) ids.push(inner);
				else walk(inner);
			}
		};
		walk(await h.panel("posts", "p1"));
		expect(ids.length).toBeGreaterThan(0);
		for (const id of ids) {
			const [module, action] = [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1).split("/")[0]!];
			const owner = MODULES.find((candidate) => candidate.id === module);
			expect(owner?.panelActions ?? [], id).toContain(action);
		}
	});
});
