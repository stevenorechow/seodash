/** An entry hidden from search engines (noindex) is not scored, in the panel, the list or the site numbers. */
import { describe, expect, it } from "vitest";
import { analyze } from "../src/core/analysis.js";
import { type AuditRow, audit } from "../src/modules/audit.js";
import { entry } from "../src/modules/entry.js";
import { meta } from "../src/modules/meta.js";
import { type FakeItem, harness, textOf, valid } from "./helpers.js";

const NOT_SCORED = "Hidden from search engines, not scored";
const base = { title: "A title", titleIsCustom: false, description: "", descriptionIsCustom: false, slug: "a", url: "https://acme.test/a", siteUrl: "https://acme.test", canonical: "https://acme.test/other", nofollow: false, hasImage: false, hasSchema: false, updatedAt: null, keywords: [], heading: "A title", outline: { text: "Short.", headings: [], links: [], images: [] } };

describe("content analysis of a hidden entry", () => {
	it("gives no score and counts no check as a problem", () => {
		const shown = analyze({ ...base, noIndex: false });
		expect(shown.score).toBeTypeOf("number");
		expect(shown.checks.some((check) => check.severity === "high")).toBe(true);

		const hidden = analyze({ ...base, noIndex: true });
		expect(hidden.score).toBeNull();
		expect(hidden.checks.map((check) => check.id)).toEqual(shown.checks.map((check) => check.id));
		expect(hidden.checks.filter((check) => !["good", "info"].includes(check.severity))).toEqual([]);
		expect(hidden.checks.find((check) => check.id === "robots")).toMatchObject({ severity: "info" });
	});

	it("takes no points off for being hidden", () => {
		const good = { ...base, titleIsCustom: true, description: "A description.", descriptionIsCustom: true, canonical: null, hasImage: true, hasSchema: true };
		const robots = (noIndex: boolean) => analyze({ ...good, noIndex }).checks.find((check) => check.id === "robots")!.severity;
		expect(robots(false)).toBe("good");
		expect(robots(true)).toBe("info");
	});
});

describe("a hidden entry on the site", () => {
	const body = [{ _type: "block", style: "normal", children: [{ _type: "span", text: "Short." }] }];
	const item = (id: string, noIndex: boolean): FakeItem => ({ id, slug: id, data: { title: `Entry ${id}`, content: body }, seo: { title: null, description: null, image: null, canonical: null, noIndex } });
	const site = () => harness([meta, entry, audit], { collections: [{ slug: "posts", label: "Posts" }], content: { posts: [item("shown", false), item("hidden", true)] } });
	const scan = async (h: ReturnType<typeof site>) => {
		for (let run = 0; run < 5; run++) await h.built.hooks.cron({ name: "audit-scan" }, h.ctx);
	};

	it("has no fix or improve status in the audit", async () => {
		const h = site();
		await scan(h);
		const row = (id: string) => h.ctx.collection("audit").data.get(`posts:${id}`) as AuditRow;
		expect(row("shown").high + row("shown").medium).toBeGreaterThan(0);
		expect(row("hidden")).toMatchObject({ noIndex: true, high: 0, medium: 0, low: 0, issues: [] });
	});

	it("is listed as not scored, after the scored entries", async () => {
		const h = site();
		await scan(h);
		const page = await h.page("/content");
		valid(page);
		const table = page.blocks.find((block: { type: string }) => block.type === "table") as unknown as { rows: Array<Record<string, unknown>> };
		expect(table.rows).toHaveLength(2);
		expect(table.rows[0]!.score).toBeTypeOf("number");
		expect(table.rows[1]!.score).not.toBeTypeOf("number");
		expect(table.rows[1]!.issues).toBe(NOT_SCORED);
		const fix = await h.submit("/content", "audit:filter", { collection: "all", show: "fix" });
		expect(textOf(fix)).not.toContain("Entry hidden");
	});

	it("shows no score in the panel and its checks as notes", async () => {
		const h = site();
		const shown = await h.panel("posts", "shown");
		expect(JSON.stringify(shown)).toContain('"meter"');
		const hidden = await h.panel("posts", "hidden");
		valid(hidden);
		expect(JSON.stringify(hidden)).not.toContain('"meter"');
		expect(textOf(hidden)).toContain(NOT_SCORED);
		const statuses = [...JSON.stringify(hidden).matchAll(/"status":"([^"]+)"/g)].map((match) => match[1]);
		expect(statuses.length).toBeGreaterThan(0);
		expect(statuses.filter((status) => status !== "Good" && status !== "Note")).toEqual([]);
	});
});
