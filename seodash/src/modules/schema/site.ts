/*
 * SEOdash. Copyright (C) 2026 the SEOdash authors. Licensed under GPL-3.0-only; see LICENSE.
 */
/**
 * Site-wide structured data: the publisher (an organization or a person), the WebSite node,
 * breadcrumbs and the local business. Settings, their forms, and the nodes they produce.
 */
import type { FieldSpec, FormSpec } from "../../admin/forms.js";
import { textField, toggleField } from "../../admin/forms.js";
import { defineSection } from "../../core/settings.js";
import type { PageInput } from "../../kit.js";
import type { SiteIdentity } from "../meta.js";
import { type Values, businessNode, businessTypeField, postalAddress, reader } from "./types.js";
import { type Hours, type Node, WEEK, absoluteUrl, clock, hoursNodes, isoDay, numberOf, prune } from "./util.js";

export interface OutputSettings {
	enabled: boolean;
	publisher: boolean;
	website: boolean;
	searchUrl: string;
	breadcrumbs: boolean;
}

/** The parts default to on so that switching the output on prints a complete set; nothing prints while `enabled` is off. */
export const outputSection = defineSection<OutputSettings>("schema", { enabled: false, publisher: true, website: true, searchUrl: "", breadcrumbs: true });

export interface PublisherSettings {
	type: string;
	name: string;
	alternateName: string;
	logo: string;
	description: string;
	email: string;
	telephone: string;
	contactType: string;
	street: string;
	city: string;
	region: string;
	postalCode: string;
	country: string;
	legalName: string;
	taxId: string;
	foundingDate: string;
	employees: string;
}

export const publisherSection = defineSection<PublisherSettings>("schemaPublisher", {
	type: "Organization",
	name: "",
	alternateName: "",
	logo: "",
	description: "",
	email: "",
	telephone: "",
	contactType: "",
	street: "",
	city: "",
	region: "",
	postalCode: "",
	country: "",
	legalName: "",
	taxId: "",
	foundingDate: "",
	employees: "",
});

type DayHours = Record<string, string | boolean>;

const DAY_KEYS = WEEK.map((day) => day.toLowerCase());
const hoursDefaults = (): DayHours => {
	const out: DayHours = {};
	for (const day of DAY_KEYS) Object.assign(out, { [`${day}Open`]: false, [`${day}Opens`]: "", [`${day}Closes`]: "", [`${day}Opens2`]: "", [`${day}Closes2`]: "" });
	return out;
};

export interface LocalSettings extends Record<string, string | boolean> {
	enabled: boolean;
	everyPage: boolean;
	businessType: string;
	name: string;
	image: string;
	url: string;
	telephone: string;
	priceRange: string;
	street: string;
	city: string;
	region: string;
	postalCode: string;
	country: string;
	latitude: string;
	longitude: string;
	cuisine: string;
	menu: string;
	reservations: boolean;
}

export const localSection = defineSection<LocalSettings>("schemaLocal", {
	enabled: false,
	everyPage: false,
	businessType: "LocalBusiness",
	name: "",
	image: "",
	url: "",
	telephone: "",
	priceRange: "",
	street: "",
	city: "",
	region: "",
	postalCode: "",
	country: "",
	latitude: "",
	longitude: "",
	cuisine: "",
	menu: "",
	reservations: false,
	...hoursDefaults(),
});

// ── Forms ───────────────────────────────────────────────────────

const text = (key: string, label: string, placeholder?: string): FieldSpec => ({ kind: "text", key, label, ...(placeholder ? { placeholder } : {}) });
const ADDRESS: FieldSpec[] = [text("street", "Street address"), text("city", "City"), text("region", "State or region"), text("postalCode", "Postal code"), text("country", "Country", "Two-letter code, e.g. US")];

