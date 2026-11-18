import { describe, expect, it } from "vitest";
import { entryFacts } from "../src/kit.js";
import { entry } from "../src/modules/entry.js";
import { meta } from "../src/modules/meta.js";
import { schema } from "../src/modules/schema/index.js";
import { TYPES } from "../src/modules/schema/types.js";
import { clock, isoDate, isoDuration, numberOf, parseHours, parseJsonLd, parsePairs, parseSteps, prune } from "../src/modules/schema/util.js";
import { harness, textOf, valid } from "./helpers.js";

type Node = Record<string, any>;

const post = { id: "p1", slug: "hello-world", data: { title: "Hello world", excerpt: "A short summary.", sku: "W-100", price: 19.5 } };
const site = (core: Record<string, unknown> = {}) =>
	harness([meta, entry, schema], {
		collections: [
			{ slug: "posts", label: "Posts" },
			{ slug: "pages", label: "Pages" },
		],
		content: { posts: [structuredClone(post), { id: "p2", slug: "second", data: { title: "Second post" } }], pages: [{ id: "g1", slug: "about", data: { title: "About us" } }] },
		core: core as never,
	});
type Site = ReturnType<typeof site>;

const article = { url: "https://acme.test/posts/hello-world", path: "/posts/hello-world", pageType: "article", title: "Hello world", canonical: "https://acme.test/posts/hello-world", content: { collection: "posts", id: "p1", slug: "hello-world" } };
const second = { ...article, url: "https://acme.test/posts/second", path: "/posts/second", canonical: "https://acme.test/posts/second", content: { collection: "posts", id: "p2", slug: "second" } };
const about = { url: "https://acme.test/about", path: "/about", pageType: "website", title: "About us", canonical: null, content: { collection: "pages", id: "g1", slug: "about" } };

async function jsonld(h: Site, page: Record<string, unknown>): Promise<Array<{ id?: string; graph: Node }>> {
	const tags = (await h.head(page)) ?? [];
	return tags.filter((tag) => tag.kind === "jsonld") as Array<{ id?: string; graph: Node }>;
}
const byId = async (h: Site, page: Record<string, unknown>, id: string) => (await jsonld(h, page)).find((tag) => tag.id === id)?.graph;

const switchOn = (h: Site, patch: Record<string, unknown> = {}) => h.submit("/schema", "schema:output", { enabled: true, publisher: true, website: true, searchUrl: "", breadcrumbs: true, ...patch });

/** Output on, with the site-wide parts off, so only the entry's own structured data prints. */
const onSite = async () => {
	const h = site();
	await switchOn(h, { publisher: false, website: false, breadcrumbs: false });
	return h;
};

const press = (h: Site, actionId: string, value?: unknown, id = "p1", collection = "posts") => h.panel(collection, id, { type: "block_action", action_id: actionId, value });
const save = (h: Site, target: string, values: Record<string, unknown>, id = "p1", collection = "posts") => h.panel(collection, id, { type: "form_submit", action_id: `schema:save/${target}`, values });
const stored = (h: Site) => [...h.ctx.collection("schemas").data.entries()].map(([id, data]) => ({ id, data: data as { type: string; values: Record<string, unknown> } }));

/** Fails on an empty value anywhere, and on a node that says nothing but its type. */
function assertPruned(value: unknown, path = "$"): void {
	if (value === "" || value === null || value === undefined) throw new Error(`Empty value at ${path}`);
	if (Array.isArray(value)) {
		if (!value.length) throw new Error(`Empty list at ${path}`);
		value.forEach((item, index) => assertPruned(item, `${path}[${index}]`));
	} else if (typeof value === "object") {
		const keys = Object.keys(value as object);
		if (!keys.some((key) => key !== "@type" && key !== "@context")) throw new Error(`Node with only a type at ${path}`);
		for (const key of keys) assertPruned((value as Node)[key], `${path}.${key}`);
	}
}

