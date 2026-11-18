import { afterEach, describe, expect, it } from "vitest";

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

type Tag = { kind: string; property?: string; name?: string; content?: string; graph?: unknown };

const page = (url: string) => ({
	url,
	path: "/",
	locale: null,
	pageType: "website",
	title: "Home",
	description: null,
	canonical: null,
	image: null,
});

/** Every address the plugin printed: og:image, twitter:image, dc.source and every JSON-LD url, @id, logo and image. */
function addresses(tags: Tag[]): string[] {
	const out: string[] = [];
	const scan = (value: unknown, key: string) => {
		if (typeof value === "string" && /^(@id|url|logo|image|item|sameAs)$/.test(key)) out.push(value);
		else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) scan(v, Array.isArray(value) ? key : k);
	};
	for (const tag of tags) {
		if (tag.kind === "jsonld") scan(tag.graph, "");
		else if (/image$|dc\.source/.test(tag.property ?? tag.name ?? "")) out.push(tag.content ?? "");
	}
	return out;
}

/** Runs the built bundle in EmDash's runtime with the production Cloudflare sandbox runner. */
async function printed(siteUrl: string, requestUrl: string): Promise<string[]> {
	host = await createPluginRuntimeTestHost({ site: { url: siteUrl } });
	const admin = (action_id: string, values: Record<string, unknown>, at: string) => host!.transport.invokeRoute("admin", { type: "form_submit", action_id, values, page: at });
	await admin("meta:site", { separator: "-", defaultImage: "/default-share.png", google: "", bing: "", twitter: "", facebook: "", instagram: "", linkedin: "", youtube: "" }, "/settings");
	await admin("schema:publisher", { type: "Organization", name: "Acme Works", logo: "/logo.png" }, "/schema");
	await admin("schema:output", { enabled: true, publisher: true, website: true, searchUrl: "", breadcrumbs: false }, "/schema");
	const tags = ((await host.transport.invokeHook("page:metadata", { page: page(requestUrl) })) ?? []) as Tag[];
	const found = addresses(tags);
	expect(found.length, JSON.stringify(tags)).toBeGreaterThanOrEqual(4);
	return found;
}

describe("Site address in the sandbox", () => {
	it("with no site address, builds every address from the one the page was requested at", async () => {
		const found = await printed("", "https://shop.example/");
		expect(found.filter((url) => !url.startsWith("https://shop.example/"))).toEqual([]);
	});

	it("ignores a loopback site address when the page is served from a real host", async () => {
		const found = await printed("http://localhost:4321", "https://shop.example/");
		expect(found.filter((url) => !url.startsWith("https://shop.example/"))).toEqual([]);
	});

	it("uses the site address when one is set", async () => {
		const found = await printed("https://www.acme.example", "https://acme-staging.example/");
		expect(found.filter((url) => !url.startsWith("https://www.acme.example/"))).toEqual([]);
	});
});
