import { afterEach, describe, expect, it } from "vitest";

import { createPluginTestHost, type PluginTestHost } from "@emdash-cms/plugin-test";

let host: PluginTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

type Response = { blocks: Array<{ type: string; block_id?: string; description?: string; panels?: Array<{ label: string }> }>; toast?: unknown };
/** The outcome of an action: a banner at the top of the response (the shell never returns a toast). */
function notice(response: Response): { type: string; message: string } | undefined {
	expect(response.toast).toBeUndefined();
	const banner = response.blocks.find((block) => block.type === "banner" && block.block_id?.startsWith("notice-"));
	return banner ? { type: banner.block_id!.slice(7), message: String(banner.description) } : undefined;
}

describe("SEOdash in the sandbox", () => {
	it("serves the IndexNow key file as a download", async () => {
		host = await createPluginTestHost();
		await host.invokeRoute("admin", { type: "page_load", page: "/settings" });
		const reply = (await host.invokeRoute("indexnow-key", undefined, { method: "GET" } as never)) as { status: number; headers: Array<[string, string]>; body: { value: string } };
		expect(reply.status).toBe(200);
		expect(reply.body.value).toMatch(/^[0-9a-f]{32}$/);
		expect(Object.fromEntries(reply.headers)).toEqual({ "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="${reply.body.value}.txt"` });
	});

	it("renders every admin page", async () => {
		host = await createPluginTestHost();
		for (const page of ["/overview", "/content", "/titles", "/social", "/schema", "/links", "/reports", "/settings"]) {
			const response = (await host.invokeRoute("admin", { type: "page_load", page })) as Response;
			expect(response.blocks.length, page).toBeGreaterThan(0);
			expect(JSON.stringify(response), page).not.toContain("could not be loaded");
		}
	});

	it("saves settings through the sandbox bridge and leaves trusted-only features out", async () => {
		host = await createPluginTestHost();
		const saved = (await host.invokeRoute("admin", { type: "form_submit", action_id: "meta:home", page: "/titles", values: { homeTitle: "Welcome", homeDescription: "" } })) as Response;
		expect(notice(saved)).toMatchObject({ type: "success" });
		expect(JSON.stringify(await host.invokeRoute("admin", { type: "page_load", page: "/titles" }))).toContain("Welcome");
		const settings = (await host.invokeRoute("admin", { type: "page_load", page: "/settings" })) as Response;
		const labels = settings.blocks.find((block) => block.type === "tab")?.panels?.map((panel) => panel.label) ?? [];
		expect(labels).not.toContain("Tracking");
		expect(labels).toContain("Verification");
		// EmDash's site settings cannot be read from the sandbox, so the few values needed are asked for.
		expect(JSON.stringify(settings)).toContain("Site details");
	});

	it("does not ask to edit content, which the sandbox build never does", async () => {
		host = await createPluginTestHost();
		expect(host.manifest.capabilities).toContain("content:read");
		expect(host.manifest.capabilities).not.toContain("content:write");
	});

	it("switches a feature off and on again", async () => {
		host = await createPluginTestHost();
		const off = (await host.invokeRoute("admin", { type: "form_submit", action_id: "features:save", page: "/settings", values: { schema: false } })) as Response;
		expect(notice(off)).toMatchObject({ type: "success" });
		const page = JSON.stringify(await host.invokeRoute("admin", { type: "page_load", page: "/schema" }));
		expect(page).toContain("Structured data is off");
		const on = (await host.invokeRoute("admin", { type: "block_action", action_id: "features:on", page: "/schema", value: "schema" })) as Response;
		expect(notice(on)).toMatchObject({ type: "success" });
		expect(JSON.stringify(on)).not.toContain("Structured data is off");
	});
});