export const OUTPUT: FormSpec = {
	id: "schema:output",
	fields: [
		toggleField("enabled", "Print structured data", { description: "Leave off if the site's templates already print their own JSON-LD." }),
		toggleField("publisher", "Publisher", { description: "The organization or person behind the site." }),
		toggleField("website", "Website", { description: "Replaces the basic website data EmDash prints." }),
		textField("searchUrl", "Site search URL", { placeholder: "https://example.com/search?q={search_term_string}", when: { field: "website", eq: true } }),
		toggleField("breadcrumbs", "Breadcrumbs", { description: "Uses the trail each page template supplies; pages without one get none." }),
	],
};

export const publisherForm = (siteName: string): FormSpec => ({
	id: "schema:publisher",
	fields: [
		{
			kind: "select",
			key: "type",
			label: "The site represents",
			options: [
				{ label: "An organization", value: "Organization" },
				{ label: "A person", value: "Person" },
			],
		},
		text("name", "Name", siteName),
		text("alternateName", "Alternate name"),
		text("logo", "Logo or photo URL", "Leave empty to use the site logo"),
		textField("description", "Description", { multiline: true }),
		text("email", "Email"),
		text("telephone", "Phone", "With country code, e.g. +1 555 010 0000"),
		{ ...text("contactType", "Contact type", "e.g. customer support"), when: { field: "type", eq: "Organization" } },
		...ADDRESS,
		{ ...text("legalName", "Legal name"), when: { field: "type", eq: "Organization" } },
		text("taxId", "Tax ID"),
		{ ...text("foundingDate", "Founding date", "YYYY-MM-DD"), when: { field: "type", eq: "Organization" } },
		{ ...text("employees", "Number of employees"), when: { field: "type", eq: "Organization" } },
	],
});

export const localForm = (siteName: string): FormSpec => ({
	id: "schema:local",
	fields: [
		toggleField("enabled", "Print the local business", { description: "Printed once structured data is switched on under Output." }),
		toggleField("everyPage", "On every page", { description: "Off: on the home page only." }),
		businessTypeField("businessType"),
		text("name", "Business name", siteName),
		text("image", "Image URL", "Leave empty to use the site logo"),
		text("url", "Website", "Leave empty to use the site address"),
		text("telephone", "Phone"),
		text("priceRange", "Price range", "e.g. $$ or 10-40 EUR"),
		...ADDRESS,
		text("latitude", "Latitude"),
		text("longitude", "Longitude"),
		text("cuisine", "Cuisine served", "Comma-separated; food businesses only"),
		text("menu", "Menu URL"),
		toggleField("reservations", "Accepts reservations"),
	],
});

export const HOURS: FormSpec = {
	id: "schema:hours",
	fields: WEEK.flatMap((day): FieldSpec[] => {
		const key = day.toLowerCase();
		const open = { field: `${key}Open`, eq: true };
		return [
			toggleField(`${key}Open`, `Open on ${day}`),
			{ ...text(`${key}Opens`, `${day} opens`, "09:00"), when: open },
			{ ...text(`${key}Closes`, `${day} closes`, "17:00"), when: open },
			{ ...text(`${key}Opens2`, `${day} reopens`, "Only for a second opening time"), when: open },
			{ ...text(`${key}Closes2`, `${day} closes again`), when: open },
		];
	}),
};

// ── Nodes ───────────────────────────────────────────────────────

export interface Site {
	name: string;
	/** Home page URL, with a trailing slash. */
	home: string;
	locale: string;
}