describe("site-wide output", () => {
	it("prints nothing by default", async () => {
		const h = site();
		expect(await h.head(article)).toBeNull();
		expect(await h.head({})).toBeNull();
		expect(await h.head({ ...about, breadcrumbs: [{ name: "Home", url: "/" }, { name: "About us", url: "/about" }] })).toBeNull();
	});

	it("prints the publisher and replaces the host's website node on non-article pages", async () => {
		const h = site({ logo: "/logo.png", profiles: { twitter: "acme", facebook: "https://www.facebook.com/acme" } });
		await switchOn(h, { searchUrl: "/search?q={search_term_string}" });
		await h.submit("/schema", "schema:publisher", { type: "Organization", name: "", alternateName: "ACME", telephone: "+1 555 0100", contactType: "customer support", city: "Springfield", country: "US", foundingDate: "1999-04-01", employees: "12", taxId: "X1" });
		const home = await jsonld(h, {});
		expect(home.map((tag) => tag.id)).toEqual(["seodash:publisher", "primary"]);
		const publisher = home[0]!.graph;
		expect(publisher).toMatchObject({
			"@context": "https://schema.org",
			"@type": "Organization",
			"@id": "https://acme.test/#publisher",
			name: "Acme",
			alternateName: "ACME",
			url: "https://acme.test/",
			logo: { "@type": "ImageObject", url: "https://acme.test/logo.png" },
			contactPoint: { "@type": "ContactPoint", contactType: "customer support", telephone: "+1 555 0100" },
			address: { "@type": "PostalAddress", addressLocality: "Springfield", addressCountry: "US" },
			foundingDate: "1999-04-01",
			numberOfEmployees: { "@type": "QuantitativeValue", value: 12 },
			vatID: "X1",
			sameAs: ["https://www.facebook.com/acme", "https://x.com/acme"],
		});
		assertPruned(publisher);
		const website = home[1]!.graph;
		expect(website).toMatchObject({
			"@type": "WebSite",
			"@id": "https://acme.test/#website",
			name: "Acme",
			url: "https://acme.test/",
			publisher: { "@id": "https://acme.test/#publisher" },
			potentialAction: { "@type": "SearchAction", target: { urlTemplate: "https://acme.test/search?q={search_term_string}" }, "query-input": "required name=search_term_string" },
		});
		assertPruned(website);
	});

	it("leaves `primary` to the article on article pages", async () => {
		const h = site();
		await switchOn(h);
		const ids = (await jsonld(h, article)).map((tag) => tag.id);
		expect(ids).toEqual(["seodash:publisher", "seodash:website"]);
	});

	it("describes a person, and honours each toggle", async () => {
		const h = site({ logo: "/me.jpg" });
		await switchOn(h, { website: false });
		await h.submit("/schema", "schema:publisher", { type: "Person", name: "Sam Lee", legalName: "ignored", employees: "3" });
		const tags = await jsonld(h, {});
		expect(tags.map((tag) => tag.id)).toEqual(["seodash:publisher"]);
		expect(tags[0]!.graph).toEqual({ "@context": "https://schema.org", "@type": "Person", "@id": "https://acme.test/#publisher", name: "Sam Lee", url: "https://acme.test/", image: "https://acme.test/me.jpg" });
		await switchOn(h, { publisher: false });
		const website = await byId(h, {}, "primary");
		expect(website?.publisher).toBeUndefined();
		expect(website?.potentialAction).toBeUndefined();
	});

	it("prints breadcrumbs from the trail the page supplies", async () => {
		const h = site();
		await switchOn(h);
		const trail = [{ name: "Home", url: "/" }, { name: "Posts", url: "/posts" }, { name: "Hello world", url: "" }];
		const crumbs = await byId(h, { ...article, breadcrumbs: trail }, "seodash:breadcrumbs");
		expect(crumbs).toEqual({
			"@context": "https://schema.org",
			"@type": "BreadcrumbList",
			itemListElement: [
				{ "@type": "ListItem", position: 1, name: "Home", item: "https://acme.test/" },
				{ "@type": "ListItem", position: 2, name: "Posts", item: "https://acme.test/posts" },
				{ "@type": "ListItem", position: 3, name: "Hello world", item: "https://acme.test/posts/hello-world" },
			],
		});
		expect(await byId(h, { ...article, breadcrumbs: [{ name: "Home", url: "/" }] }, "seodash:breadcrumbs")).toBeUndefined();
		await switchOn(h, { breadcrumbs: false });
		expect(await byId(h, { ...article, breadcrumbs: trail }, "seodash:breadcrumbs")).toBeUndefined();
	});

	it("prints the local business with its opening hours, on the home page or everywhere", async () => {
		const h = site();
		await switchOn(h);
		await h.submit("/schema", "schema:local", { enabled: true, everyPage: false, businessType: "Restaurant", name: "", telephone: "+1 555 0100", priceRange: "$$", street: "1 Main St", city: "Springfield", country: "US", latitude: "48.8566", longitude: "2.3522", cuisine: "French, Italian", reservations: true });
		const response = await h.submit("/schema", "schema:hours", { mondayOpen: true, mondayOpens: "9", mondayCloses: "12:00", mondayOpens2: "14:00", mondayCloses2: "18.30", tuesdayOpen: true, tuesdayOpens: "09:00", tuesdayCloses: "17:00", wednesdayOpen: false, wednesdayOpens: "09:00", wednesdayCloses: "17:00", sundayOpen: true, sundayOpens: "", sundayCloses: "" });
		valid(response);
		const local = await byId(h, {}, "seodash:local");
		expect(local).toMatchObject({
			"@type": "Restaurant",
			"@id": "https://acme.test/#local",
			name: "Acme",
			url: "https://acme.test/",
			telephone: "+1 555 0100",
			priceRange: "$$",
			address: { "@type": "PostalAddress", streetAddress: "1 Main St", addressLocality: "Springfield", addressCountry: "US" },
			geo: { "@type": "GeoCoordinates", latitude: 48.8566, longitude: 2.3522 },
			servesCuisine: ["French", "Italian"],
			acceptsReservations: true,
		});
		expect(local?.openingHoursSpecification).toEqual([
			{ "@type": "OpeningHoursSpecification", dayOfWeek: "https://schema.org/Monday", opens: "09:00", closes: "12:00" },
			{ "@type": "OpeningHoursSpecification", dayOfWeek: "https://schema.org/Monday", opens: "14:00", closes: "18:30" },
			{ "@type": "OpeningHoursSpecification", dayOfWeek: "https://schema.org/Tuesday", opens: "09:00", closes: "17:00" },
		]);
		assertPruned(local);
		expect(await byId(h, about, "seodash:local")).toBeUndefined();
		await h.submit("/schema", "schema:local", { everyPage: true, businessType: "Dentist" });
		const everywhere = await byId(h, about, "seodash:local");
		expect(everywhere?.["@type"]).toBe("Dentist");
		// Cuisine only applies to places that serve food.
		expect(everywhere?.servesCuisine).toBeUndefined();
		await switchOn(h, { enabled: false });
		expect(await h.head({})).toBeNull();
	});
});

