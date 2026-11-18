/** This build leaves out the required-property warnings to stay within the marketplace size limit. */
import { expect, it } from "vitest";
import { MODULES } from "../src/modules/index.js";
import { harness } from "./helpers.js";

it("shows no required-property warning in the free build", async () => {
	const h = harness(MODULES, { collections: [{ slug: "posts", label: "Posts" }], content: { posts: [{ id: "p1", slug: "hello", data: { title: "Hello" } }] } });
	await h.submit("/schema", "schema:output", { enabled: true, publisher: false, website: false, searchUrl: "", breadcrumbs: false });
	await h.panel("posts", "p1", { type: "form_submit", action_id: "schema:save/new/video", values: { name: "Tour", thumbnail: "", uploadDate: "" } });
	const panel = JSON.stringify((await h.panel("posts", "p1", { type: "form_submit", action_id: "schema:list" })).blocks);
	expect(panel).toContain("Video");
	expect(panel).not.toContain("lacks what Google requires");
});