/** `home` is "" when the site address is unknown; ids and addresses are then left out, never relative. */
export const siteOf = (site: { name: string; url: string; locale?: string }): Site => ({ name: site.name, home: /^https?:\/\//i.test(site.url) ? `${site.url.replace(/\/+$/, "")}/` : "", locale: site.locale ?? "" });

const idOf = (site: Site, name: string) => (site.home ? `${site.home}#${name}` : undefined);
export const publisherId = (site: Site) => idOf(site, "publisher");
export const websiteId = (site: Site) => idOf(site, "website");

export function publisherNode(settings: PublisherSettings, site: Site, identity: SiteIdentity): Node | null {
	const person = settings.type === "Person";
	const logo = absoluteUrl(settings.logo || identity.logo, site.home);
	const v = reader(settings as unknown as Values, { siteUrl: site.home });
	const employees = numberOf(settings.employees);
	return prune({
		"@type": person ? "Person" : "Organization",
		"@id": publisherId(site),
		name: settings.name || site.name,
		alternateName: settings.alternateName,
		url: site.home,
		description: settings.description,
		...(person ? { image: logo } : { logo: logo ? { "@type": "ImageObject", url: logo } : undefined, legalName: settings.legalName }),
		email: settings.email,
		telephone: settings.telephone,
		address: postalAddress(v),
		vatID: settings.taxId,
		...(person
			? {}
			: {
					contactPoint: settings.contactType && (settings.telephone || settings.email) ? { "@type": "ContactPoint", contactType: settings.contactType, telephone: settings.telephone, email: settings.email } : undefined,
					foundingDate: isoDay(settings.foundingDate),
					numberOfEmployees: employees !== null && employees > 0 ? { "@type": "QuantitativeValue", value: employees } : undefined,
				}),
		sameAs: [...new Set(identity.profiles)],
	});
}

/** The search URL template; its `{search_term_string}` placeholder must survive untouched. */
function searchTemplate(value: string, site: Site): string {
	const url = value.trim();
	if (!url.includes("{search_term_string}")) return "";
	if (/^https?:\/\//i.test(url)) return url;
	return url.startsWith("/") && site.home ? `${site.home}${url.slice(1)}` : "";
}

export function websiteNode(output: OutputSettings, publisher: PublisherSettings, site: Site, identity: SiteIdentity): Node | null {
	const target = searchTemplate(output.searchUrl, site);
	return prune({
		"@type": "WebSite",
		"@id": websiteId(site),
		url: site.home,
		name: site.name,
		alternateName: publisher.alternateName,
		description: identity.tagline,
		inLanguage: site.locale,
		publisher: output.publisher && site.home ? { "@id": publisherId(site) } : undefined,
		potentialAction: target ? { "@type": "SearchAction", target: { "@type": "EntryPoint", urlTemplate: target }, "query-input": "required name=search_term_string" } : undefined,
	});
}

/** Search engines want a trail of at least two steps. */
export function breadcrumbNode(page: PageInput, site: Site): Node | null {
	const trail = (page.breadcrumbs ?? []).filter((crumb) => crumb && typeof crumb.name === "string" && crumb.name.trim());
	if (trail.length < 2) return null;
	const pageUrl = page.canonical || page.url;
	return prune({
		"@type": "BreadcrumbList",
		itemListElement: trail.map((crumb, index) => ({
			"@type": "ListItem",
			position: index + 1,
			name: crumb.name.trim(),
			item: absoluteUrl(typeof crumb.url === "string" ? crumb.url : "", site.home) || (index === trail.length - 1 ? pageUrl : ""),
		})),
	});
}

export function localHours(settings: Record<string, string | boolean>): Hours[] {
	const out: Hours[] = [];
	const time = (key: string) => clock(typeof settings[key] === "string" ? (settings[key] as string) : "");
	for (const day of WEEK) {
		const key = day.toLowerCase();
		if (settings[`${key}Open`] !== true) continue;
		for (const suffix of ["", "2"]) {
			const opens = time(`${key}Opens${suffix}`);
			const closes = time(`${key}Closes${suffix}`);
			if (opens && closes) out.push({ day, opens, closes });
		}
	}
	return out;
}

export function localNode(settings: LocalSettings, site: Site, identity: SiteIdentity): Node | null {
	const values: Values = { ...settings, name: settings.name || site.name, image: settings.image || identity.logo, hours: "" };
	const node = businessNode(reader(values, { siteUrl: site.home }), site.home);
	if (!node) return null;
	return prune({ ...node, "@id": idOf(site, "local"), openingHoursSpecification: hoursNodes(localHours(settings)) });
}

export const isHome = (page: PageInput) => page.path === "/" || page.path === "";