const CASES: Array<{ type: string; values: Record<string, unknown>; expect: Node }> = [
	{
		type: "article",
		values: { articleType: "NewsArticle", headline: "%%post_title%%", description: "%%post_excerpt%%", author: "Sam Lee", image: "/img/a.jpg", datePublished: "2026-01-02", dateModified: "", speakable: ".title, .summary" },
		expect: {
			"@type": "NewsArticle",
			headline: "Hello world",
			description: "A short summary.",
			image: "https://acme.test/img/a.jpg",
			datePublished: "2026-01-02",
			author: { "@type": "Person", name: "Sam Lee" },
			publisher: { "@type": "Organization", name: "Acme" },
			mainEntityOfPage: { "@type": "WebPage", "@id": "https://acme.test/posts/hello-world" },
			speakable: { "@type": "SpeakableSpecification", cssSelector: [".title", ".summary"] },
		},
	},
	{
		type: "localbusiness",
		values: { businessType: "Bakery", name: "Chez Acme", telephone: "+1 555", street: "1 Main St", city: "Springfield", country: "US", latitude: "48.85", longitude: "2.35", hours: "Mon-Fri 09:00-12:00, 14:00-18:00\nSat 10-14\nSunday closed", cuisine: "French", menu: "/menu", reservations: true },
		expect: { "@type": "Bakery", name: "Chez Acme", url: "https://acme.test/posts/hello-world", geo: { latitude: 48.85, longitude: 2.35 }, servesCuisine: "French", menu: "https://acme.test/menu", acceptsReservations: true, address: { addressLocality: "Springfield" } },
	},
	{
		type: "faq",
		values: { questions: "How long is delivery? | Two days.\n\nQ: Can I return it?\nA: Yes, within 30 days." },
		expect: {
			"@type": "FAQPage",
			mainEntity: [
				{ "@type": "Question", name: "How long is delivery?", acceptedAnswer: { "@type": "Answer", text: "Two days." } },
				{ "@type": "Question", name: "Can I return it?", acceptedAnswer: { "@type": "Answer", text: "Yes, within 30 days." } },
			],
		},
	},
	{
		type: "howto",
		values: { name: "Bake bread", description: "", totalTime: "1:30", cost: "5", currency: "usd", steps: "Mix | Stir the flour. | /img/mix.jpg\nBake for 40 minutes." },
		expect: {
			"@type": "HowTo",
			name: "Bake bread",
			totalTime: "PT1H30M",
			estimatedCost: { "@type": "MonetaryAmount", currency: "USD", value: 5 },
			step: [
				{ "@type": "HowToStep", position: 1, name: "Mix", text: "Stir the flour.", image: "https://acme.test/img/mix.jpg" },
				{ "@type": "HowToStep", position: 2, text: "Bake for 40 minutes." },
			],
		},
	},
	{
		type: "course",
		values: { name: "Intro to baking", provider: "Acme School", providerUrl: "https://school.test", price: "0", currency: "USD", offerCategory: "Free", courseMode: "Online", startDate: "2026-09-01", workload: "22 hours" },
		expect: {
			"@type": "Course",
			name: "Intro to baking",
			provider: { "@type": "Organization", name: "Acme School", sameAs: "https://school.test/" },
			offers: { "@type": "Offer", price: 0, priceCurrency: "USD", category: "Free" },
			hasCourseInstance: { "@type": "CourseInstance", courseMode: "Online", startDate: "2026-09-01", courseWorkload: "PT22H" },
		},
	},
	{
		type: "recipe",
		values: { name: "Soup", prepTime: "10", cookTime: "35", yield: "4 servings", calories: "120", ingredients: "- 2 carrots\n- 1 onion\n", instructions: "1. Chop.\n2. Boil.", video: "https://cdn.test/soup.mp4" },
		expect: {
			"@type": "Recipe",
			name: "Soup",
			prepTime: "PT10M",
			cookTime: "PT35M",
			totalTime: "PT45M",
			recipeYield: "4 servings",
			datePublished: "2026-01-02",
			nutrition: { "@type": "NutritionInformation", calories: "120 calories" },
			recipeIngredient: ["2 carrots", "1 onion"],
			recipeInstructions: [
				{ "@type": "HowToStep", text: "Chop." },
				{ "@type": "HowToStep", text: "Boil." },
			],
			video: { "@type": "VideoObject", contentUrl: "https://cdn.test/soup.mp4" },
		},
	},
	{
		type: "job",
		values: { title: "Engineer", datePosted: "2026-03-01", validThrough: "2026-04-01 18:00", employmentType: "FULL_TIME", organization: "Acme", city: "Paris", country: "FR", remote: true, applicantLocation: "France", directApply: true, salary: "50,000", salaryCurrency: "eur", salaryUnit: "YEAR", identifierName: "Acme", identifierValue: "J-1" },
		expect: {
			"@type": "JobPosting",
			title: "Engineer",
			datePosted: "2026-03-01",
			validThrough: "2026-04-01T18:00:00",
			employmentType: "FULL_TIME",
			hiringOrganization: { "@type": "Organization", name: "Acme" },
			jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: "Paris", addressCountry: "FR" } },
			jobLocationType: "TELECOMMUTE",
			applicantLocationRequirements: { "@type": "Country", name: "France" },
			directApply: true,
			baseSalary: { "@type": "MonetaryAmount", currency: "EUR", value: { "@type": "QuantitativeValue", value: 50000, unitText: "YEAR" } },
			identifier: { "@type": "PropertyValue", name: "Acme", value: "J-1" },
		},
	},
	{
		type: "video",
		values: { name: "Demo", thumbnail: "/t.jpg", uploadDate: "2026-02-03 10:00", duration: "3:45", contentUrl: "https://cdn.test/v.mp4" },
		expect: { "@type": "VideoObject", name: "Demo", thumbnailUrl: "https://acme.test/t.jpg", uploadDate: "2026-02-03T10:00:00", duration: "PT3M45S", contentUrl: "https://cdn.test/v.mp4" },
	},
	{
		type: "event",
		values: { eventType: "MusicEvent", name: "Gig", start: "2026-06-01 20:00", end: "2026-06-01 23:00", status: "EventRescheduled", previousStart: "2026-05-01 20:00", attendance: "MixedEventAttendanceMode", locationName: "Hall", locationAddress: "1 Road", locationUrl: "https://live.test/gig", price: "25", currency: "USD", availability: "InStock", performer: "The Band", organizerName: "Acme" },
		expect: {
			"@type": "MusicEvent",
			name: "Gig",
			startDate: "2026-06-01T20:00:00",
			endDate: "2026-06-01T23:00:00",
			eventStatus: "https://schema.org/EventRescheduled",
			previousStartDate: "2026-05-01T20:00:00",
			eventAttendanceMode: "https://schema.org/MixedEventAttendanceMode",
			location: [
				{ "@type": "Place", name: "Hall", address: "1 Road" },
				{ "@type": "VirtualLocation", url: "https://live.test/gig" },
			],
			offers: { "@type": "Offer", price: 25, priceCurrency: "USD", availability: "https://schema.org/InStock" },
			performer: { "@type": "Person", name: "The Band" },
			organizer: { "@type": "Organization", name: "Acme" },
		},
	},
	{
		type: "product",
		values: { name: "Widget", sku: "%%_cf_sku%%", brand: "Acme", idType: "gtin13", idValue: "0012345678905", price: "%%_cf_price%%", currency: "usd", priceValidUntil: "2026-12-31", condition: "NewCondition", availability: "InStock", ratingValue: "4.5", reviewCount: "12", positiveNotes: "Light\nCheap", energy: "A" },
		expect: {
			"@type": "Product",
			name: "Widget",
			sku: "W-100",
			brand: { "@type": "Brand", name: "Acme" },
			gtin13: "0012345678905",
			offers: { "@type": "Offer", price: 19.5, priceCurrency: "USD", priceValidUntil: "2026-12-31", itemCondition: "https://schema.org/NewCondition", availability: "https://schema.org/InStock" },
			aggregateRating: { "@type": "AggregateRating", ratingValue: 4.5, reviewCount: 12 },
			review: { "@type": "Review", positiveNotes: { "@type": "ItemList", itemListElement: [{ position: 1, name: "Light" }, { position: 2, name: "Cheap" }] } },
			hasEnergyConsumptionDetails: { hasEnergyEfficiencyCategory: "https://schema.org/EUEnergyEfficiencyCategoryA" },
		},
	},
	{
		type: "softwareapp",
		values: { name: "App", os: "macOS", category: "BusinessApplication", price: "0", currency: "USD", rating: "4", maxRating: "5", ratingCount: "8" },
		expect: { "@type": "SoftwareApplication", name: "App", operatingSystem: "macOS", applicationCategory: "BusinessApplication", offers: { price: 0, priceCurrency: "USD" }, aggregateRating: { "@type": "AggregateRating", ratingValue: 4, bestRating: 5, ratingCount: 8 } },
	},
	{
		type: "service",
		values: { name: "Plumbing", serviceType: "Plumbing", areaServed: "Paris", providerName: "Acme", mobility: "dynamic", telephone: "+33 1", city: "Paris" },
		expect: { "@type": "Service", name: "Plumbing", serviceType: "Plumbing", areaServed: "Paris", providerMobility: "dynamic", provider: { "@type": "LocalBusiness", name: "Acme", telephone: "+33 1", address: { addressLocality: "Paris" } } },
	},
	{
		type: "review",
		values: { item: "Widget", itemType: "Product", rating: "4", maxRating: "", body: "Good.", author: "Sam", negativeNotes: "Loud" },
		expect: { "@type": "Review", itemReviewed: { "@type": "Product", name: "Widget" }, reviewRating: { "@type": "Rating", ratingValue: 4, bestRating: 5 }, reviewBody: "Good.", author: { "@type": "Person", name: "Sam" }, negativeNotes: { "@type": "ItemList" } },
	},
	{
		type: "book",
		values: { name: "The book", author: "Ann", isbn: "978-0", format: "Hardcover", pages: "320", language: "en", date: "2025-05-06", abridged: "no", price: "12", currency: "EUR", product: true },
		expect: {
			"@type": ["Book", "Product"],
			name: "The book",
			author: { "@type": "Person", name: "Ann" },
			isbn: "978-0",
			bookFormat: "https://schema.org/Hardcover",
			numberOfPages: 320,
			inLanguage: "en",
			datePublished: "2025-05-06",
			abridged: false,
			offers: { "@type": "Offer", price: 12, priceCurrency: "EUR" },
		},
	},
	{
		type: "custom",
		values: { json: '<script type="application/ld+json">{"@type":"Thing","name":"%%post_title%%","description":"a </script> \\"b\\""}</script>' },
		expect: { "@context": "https://schema.org", "@type": "Thing", name: "Hello world", description: 'a </script> "b"' },
	},
];

