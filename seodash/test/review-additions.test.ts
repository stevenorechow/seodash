/**
 * The additions approved after the 2026-11-15 audit: the folded variable list and the "Custom"
 * marker on the Titles page (2.8), and the Content table's Edit column beside the entry, so it
 * stays on screen when a narrow window scrolls the table.
 */
import { describe, expect, it } from "vitest";
import { MODULES } from "../src/modules/index.js";
import { harness } from "./helpers.js";

type Any = Record<string, any>;
const site = { collections: [{ slug: "posts", label: "Posts" }, { slug: "pages", label: "Pages" }], content: { posts: [{ id: "p1", slug: "hello", data: { title: "Hello" } }] } };
function walk(blocks: Any[], out: Any[] = []): Any[] {
	for (const block of blocks ?? []) {
		out.push(block);
		walk(block.blocks, out);
		for (const panel of block.panels ?? []) walk(panel.blocks, out);
	}
	return out;
}

describe("Titles page", () => {
	it("folds the variables into a list and marks collections that have a template", async () => {
		const h = harness(MODULES, site);
		const collections = async () => walk(walk((await h.page("/titles")).blocks).find((block) => block.type === "tab")!.panels[0].blocks);
		const before = await collections();
		expect(before.filter((block) => block.type === "accordion").map((block) => block.label)).toEqual(["Posts", "Pages", "Variables"]);
		const variables = before.find((block) => block.label === "Variables")!;
		expect(variables.blocks[0].rows).toContainEqual({ name: "%%post_title%%", label: "Entry title" });
		expect(before.some((block) => block.type === "context" && /^Variables:/.test(block.text))).toBe(false);

		await h.submit("/titles", "meta:collection/pages", { title: "%%post_title%% · Docs", description: "", noindex: false, nofollow: false });
		const after = (await collections()).filter((block) => block.type === "accordion").map((block) => block.label);
		expect(after).toEqual(["Posts", "Pages · Custom", "Variables"]);
	});
});

describe("Content table", () => {
	it("puts the Edit link right after the entry", async () => {
		const h = harness(MODULES, site);
		await h.submit("/", "audit:scan", {});
		const table = walk((await h.page("/content")).blocks).find((block) => block.type === "table")!;
		expect(table.columns.slice(0, 2).map((column: Any) => column.key)).toEqual(["entry", "edit"]);
	});
});

describe("Overview on a phone", () => {
	it("shows at most three stat cards, since the host's stats row does not wrap", async () => {
		const h = harness(MODULES, site);
		await h.press("/overview", "audit:scan");
		const stats = walk((await h.page("/overview")).blocks).find((block) => block.type === "stats")!;
		expect(stats.items.length).toBeLessThanOrEqual(3);
	});
});