describe("entry schemas", () => {
	it("covers every type", () => {
		expect(CASES.map((item) => item.type).sort()).toEqual(TYPES.map((type) => type.id).sort());
		expect(TYPES).toHaveLength(15);
	});

	it.each(CASES)("builds $type from a filled form", async ({ type, values, expect: expected }) => {
		const h = await onSite();
		const form = await press(h, "schema:add", type);
		valid(form);
		expect(textOf(form)).toContain(`schema:save/new/${type}`);
		const response = await save(h, `new/${type}`, values);
		valid(response);
		expect(response.toast).toMatchObject({ type: "success" });
		expect(textOf(response)).not.toContain(`schema:save/new/${type}`);
		// Printed once the output is on, with no site-wide parts of its own.
		const tags = await jsonld(h, article);
		expect(tags).toHaveLength(1);
		const node = tags[0]!.graph;
		expect(tags[0]!.id).toBe(type === "article" ? "primary" : "seodash:entry:1");
		expect(node["@context"]).toBe("https://schema.org");
		expect(node).toMatchObject(expected);
		assertPruned(node);
		expect(JSON.stringify(node)).not.toContain("%%");
		// The panel lists it, with a preview once it is opened.
		const edit = await press(h, "schema:edit", stored(h)[0]!.id);
		valid(edit);
		expect(textOf(edit)).toContain("What is printed now");
	});

	it("leaves out a schema that says nothing", async () => {
		const h = await onSite();
		await save(h, "new/faq", { questions: "just some text" });
		await save(h, "new/event", { name: "No date" });
		await save(h, "new/review", { item: "Widget", rating: "" });
		expect(await h.head(article)).toBeNull();
		const panel = await h.panel("posts", "p1");
		valid(panel);
		expect(textOf(panel)).toContain("Incomplete");
	});

	it("uses the article id only on article pages, and only once", async () => {
		const h = await onSite();
		await save(h, "new/article", { headline: "About" }, "g1", "pages");
		expect((await jsonld(h, about)).map((tag) => tag.id)).toEqual(["seodash:entry:1"]);
		await save(h, "new/faq", { questions: "Q? | A." });
		await save(h, "new/article", { headline: "One" });
		await save(h, "new/article", { articleType: "BlogPosting", headline: "Two" });
		const tags = await jsonld(h, article);
		// A second article on one entry is not printed: a page describes one article (audit D3).
		expect(tags.map((tag) => tag.id)).toEqual(["seodash:entry:1", "primary"]);
		expect(tags[1]!.graph.headline).toBe("One");
	});

	it("links an article to the site's nodes when they are printed", async () => {
		const h = await onSite();
		await switchOn(h);
		await save(h, "new/article", { headline: "%%post_title%%" });
		const tags = await jsonld(h, { ...article, articleMeta: { author: "Sam Lee", publishedTime: "2026-02-02T08:00:00Z" } });
		expect(tags.map((tag) => tag.id)).toEqual(["seodash:publisher", "seodash:website", "primary"]);
		expect(tags[2]!.graph).toMatchObject({ publisher: { "@id": "https://acme.test/#publisher" }, isPartOf: { "@id": "https://acme.test/#website" }, author: { "@type": "Person", name: "Sam Lee" }, datePublished: "2026-02-02T08:00:00Z" });
	});

	it("rejects custom JSON that is not valid, and keeps what was typed", async () => {
		const h = await onSite();
		await press(h, "schema:add", "custom");
		const bad = await save(h, "new/custom", { json: '{"@type": "Thing", name: }' });
		valid(bad);
		expect(bad.toast).toMatchObject({ type: "error" });
		expect(String((bad.toast as { message: string }).message)).toContain("not valid JSON");
		expect(stored(h)).toHaveLength(0);
		expect(textOf(bad)).toContain("name: }");
		expect((await save(h, "new/custom", { json: '"text"' })).toast).toMatchObject({ type: "error" });
		expect((await save(h, "new/custom", { json: "" })).toast).toMatchObject({ type: "error" });
		const good = await save(h, "new/custom", { json: '[{"@context":"https://schema.org","@type":"Thing","name":"A"},{"@type":"Thing","name":"B"}]' });
		expect(good.toast).toMatchObject({ type: "success" });
		const tags = await jsonld(h, article);
		expect(tags[0]!.graph).toEqual([
			{ "@context": "https://schema.org", "@type": "Thing", name: "A" },
			{ "@context": "https://schema.org", "@type": "Thing", name: "B" },
		]);
	});

	it("edits and removes a schema, and only the entry's own", async () => {
		const h = await onSite();
		await save(h, "new/faq", { questions: "Q? | A." });
		const id = stored(h)[0]!.id;
		const editing = await press(h, "schema:edit", id);
		valid(editing);
		expect(textOf(editing)).toContain(`schema:save/${id}`);
		const cancelled = await press(h, "schema:cancel");
		expect(textOf(cancelled)).not.toContain(`schema:save/${id}`);
		await save(h, id, { questions: "Q? | A.\nQ2? | A2." });
		expect(stored(h)).toHaveLength(1);
		expect((await jsonld(h, article))[0]!.graph.mainEntity).toHaveLength(2);
		// Another entry cannot touch it.
		expect((await press(h, "schema:remove", id, "p2")).toast).toMatchObject({ type: "error" });
		expect((await save(h, id, { questions: "X? | Y." }, "p2")).toast).toMatchObject({ type: "error" });
		expect(stored(h)).toHaveLength(1);
		const removed = await press(h, "schema:remove", id);
		valid(removed);
		expect(removed.toast).toMatchObject({ type: "success" });
		expect(stored(h)).toHaveLength(0);
		expect(await h.head(article)).toBeNull();
	});

	it("removes an entry's schemas when the entry is deleted", async () => {
		const h = await onSite();
		await save(h, "new/faq", { questions: "Q? | A." });
		await save(h, "new/faq", { questions: "Q? | A." }, "p2");
		await h.built.hooks.remove({ id: "p1", collection: "posts" }, h.ctx);
		expect(stored(h).map((item) => item.id.split(":").slice(0, 2).join(":"))).toEqual(["posts:p2"]);
	});
});

describe("automatic rules", () => {
	const addRule = (h: Site, type: string, values: Record<string, unknown>) => h.submit("/schema", `schema:rule-save/new/${type}`, values);
	const rules = async (h: Site) => ((await h.ctx.settings.get<{ rules: Array<{ id: string; type: string; collection: string }> }>("config:schemaRules")) ?? { rules: [] }).rules;

	it("applies a rule to every entry of its collection once the output is on", async () => {
		const h = site();
		const response = await addRule(h, "product", { ruleCollection: "posts", name: "%%post_title%%", sku: "%%_cf_sku%%", price: "%%_cf_price%%", currency: "USD" });
		valid(response);
		expect(response.toast).toMatchObject({ type: "success" });
		expect(textOf(response)).toContain("switched off");
		expect(await h.head(article)).toBeNull();
		await switchOn(h, { publisher: false, website: false });
		const first = await jsonld(h, article);
		expect(first.map((tag) => tag.id)).toEqual(["seodash:entry:1"]);
		expect(first[0]!.graph).toMatchObject({ "@type": "Product", name: "Hello world", sku: "W-100", offers: { price: 19.5, priceCurrency: "USD" } });
		assertPruned(first[0]!.graph);
		// An entry without the mapped fields still gets what can be filled in.
		const other = await jsonld(h, second);
		expect(other[0]!.graph).toMatchObject({ "@type": "Product", name: "Second post" });
		expect(other[0]!.graph.sku).toBeUndefined();
		expect(other[0]!.graph.offers).toBeUndefined();
		expect(await jsonld(h, about)).toEqual([]);
	});

	it("yields to the entry's own schema of the same type", async () => {
		const h = site();
		await switchOn(h, { publisher: false, website: false });
		await addRule(h, "article", { ruleCollection: "posts", articleType: "BlogPosting", headline: "%%post_title%%" });
		await addRule(h, "faq", { ruleCollection: "posts", questions: "What is %%post_title%%? | An entry." });
		expect((await jsonld(h, article)).map((tag) => [tag.id, tag.graph["@type"]])).toEqual([
			["primary", "BlogPosting"],
			["seodash:entry:2", "FAQPage"],
		]);
		await save(h, "new/article", { articleType: "NewsArticle", headline: "My own" });
		const tags = await jsonld(h, article);
		expect(tags.map((tag) => [tag.id, tag.graph["@type"]])).toEqual([
			["primary", "NewsArticle"],
			["seodash:entry:2", "FAQPage"],
		]);
		expect(tags[1]!.graph.mainEntity[0].name).toBe("What is Hello world?");
		expect((await jsonld(h, second))[0]!.graph).toMatchObject({ "@type": "BlogPosting", headline: "Second post" });
		const panel = await h.panel("posts", "p1");
		valid(panel);
		expect(textOf(panel)).toContain("Replaced by this entry's own");
	});

	it("adds, edits and removes rules through the page", async () => {
		const h = site();
		const adding = await h.press("/schema", "schema:rule-add", "event");
		valid(adding);
		expect(textOf(adding)).toContain("schema:rule-save/new/event");
		expect((await addRule(h, "event", { ruleCollection: "nope", name: "x" })).toast).toMatchObject({ type: "error" });
		await addRule(h, "event", { ruleCollection: "pages", name: "%%post_title%%", start: "%%_cf_starts%%" });
		const [rule] = await rules(h);
		expect(rule).toMatchObject({ type: "event", collection: "pages" });
		const editing = await h.press("/schema", "schema:rule-edit", rule!.id);
		valid(editing);
		expect(textOf(editing)).toContain(`schema:rule-save/${rule!.id}`);
		expect(textOf(editing)).toContain("%%_cf_starts%%");
		await h.submit("/schema", `schema:rule-save/${rule!.id}`, { ruleCollection: "posts" });
		expect(await rules(h)).toMatchObject([{ id: rule!.id, type: "event", collection: "posts" }]);
		const bad = await addRule(h, "custom", { ruleCollection: "posts", json: "{nope" });
		valid(bad);
		expect(bad.toast).toMatchObject({ type: "error" });
		expect(textOf(bad)).toContain("{nope");
		expect(await rules(h)).toHaveLength(1);
		const removed = await h.press("/schema", "schema:rule-remove", rule!.id);
		valid(removed);
		expect(removed.toast).toMatchObject({ type: "success" });
		expect(await rules(h)).toHaveLength(0);
	});

	it("reports whether an entry has structured data", async () => {
		const h = site();
		const facts = async (collection: string, id: string) => entryFacts(h.ctx, h.env, (await h.env.entry(h.ctx, collection, id))!);
		expect(await facts("posts", "p1")).toEqual({ hasSchema: false });
		await save(h, "new/faq", { questions: "Q? | A." });
		await addRule(h, "article", { ruleCollection: "posts", headline: "%%post_title%%" });
		// Nothing prints until the output is switched on, the entry's own structured data included.
		expect(await facts("posts", "p1")).toEqual({ hasSchema: false });
		expect(await facts("posts", "p2")).toEqual({ hasSchema: false });
		await switchOn(h);
		expect(await facts("posts", "p1")).toEqual({ hasSchema: true });
		expect(await facts("posts", "p2")).toEqual({ hasSchema: true });
		expect(await facts("pages", "g1")).toEqual({ hasSchema: false });
	});
});

describe("admin", () => {
	it("renders every tab and state as valid Block Kit", async () => {
		const h = site({ logo: "/logo.png" });
		const page = await h.page("/schema");
		valid(page);
		for (const label of ["Output", "Publisher", "Local business", "Automatic"]) expect(textOf(page)).toContain(`"label":"${label}"`);
		expect(textOf(page)).not.toMatch(new RegExp("seo" + "press|wordpress", "i"));
		for (const type of TYPES) {
			valid(await h.press("/schema", "schema:rule-add", type.id));
			valid(await press(h, "schema:add", type.id));
		}
		valid(await h.press("/schema", "schema:rule-cancel"));
		valid(await switchOn(h));
		valid(await h.submit("/schema", "schema:publisher", { type: "Person", name: "Sam" }));
		valid(await h.panel("posts", "p1"));
		valid(await press(h, "schema:cancel"));
		for (const pageInfo of h.built.admin.pages) valid(await h.page(pageInfo.path));
		// A site with no collections still renders.
		const empty = harness([meta, entry, schema], { collections: [] });
		valid(await empty.page("/schema"));
	});

	it("ignores actions that are not its own", async () => {
		const h = site();
		expect((await h.submit("/schema", "schema:nope", { a: 1 })).toast).toBeUndefined();
		expect((await press(h, "schema:nope")).toast).toBeUndefined();
		expect((await press(h, "schema:add", "nope")).toast).toMatchObject({ type: "error" });
	});
});

describe("helpers", () => {
	it("prunes empty values at every depth", () => {
		expect(prune({ "@type": "Thing", name: " A ", empty: "", list: ["", null], nested: { "@type": "Place", address: { "@type": "PostalAddress", streetAddress: "" } }, ref: { "@id": "#x" }, zero: 0, no: false })).toEqual({ "@type": "Thing", name: "A", ref: { "@id": "#x" }, zero: 0, no: false });
		expect(prune({ "@type": "Thing", name: "" })).toBeNull();
	});

	it("reads questions and answers", () => {
		expect(parsePairs("A? | B\nC? | D | E")).toEqual([
			{ question: "A?", answer: "B" },
			{ question: "C?", answer: "D | E" },
		]);
		expect(parsePairs("Question: A?\nFirst line.\nSecond line.\n\n\nB?\nAnswer: C")).toEqual([
			{ question: "A?", answer: "First line. Second line." },
			{ question: "B?", answer: "C" },
		]);
		expect(parsePairs("Only a question?\n\n | no question")).toEqual([]);
	});

	it("reads steps", () => {
		expect(parseSteps("1. Mix | Stir. | https://a.test/x.jpg\n- Just do it\n\nRest | Wait | ten minutes")).toEqual([
			{ name: "Mix", text: "Stir.", image: "https://a.test/x.jpg" },
			{ name: "", text: "Just do it", image: "" },
			{ name: "Rest", text: "Wait | ten minutes", image: "" },
		]);
	});

	it("reads opening hours", () => {
		expect(parseHours("Mon-Wed 9-17\nSat, Sun: 10am - 2pm\nFriday closed\nnonsense")).toEqual([
			{ day: "Monday", opens: "09:00", closes: "17:00" },
			{ day: "Tuesday", opens: "09:00", closes: "17:00" },
			{ day: "Wednesday", opens: "09:00", closes: "17:00" },
			{ day: "Saturday", opens: "10:00", closes: "14:00" },
			{ day: "Sunday", opens: "10:00", closes: "14:00" },
		]);
		expect(parseHours("Sat-Mon 08:30–12:00, 13:00–17:30").map((slot) => slot.day)).toEqual(["Monday", "Monday", "Saturday", "Saturday", "Sunday", "Sunday"]);
		expect([clock("9"), clock("0930"), clock("5:15 pm"), clock("25:00"), clock("soon")]).toEqual(["09:00", "09:30", "17:15", "", ""]);
	});

	it("normalizes dates, durations and numbers", () => {
		expect(isoDate("2026-5-1")).toBe("2026-05-01");
		expect(isoDate("2026-05-01 19:30")).toBe("2026-05-01T19:30:00");
		expect(isoDate("2026-05-01T19:30:00+0200")).toBe("2026-05-01T19:30:00+02:00");
		expect(isoDate("2026-01-15T08:00:00.000Z")).toBe("2026-01-15T08:00:00Z");
		expect(isoDate("next week")).toBe("");
		expect(isoDate("2026-13-01")).toBe("");
		expect(isoDuration("90")).toBe("PT1H30M");
		expect(isoDuration("90", "seconds")).toBe("PT1M30S");
		expect(isoDuration("1:02:03")).toBe("PT1H2M3S");
		expect(isoDuration("1h 30 min")).toBe("PT1H30M");
		expect(isoDuration("pt20m")).toBe("PT20M");
		expect(isoDuration("a while")).toBe("");
		expect([numberOf("1,299.50"), numberOf("4,5"), numberOf("$12"), numberOf("50,000"), numberOf("free")]).toEqual([1299.5, 4.5, 12, 50000, null]);
	});

	it("reads pasted JSON-LD", () => {
		expect(parseJsonLd('{"@type":"Thing"}')).toEqual({ nodes: [{ "@type": "Thing" }] });
		expect(parseJsonLd("[1]")).toHaveProperty("error");
		expect(parseJsonLd("{")).toHaveProperty("error");
	});
});
