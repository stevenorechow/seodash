/*
 * SEOdash. Copyright (C) 2026 the SEOdash authors. Licensed under GPL-3.0-only; see LICENSE.
 */
/**
 * The structured data types an editor can add to an entry or map in an automatic rule: the form
 * fields of each one and how its values become a schema.org node.
 *
 * Every field is text (or a fixed choice), so any of them can hold `%%variables%%`. Values reach
 * `build` already rendered; empty ones are dropped from the output.
 */
import type { FieldSpec } from "../../admin/forms.js";
import { type Node, CONTEXT, absoluteUrl, hoursNodes, isoDate, isoDay, isoDuration, lines, listOf, numberOf, parseHours, parseJsonLd, parsePairs, parseSteps } from "./util.js";

export type Values = Record<string, string | boolean>;

export interface BuildContext {
	siteUrl: string;
	siteName: string;
	/** Canonical URL of the page the node is printed on. */
	pageUrl: string;
	/** The publisher to attach to articles and reviews: a reference to the site's node, or a small inline one. */
	publisher: Node | null;
	/** Reference to the site's WebSite node, when it is printed. */
	website: Node | null;
	publishedAt: string;
	/** Renders the `%%variables%%` of one line of text. */
	render(template: string): string;
}

export interface SchemaType {
	id: string;
	label: string;
	/** One line shown above the form. */
	note?: string;
	fields: FieldSpec[];
	/** Values of a new schema of this type. Written with the non-empty ones only; `TYPES` holds them complete. */
	defaults: Values;
	/** The field that names the schema in lists. */
	titleField?: string;
	/** Values are passed to `build` unrendered (the type renders them itself). */
	raw?: boolean;
	/** Can replace the host's own article node. */
	article?: boolean;
	/** Null when the values do not make a meaningful node. */
	build(values: Reader, context: BuildContext): Node | Node[] | null;
	/** A message for the editor when the values cannot be saved. */
	check?(values: Values): string | null;
}

/** Typed access to a schema's values. */
export interface Reader {
	text(key: string): string;
	flag(key: string): boolean;
	url(key: string): string;
	number(key: string): number | null;
	date(key: string): string;
	day(key: string): string;
}

export function reader(values: Values, context: Pick<BuildContext, "siteUrl">): Reader {
	const text = (key: string) => {
		const value = values[key];
		return typeof value === "string" ? value.trim() : "";
	};
	return {
		text,
		flag: (key) => values[key] === true,
		url: (key) => absoluteUrl(text(key), context.siteUrl),
		number: (key) => numberOf(text(key)),
		date: (key) => isoDate(text(key)),
		day: (key) => isoDay(text(key)),
	};
}

// ── Field builders ──────────────────────────────────────────────

const text = (key: string, label: string, placeholder?: string): FieldSpec => ({ kind: "text", key, label, ...(placeholder ? { placeholder } : {}) });
const area = (key: string, label: string, placeholder?: string): FieldSpec => ({ kind: "text", key, label, multiline: true, ...(placeholder ? { placeholder } : {}) });
const flag = (key: string, label: string): FieldSpec => ({ kind: "toggle", key, label });

/** "AutoBodyShop" → "Auto body shop". */
const words = (name: string) => {
	const spaced = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
	return spaced.charAt(0) + spaced.slice(1).replace(/\b[A-Z][a-z]/g, (match) => match.toLowerCase());
};
const pick = (key: string, label: string, values: string[], labels: Record<string, string> = {}): FieldSpec => ({
	kind: "select",
	key,
	label,
	options: values.map((value) => ({ value, label: labels[value] ?? (value ? words(value) : "Not set") })),
});

const DATE = "YYYY-MM-DD";
const DATETIME = "YYYY-MM-DD HH:MM";

const ADDRESS: FieldSpec[] = [text("street", "Street address"), text("city", "City"), text("region", "State or region"), text("postalCode", "Postal code"), text("country", "Country", "Two-letter code, e.g. US")];

// ── Shared nodes ────────────────────────────────────────────────

const schemaUrl = (name: string) => (name ? `${CONTEXT}/${name}` : "");

export function postalAddress(v: Reader): Node {
	return { "@type": "PostalAddress", streetAddress: v.text("street"), addressLocality: v.text("city"), addressRegion: v.text("region"), postalCode: v.text("postalCode"), addressCountry: v.text("country") };
}

function geo(v: Reader): Node | undefined {
	const latitude = v.number("latitude");
	const longitude = v.number("longitude");
	if (latitude === null || longitude === null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined;
	return { "@type": "GeoCoordinates", latitude, longitude };
}

const person = (name: string, url = ""): Node | undefined => (name ? { "@type": "Person", name, url } : undefined);

function rating(v: Reader, valueKey: string, bestKey: string): Node | undefined {
	const value = v.number(valueKey);
	if (value === null) return undefined;
	return { "@type": "Rating", ratingValue: value, bestRating: v.number(bestKey) ?? 5 };
}

function notes(value: string): Node | undefined {
	const items = lines(value);
	if (!items.length) return undefined;
	return { "@type": "ItemList", itemListElement: items.map((name, index) => ({ "@type": "ListItem", position: index + 1, name })) };
}

function offer(v: Reader, keys: { price: string; currency: string }, extra: Node = {}): Node | undefined {
	const price = v.number(keys.price);
	if (price === null) return undefined;
	return { "@type": "Offer", price, priceCurrency: v.text(keys.currency).toUpperCase(), ...extra };
}

/** schema.org LocalBusiness and its common subtypes. */
export const BUSINESS_TYPES = [
	"LocalBusiness",
	"AnimalShelter",
	"AutomotiveBusiness",
	"AutoBodyShop",
	"AutoDealer",
	"AutoPartsStore",
	"AutoRental",
	"AutoRepair",
	"AutoWash",
	"GasStation",
	"MotorcycleDealer",
	"MotorcycleRepair",
	"ChildCare",
	"DryCleaningOrLaundry",
	"EmergencyService",
	"FireStation",
	"Hospital",
	"PoliceStation",
	"EmploymentAgency",
	"EntertainmentBusiness",
	"AmusementPark",
	"ArtGallery",
	"Casino",
	"ComedyClub",
	"MovieTheater",
	"NightClub",
	"FinancialService",
	"AccountingService",
	"AutomatedTeller",
	"BankOrCreditUnion",
	"InsuranceAgency",
	"FoodEstablishment",
	"Bakery",
	"BarOrPub",
	"Brewery",
	"CafeOrCoffeeShop",
	"FastFoodRestaurant",
	"IceCreamShop",
	"Restaurant",
	"Winery",
	"GovernmentOffice",
	"PostOffice",
	"HealthAndBeautyBusiness",
	"BeautySalon",
	"DaySpa",
	"HairSalon",
	"HealthClub",
	"NailSalon",
	"TattooParlor",
	"HomeAndConstructionBusiness",
	"Electrician",
	"GeneralContractor",
	"HVACBusiness",
	"HousePainter",
	"Locksmith",
	"MovingCompany",
	"Plumber",
	"RoofingContractor",
	"InternetCafe",
	"MedicalBusiness",
	"Dentist",
	"MedicalClinic",
	"Optician",
	"Pharmacy",
	"Physician",
	"VeterinaryCare",
	"LegalService",
	"Attorney",
	"Notary",
	"Library",
	"LodgingBusiness",
	"BedAndBreakfast",
	"Campground",
	"Hostel",
	"Hotel",
	"Motel",
	"Resort",
	"ProfessionalService",
	"RadioStation",
	"RealEstateAgent",
	"RecyclingCenter",
	"SelfStorage",
	"ShoppingCenter",
	"SportsActivityLocation",
	"BowlingAlley",
	"ExerciseGym",
	"GolfCourse",
	"PublicSwimmingPool",
	"SkiResort",
	"SportsClub",
	"StadiumOrArena",
	"TennisComplex",
	"Store",
	"BikeStore",
	"BookStore",
	"ClothingStore",
	"ComputerStore",
	"ConvenienceStore",
	"DepartmentStore",
	"ElectronicsStore",
	"Florist",
	"FurnitureStore",
	"GardenStore",
	"GroceryStore",
	"HardwareStore",
	"HobbyShop",
	"HomeGoodsStore",
	"JewelryStore",
	"LiquorStore",
	"MensClothingStore",
	"MobilePhoneStore",
	"MusicStore",
	"OfficeEquipmentStore",
	"OutletStore",
	"PawnShop",
	"PetStore",
	"ShoeStore",
	"SportingGoodsStore",
	"TireShop",
	"ToyStore",
	"WholesaleStore",
	"TelevisionStation",
	"TouristInformationCenter",
	"TravelAgency",
];

export const businessTypeField = (key: string): FieldSpec => pick(key, "Business type", BUSINESS_TYPES, { HVACBusiness: "HVAC business", LocalBusiness: "Local business (general)" });

const FOOD_TYPES = new Set(["FoodEstablishment", "Bakery", "BarOrPub", "Brewery", "CafeOrCoffeeShop", "FastFoodRestaurant", "IceCreamShop", "Restaurant", "Winery"]);

export const HOURS_HELP = "Opening hours: one line per day or range of days, e.g. “Mon-Fri 09:00-12:00, 14:00-18:00”. Leave a day out when closed.";

/**
 * A LocalBusiness node from the keys `businessType`, `name`, `image`, `url`, `telephone`,
 * `priceRange`, the address keys, `latitude`, `longitude`, `cuisine`, `menu`, `reservations` and
 * `hours`. Cuisine, menu and reservations only apply to places that serve food.
 */
export function businessNode(v: Reader, fallbackUrl = ""): Node | null {
	const name = v.text("name");
	if (!name) return null;
	const type = BUSINESS_TYPES.includes(v.text("businessType")) ? v.text("businessType") : "LocalBusiness";
	const food = FOOD_TYPES.has(type);
	const cuisine = listOf(v.text("cuisine"));
	return {
		"@type": type,
		name,
		image: v.url("image"),
		url: v.url("url") || fallbackUrl,
		telephone: v.text("telephone"),
		priceRange: v.text("priceRange"),
		address: postalAddress(v),
		geo: geo(v),
		openingHoursSpecification: hoursNodes(parseHours(v.text("hours"))),
		...(food ? { servesCuisine: cuisine.length > 1 ? cuisine : cuisine[0], menu: v.url("menu"), ...(v.flag("reservations") ? { acceptsReservations: true } : {}) } : {}),
	};
}

// ── The types (prototype: one generic builder driven by a field table) ─────────

/**
 * A row is `key|label|placeholder|out`. A key starting `*` is multiline, `?` a toggle. Placeholder
 * `@d`, `@t`, `@c` stand for the date, date-time and currency hints. `out` names the schema.org
 * property the value is written to (`=` for the key itself), with `:u` url, `:d` date, `:y` day,
 * `:s` schema.org URL, `:i` duration. A field object is passed through; `[field, out]` gives it an out.
 */
/** Defaults and rows many types share; each is spelled once so the bundle carries it once. */
const TITLE = "%%post_title%%";
const EXCERPT = "%%post_excerpt%%";
const THUMB = "%%post_thumbnail_url%%";
const AUTHOR = "%%post_author%%";
const DAY = "%%schema_post_date%%";
const DESCRIPTION = "*description|Description||=";
const IMAGE = "image|Image URL||=:u";
type Row = string | FieldSpec | [FieldSpec, string];
const HINT: Record<string, string> = { "@d": DATE, "@t": DATETIME, "@c": "e.g. USD" };
const HOW: Record<string, (v: Reader, key: string) => unknown> = {
	u: (v, key) => v.url(key),
	d: (v, key) => v.date(key),
	y: (v, key) => v.day(key),
	s: (v, key) => schemaUrl(v.text(key)),
	i: (v, key) => isoDuration(v.text(key)),
	// Only holds the property's place: the type's own builder fills it in.
	"-": () => undefined,
};

function make(id: string, label: string, schemaType: string, rows: Row[], defaults: Values, more?: ((v: Reader, b: BuildContext, name: string) => Node | null) | null, rest: Partial<SchemaType> = {}): SchemaType {
	const fields: FieldSpec[] = [];
	const outs: Array<[string, string, string]> = [];
	for (const row of rows) {
		let field: FieldSpec;
		let out = "";
		if (typeof row === "string") {
			const [mark = "", name = "", hint = "", to = ""] = row.split("|");
			const key = mark.replace(/^[*?]/, "");
			const placeholder = HINT[hint] ?? hint;
			field = mark[0] === "?" ? flag(key, name) : mark[0] === "*" ? area(key, name, placeholder) : text(key, name, placeholder);
			out = to;
		} else if (Array.isArray(row)) [field, out] = row;
		else field = row;
		fields.push(field);
		for (const each of out ? out.split(",") : []) {
			const [prop = "", how = ""] = each.split(":");
			outs.push([field.key, prop === "=" ? field.key : prop, how]);
		}
	}
	const titleField = rest.titleField ?? "name";
	return {
		id,
		label,
		titleField,
		fields,
		defaults,
		...rest,
		build(v, b) {
			const name = v.text(titleField);
			if (!name) return null;
			const extra = more ? more(v, b, name) : {};
			if (!extra) return null;
			const node: Node = { "@type": schemaType };
			for (const [key, prop, how] of outs) node[prop] = how ? HOW[how]!(v, key) : v.text(key);
			return { ...node, ...extra };
		},
	};
}

const ARTICLE_TYPES = ["Article", "NewsArticle", "BlogPosting", "TechArticle", "ScholarlyArticle", "Report", "SocialMediaPosting", "LiveBlogPosting", "AdvertiserContentArticle", "SatiricalArticle", "AnalysisNewsArticle", "AskPublicNewsArticle", "BackgroundNewsArticle", "OpinionNewsArticle", "ReportageNewsArticle", "ReviewNewsArticle"];

const article = make(
	"article",
	"Article",
	"Article",
	[
		pick("articleType", "Article type", ARTICLE_TYPES),
		"headline|Headline||=",
		DESCRIPTION,
		"author|Author name",
		"authorUrl|Author URL",
		IMAGE,
		"datePublished|Date published|@d|=:d",
		"dateModified|Date modified|@d|=:d",
		"speakable|Speakable CSS selectors|Comma-separated, e.g. .post-title, .post-summary",
		{ ...text("coverageStart", "Coverage start", DATETIME), when: { field: "articleType", eq: "LiveBlogPosting" } },
		{ ...text("coverageEnd", "Coverage end", DATETIME), when: { field: "articleType", eq: "LiveBlogPosting" } },
	],
	{ articleType: "Article", headline: TITLE, description: EXCERPT, author: AUTHOR, image: THUMB, datePublished: DAY, dateModified: "%%schema_post_modified_date%%" },
	(v, b, headline) => {
		const type = ARTICLE_TYPES.includes(v.text("articleType")) ? v.text("articleType") : "Article";
		const selectors = listOf(v.text("speakable"));
		return {
			"@type": type,
			author: person(v.text("author"), v.url("authorUrl")),
			publisher: b.publisher,
			mainEntityOfPage: b.pageUrl ? { "@type": "WebPage", "@id": b.pageUrl } : undefined,
			isPartOf: b.website,
			speakable: selectors.length ? { "@type": "SpeakableSpecification", cssSelector: selectors } : undefined,
			...(type === "LiveBlogPosting" ? { coverageStartTime: v.date("coverageStart"), coverageEndTime: v.date("coverageEnd") } : {}),
			...(type === "ReviewNewsArticle" ? { itemReviewed: { "@type": "Thing", name: headline } } : {}),
		};
	},
	{ article: true, titleField: "headline" },
);

const localBusiness: SchemaType = {
	id: "localbusiness",
	label: "Local business",
	titleField: "name",
	note: HOURS_HELP,
	fields: make(
		"",
		"",
		"",
		[
			businessTypeField("businessType"),
			"name|Business name",
			"image|Image URL",
			"url|Website",
			"telephone|Phone",
			"priceRange|Price range|e.g. $$ or 10-40 EUR",
			...ADDRESS,
			"latitude|Latitude",
			"longitude|Longitude",
			"*hours|Opening hours|Mon-Fri 09:00-17:00",
			"cuisine|Cuisine served|Comma-separated; food businesses only",
			"menu|Menu URL",
			"?reservations|Accepts reservations",
		],
		{},
	).fields,
	defaults: { businessType: "LocalBusiness", name: "%%sitetitle%%" },
	build: (v, b) => businessNode(v, b.pageUrl),
};

const faq: SchemaType = {
	id: "faq",
	label: "FAQ",
	note: "One question per line, as “Question | Answer”. Or leave a blank line between questions and put the answer on the lines under each one.",
	fields: [area("questions", "Questions and answers", "How long is delivery? | Two working days.")],
	defaults: {},
	build(v) {
		const pairs = parsePairs(v.text("questions"));
		if (!pairs.length) return null;
		return { "@type": "FAQPage", mainEntity: pairs.map((pair) => ({ "@type": "Question", name: pair.question, acceptedAnswer: { "@type": "Answer", text: pair.answer } })) };
	},
};

const howTo = make(
	"howto",
	"How-to",
	"HowTo",
	["name|Title||=", DESCRIPTION, IMAGE, "totalTime|Total time|Minutes, or HH:MM|=:i", "cost|Estimated cost", "currency|Currency|@c", area("steps", "Steps", "Mix | Stir the flour into the water.")],
	{ name: TITLE, image: THUMB },
	(v, b) => {
		const steps = parseSteps(v.text("steps"));
		if (!steps.length) return null;
		const cost = v.number("cost");
		return {
			estimatedCost: cost !== null && v.text("currency") ? { "@type": "MonetaryAmount", currency: v.text("currency").toUpperCase(), value: cost } : undefined,
			step: steps.map((step, index) => ({ "@type": "HowToStep", position: index + 1, name: step.name, text: step.text, image: absoluteUrl(step.image, b.siteUrl) })),
		};
	},
	{ note: "One step per line, as “Step name | Instructions | Image URL”. The name and the image are optional." },
);

const course = make(
	"course",
	"Course",
	"Course",
	[
		"name|Course name||=",
		DESCRIPTION,
		"provider|Provider (school or organization)",
		"providerUrl|Provider website",
		"price|Price|0 for a free course",
		"currency|Currency|@c",
		pick("offerCategory", "Pricing", ["", "Free", "Paid", "Subscription", "Partially Free"], { "Partially Free": "Partially free" }),
		pick("courseMode", "How it is taught", ["", "Online", "Onsite", "Blended"]),
		"location|Location|Where an on-site course takes place",
		"startDate|Start date|@d",
		"endDate|End date|@d",
		"workload|Workload|e.g. 22 hours",
	],
	{ name: TITLE, description: EXCERPT, provider: "%%sitetitle%%" },
	(v) => ({
		provider: v.text("provider") ? { "@type": "Organization", name: v.text("provider"), sameAs: v.url("providerUrl") } : undefined,
		offers: offer(v, { price: "price", currency: "currency" }, { category: v.text("offerCategory") }) ?? (v.text("offerCategory") ? { "@type": "Offer", category: v.text("offerCategory") } : undefined),
		hasCourseInstance: { "@type": "CourseInstance", courseMode: v.text("courseMode"), location: v.text("location"), startDate: v.date("startDate"), endDate: v.date("endDate"), courseWorkload: isoDuration(v.text("workload")) },
	}),
);

const recipe = make(
	"recipe",
	"Recipe",
	"Recipe",
	[
		"name|Recipe name||=",
		DESCRIPTION,
		"author|Author name||=:-",
		"image|Image URL||=:u,datePublished:-",
		"category|Category|e.g. Dessert|recipeCategory",
		"cuisine|Cuisine|e.g. French|recipeCuisine",
		"keywords|Keywords|Comma-separated|=",
		"prepTime|Preparation time|Minutes|=:i",
		"cookTime|Cooking time|Minutes|=:i,totalTime:-",
		"yield|Yield|e.g. 4 servings|recipeYield",
		"calories|Calories per serving",
		"video|Video URL",
		"*ingredients|Ingredients",
		"*instructions|Instructions",
	],
	{ name: TITLE, description: EXCERPT, author: AUTHOR, image: THUMB },
	(v, b, name) => {
		const minutes = (v.number("prepTime") ?? 0) + (v.number("cookTime") ?? 0);
		const bare = [v.text("prepTime"), v.text("cookTime")].every((value) => !value || /^\d+(\.\d+)?$/.test(value));
		const calories = v.text("calories");
		const video = v.url("video");
		return {
			author: person(v.text("author")),
			datePublished: isoDay(b.publishedAt),
			totalTime: bare && minutes > 0 ? isoDuration(String(minutes)) : "",
			nutrition: calories ? { "@type": "NutritionInformation", calories: /^\d+(\.\d+)?$/.test(calories) ? `${calories} calories` : calories } : undefined,
			video: video ? { "@type": "VideoObject", name, description: v.text("description") || name, thumbnailUrl: v.url("image"), contentUrl: video, uploadDate: isoDate(b.publishedAt) } : undefined,
			recipeIngredient: lines(v.text("ingredients")),
			recipeInstructions: lines(v.text("instructions")).map((step) => ({ "@type": "HowToStep", text: step })),
		};
	},
	{ note: "Ingredients and instructions take one item per line." },
);

const job = make(
	"job",
	"Job posting",
	"JobPosting",
	[
		"title|Job title||=",
		DESCRIPTION,
		"datePosted|Date posted|@d|=:d",
		"validThrough|Apply until|@d|=:d",
		[
			pick("employmentType", "Employment type", ["", "FULL_TIME", "PART_TIME", "CONTRACTOR", "TEMPORARY", "INTERN", "VOLUNTEER", "PER_DIEM", "OTHER"], {
				FULL_TIME: "Full time",
				PART_TIME: "Part time",
				CONTRACTOR: "Contractor",
				TEMPORARY: "Temporary",
				INTERN: "Intern",
				VOLUNTEER: "Volunteer",
				PER_DIEM: "Per diem",
				OTHER: "Other",
			}),
			"=",
		],
		"identifierName|Reference name|Who issued the job reference",
		"identifierValue|Reference number",
		"organization|Hiring organization",
		"organizationUrl|Organization website",
		"organizationLogo|Organization logo URL",
		...ADDRESS,
		"?remote|Fully remote",
		"applicantLocation|Country applicants must be in|For remote jobs",
		"?directApply|Applicants can apply on this page",
		"salary|Salary",
		"salaryCurrency|Salary currency|@c",
		pick("salaryUnit", "Salary per", ["", "HOUR", "DAY", "WEEK", "MONTH", "YEAR"], { HOUR: "Hour", DAY: "Day", WEEK: "Week", MONTH: "Month", YEAR: "Year" }),
	],
	{ title: TITLE, description: EXCERPT, datePosted: DAY, organization: "%%sitetitle%%", organizationUrl: "%%siteurl%%" },
	(v) => {
		const salary = v.number("salary");
		return {
			identifier: v.text("identifierValue") ? { "@type": "PropertyValue", name: v.text("identifierName"), value: v.text("identifierValue") } : undefined,
			hiringOrganization: v.text("organization") ? { "@type": "Organization", name: v.text("organization"), sameAs: v.url("organizationUrl"), logo: v.url("organizationLogo") } : undefined,
			jobLocation: { "@type": "Place", address: postalAddress(v) },
			...(v.flag("remote") ? { jobLocationType: "TELECOMMUTE", applicantLocationRequirements: v.text("applicantLocation") ? { "@type": "Country", name: v.text("applicantLocation") } : undefined } : {}),
			...(v.flag("directApply") ? { directApply: true } : {}),
			baseSalary: salary !== null && v.text("salaryCurrency") ? { "@type": "MonetaryAmount", currency: v.text("salaryCurrency").toUpperCase(), value: { "@type": "QuantitativeValue", value: salary, unitText: v.text("salaryUnit") } } : undefined,
		};
	},
	{ titleField: "title" },
);

const video = make(
	"video",
	"Video",
	"VideoObject",
	["name|Video title||=", DESCRIPTION, "thumbnail|Thumbnail URL||thumbnailUrl:u", "uploadDate|Upload date|@d|=:d", "duration|Duration|HH:MM:SS or MM:SS|=:-", "contentUrl|Video file URL||=:u", "embedUrl|Embed (player) URL||=:u"],
	{ name: TITLE, description: EXCERPT, thumbnail: THUMB, uploadDate: DAY },
	(v, b) => ({ duration: isoDuration(v.text("duration"), "seconds"), publisher: b.publisher }),
);

const EVENT_TYPES = ["Event", "BusinessEvent", "ChildrensEvent", "ComedyEvent", "CourseInstance", "DanceEvent", "DeliveryEvent", "EducationEvent", "ExhibitionEvent", "Festival", "FoodEvent", "LiteraryEvent", "MusicEvent", "PublicationEvent", "SaleEvent", "ScreeningEvent", "SocialEvent", "SportsEvent", "TheaterEvent", "VisualArtsEvent"];
const EVENT_STATUS = ["", "EventScheduled", "EventMovedOnline", "EventRescheduled", "EventPostponed", "EventCancelled"];
const ATTENDANCE = ["", "OfflineEventAttendanceMode", "OnlineEventAttendanceMode", "MixedEventAttendanceMode"];
const AVAILABILITY = ["", "InStock", "OutOfStock", "PreOrder", "SoldOut", "BackOrder", "LimitedAvailability", "OnlineOnly", "InStoreOnly", "Discontinued"];

const event = make(
	"event",
	"Event",
	"Event",
	[
		pick("eventType", "Event type", EVENT_TYPES),
		"name|Event name||=",
		DESCRIPTION,
		IMAGE,
		"start|Starts|@t|startDate:d",
		"end|Ends|@t|endDate:d",
		[pick("status", "Status", EVENT_STATUS, { EventScheduled: "Scheduled", EventMovedOnline: "Moved online", EventRescheduled: "Rescheduled", EventPostponed: "Postponed", EventCancelled: "Cancelled" }), "eventStatus:s"],
		[{ ...text("previousStart", "Original start", DATETIME), when: { field: "status", eq: "EventRescheduled" } }, "previousStartDate:-"],
		[pick("attendance", "Attendance", ATTENDANCE, { OfflineEventAttendanceMode: "In person", OnlineEventAttendanceMode: "Online", MixedEventAttendanceMode: "In person and online" }), "eventAttendanceMode:s"],
		"locationName|Venue name",
		"locationAddress|Venue address",
		"locationUrl|Online event URL",
		"offerName|Ticket name",
		"offerCategory|Ticket category|e.g. primary, presale",
		"price|Ticket price|0 for a free event",
		"currency|Currency|@c",
		pick("availability", "Ticket availability", AVAILABILITY),
		"validFrom|Tickets on sale from|@t",
		"offerUrl|Ticket URL",
		"performer|Performer",
		"organizerName|Organizer",
		"organizerUrl|Organizer website",
	],
	{ eventType: "Event", name: TITLE, description: EXCERPT, image: THUMB },
	(v, b) => {
		if (!v.date("start")) return null;
		const mode = v.text("attendance");
		const place: Node = { "@type": "Place", name: v.text("locationName"), address: v.text("locationAddress") };
		const online: Node = { "@type": "VirtualLocation", url: v.url("locationUrl") || b.pageUrl };
		return {
			"@type": EVENT_TYPES.includes(v.text("eventType")) ? v.text("eventType") : "Event",
			previousStartDate: v.text("status") === "EventRescheduled" ? v.date("previousStart") : "",
			location: mode === "OnlineEventAttendanceMode" ? online : mode === "MixedEventAttendanceMode" ? [place, online] : place,
			offers: offer(v, { price: "price", currency: "currency" }, { name: v.text("offerName"), category: v.text("offerCategory"), availability: schemaUrl(v.text("availability")), validFrom: v.date("validFrom"), url: v.url("offerUrl") || b.pageUrl }),
			performer: person(v.text("performer")),
			organizer: v.text("organizerName") ? { "@type": "Organization", name: v.text("organizerName"), url: v.url("organizerUrl") } : undefined,
		};
	},
);

const ENERGY = ["", "A3Plus", "A2Plus", "A1Plus", "A", "B", "C", "D", "E", "F", "G"];
const energyClass = (value: string) => `${CONTEXT}/EUEnergyEfficiencyCategory${value}`;

const product = make(
	"product",
	"Product",
	"Product",
	[
		"name|Product name||=",
		DESCRIPTION,
		IMAGE,
		"sku|SKU||=",
		"brand|Brand",
		pick("idType", "Product identifier", ["", "gtin8", "gtin12", "gtin13", "gtin14", "mpn", "isbn"], { gtin8: "GTIN-8", gtin12: "GTIN-12 (UPC)", gtin13: "GTIN-13 (EAN)", gtin14: "GTIN-14", mpn: "MPN", isbn: "ISBN" }),
		"idValue|Identifier value",
		"price|Price",
		"currency|Currency|@c",
		"priceValidUntil|Price valid until|@d",
		pick("condition", "Condition", ["", "NewCondition", "RefurbishedCondition", "UsedCondition", "DamagedCondition"], { NewCondition: "New", RefurbishedCondition: "Refurbished", UsedCondition: "Used", DamagedCondition: "Damaged" }),
		pick("availability", "Availability", AVAILABILITY),
		"ratingValue|Average rating|e.g. 4.5",
		"reviewCount|Number of reviews",
		"*positiveNotes|Pros",
		"*negativeNotes|Cons",
		pick("energy", "EU energy class", ENERGY, { A3Plus: "A+++", A2Plus: "A++", A1Plus: "A+", A: "A", B: "B", C: "C", D: "D", E: "E", F: "F", G: "G" }),
	],
	{ name: TITLE, description: EXCERPT, image: THUMB },
	(v, b) => {
		const pros = notes(v.text("positiveNotes"));
		const cons = notes(v.text("negativeNotes"));
		const ratingValue = v.number("ratingValue");
		const reviewCount = v.number("reviewCount");
		const idType = v.text("idType");
		const energy = v.text("energy");
		return {
			brand: v.text("brand") ? { "@type": "Brand", name: v.text("brand") } : undefined,
			...(idType && v.text("idValue") ? { [idType]: v.text("idValue") } : {}),
			offers: offer(v, { price: "price", currency: "currency" }, { url: b.pageUrl, priceValidUntil: v.day("priceValidUntil"), itemCondition: schemaUrl(v.text("condition")), availability: schemaUrl(v.text("availability")) }),
			aggregateRating: ratingValue !== null && reviewCount !== null && reviewCount > 0 ? { "@type": "AggregateRating", ratingValue, reviewCount } : undefined,
			review: pros || cons ? { "@type": "Review", author: { "@type": "Organization", name: b.siteName }, positiveNotes: pros, negativeNotes: cons } : undefined,
			hasEnergyConsumptionDetails: energy ? { "@type": "EnergyConsumptionDetails", hasEnergyEfficiencyCategory: energyClass(energy), energyEfficiencyScaleMin: energyClass("G"), energyEfficiencyScaleMax: energyClass("A3Plus") } : undefined,
		};
	},
	{ note: "Pros and cons take one item per line." },
);

const APP_CATEGORIES = ["", "GameApplication", "SocialNetworkingApplication", "TravelApplication", "ShoppingApplication", "SportsApplication", "LifestyleApplication", "BusinessApplication", "DesignApplication", "DeveloperApplication", "DriverApplication", "EducationalApplication", "HealthApplication", "FinanceApplication", "SecurityApplication", "BrowserApplication", "CommunicationApplication", "DesktopEnhancementApplication", "EntertainmentApplication", "MultimediaApplication", "HomeApplication", "UtilitiesApplication", "ReferenceApplication"];

const software = make(
	"softwareapp",
	"Software application",
	"SoftwareApplication",
	[
		"name|Application name||=",
		"os|Operating system|e.g. Windows, macOS, Android|operatingSystem",
		[pick("category", "Category", APP_CATEGORIES, Object.fromEntries(APP_CATEGORIES.filter(Boolean).map((value) => [value, words(value.replace(/Application$/, ""))]))), "applicationCategory"],
		"price|Price|0 for a free application",
		"currency|Currency|@c",
		"rating|Rating",
		"maxRating|Highest possible rating|5",
		"ratingCount|Number of ratings|Leave empty for a single review",
		"author|Review author",
	],
	{ name: TITLE, author: AUTHOR },
	(v, b) => {
		const score = rating(v, "rating", "maxRating");
		const count = v.number("ratingCount");
		return {
			offers: offer(v, { price: "price", currency: "currency" }),
			...(score && count !== null && count > 0
				? { aggregateRating: { ...score, "@type": "AggregateRating", ratingCount: count } }
				: score
					? { review: { "@type": "Review", reviewRating: score, author: person(v.text("author")) ?? { "@type": "Organization", name: b.siteName } } }
					: {}),
		};
	},
);

const service = make(
	"service",
	"Service",
	"Service",
	[
		"name|Service name||=",
		"serviceType|Type of service|e.g. Plumbing|=",
		DESCRIPTION,
		IMAGE,
		"areaServed|Area served|City, region or country|=",
		"slogan|Slogan||=",
		"providerName|Provider name",
		"providerImage|Provider image URL",
		[pick("mobility", "Provider works", ["", "static", "dynamic"], { static: "At a fixed location", dynamic: "At the customer's location" }), "providerMobility"],
		"telephone|Phone",
		"priceRange|Price range|e.g. $$",
		...ADDRESS,
		"latitude|Latitude",
		"longitude|Longitude",
	],
	{ name: TITLE, description: EXCERPT, image: THUMB, providerName: "%%sitetitle%%" },
	(v) => ({
		provider: v.text("providerName") ? { "@type": "LocalBusiness", name: v.text("providerName"), image: v.url("providerImage"), telephone: v.text("telephone"), priceRange: v.text("priceRange"), address: postalAddress(v), geo: geo(v) } : undefined,
	}),
);

const REVIEWED = ["Thing", "Book", "Course", "CreativeWorkSeason", "CreativeWorkSeries", "Episode", "Event", "Game", "LocalBusiness", "MediaObject", "Movie", "MusicPlaylist", "MusicRecording", "Organization", "Product", "Recipe", "SoftwareApplication"];

const review = make(
	"review",
	"Review",
	"Review",
	["item|What is reviewed||itemReviewed:-,reviewRating:-", pick("itemType", "Kind of thing", REVIEWED), "image|Image URL", "rating|Rating", "maxRating|Highest possible rating|5", "*body|Review text||reviewBody", "author|Author name", "*positiveNotes|Pros", "*negativeNotes|Cons"],
	{ item: TITLE, itemType: "Thing", image: THUMB, author: AUTHOR },
	(v, b, item) => {
		const score = rating(v, "rating", "maxRating");
		if (!score) return null;
		return {
			itemReviewed: { "@type": REVIEWED.includes(v.text("itemType")) ? v.text("itemType") : "Thing", name: item, image: v.url("image") },
			reviewRating: score,
			author: person(v.text("author")) ?? { "@type": "Organization", name: b.siteName },
			datePublished: isoDay(b.publishedAt),
			publisher: b.publisher,
			positiveNotes: notes(v.text("positiveNotes")),
			negativeNotes: notes(v.text("negativeNotes")),
		};
	},
	{ titleField: "item", note: "Pros and cons take one item per line." },
);

const BOOK_FORMATS = ["", "Hardcover", "Paperback", "EBook", "AudiobookFormat", "GraphicNovel"];

const book = make(
	"book",
	"Book",
	"Book",
	[
		"name|Book title||=",
		"author|Author||=:-",
		pick("authorType", "Author is", ["Person", "Organization"], { Person: "A person", Organization: "An organization" }),
		"isbn|ISBN|Keep leading zeros and hyphens|=",
		"edition|Edition||bookEdition",
		[pick("format", "Format", BOOK_FORMATS, { EBook: "E-book", AudiobookFormat: "Audiobook" }), "bookFormat:s"],
		"pages|Number of pages||numberOfPages:-",
		"language|Language|Language code, e.g. en|inLanguage",
		"date|Publication date|@d|datePublished:y",
		"publisher|Publisher||=:-",
		"illustrator|Illustrator||=:-",
		[pick("abridged", "Abridged", ["", "yes", "no"], { yes: "Yes", no: "No" }), "=:-"],
		"price|Price|0 for a free book|offers:-",
		"currency|Currency|@c",
		"offerUrl|Where to buy (URL)",
		"image|Cover image URL||=:u",
		"url|Book URL||=:-",
		DESCRIPTION,
		"?product|Also mark as a product",
	],
	{ name: TITLE, authorType: "Person", image: THUMB, description: EXCERPT },
	(v, b) => {
		const pages = v.number("pages");
		const abridged = v.text("abridged");
		return {
			"@type": v.flag("product") ? ["Book", "Product"] : "Book",
			author: v.text("author") ? { "@type": v.text("authorType") === "Organization" ? "Organization" : "Person", name: v.text("author") } : undefined,
			numberOfPages: pages !== null && pages > 0 ? Math.round(pages) : undefined,
			publisher: v.text("publisher") ? { "@type": "Organization", name: v.text("publisher") } : undefined,
			illustrator: person(v.text("illustrator")),
			...(abridged === "yes" || abridged === "no" ? { abridged: abridged === "yes" } : {}),
			offers: offer(v, { price: "price", currency: "currency" }, { url: v.url("offerUrl") || b.pageUrl }),
			url: v.url("url") || b.pageUrl,
		};
	},
);

const VARIABLE = /%%.*?%%/g;
/** A variable's value as it can sit inside a JSON string. */
const insideJson = (value: string) => JSON.stringify(value).slice(1, -1);

const custom: SchemaType = {
	id: "custom",
	label: "Custom JSON-LD",
	raw: true,
	note: "Paste a JSON-LD object (or a list of them), without the script tag. Variables can be used inside text values.",
	fields: [area("json", "JSON-LD", '{ "@context": "https://schema.org", "@type": "…" }')],
	defaults: {},
	check(values) {
		const source = typeof values.json === "string" ? values.json : "";
		const result = parseJsonLd(source.replace(VARIABLE, ""));
		return "error" in result ? result.error : null;
	},
	build(v, b) {
		const result = parseJsonLd(v.text("json").replace(VARIABLE, (match) => insideJson(b.render(match))));
		if ("error" in result) return null;
		const nodes = result.nodes.filter((node) => Object.keys(node).some((key) => key !== "@context" && key !== "@type"));
		return nodes.length ? nodes.map((node) => ("@context" in node ? node : { "@context": CONTEXT, ...node })) : null;
	},
};

/** In the order they are offered. */
/** Each type lists only the defaults that are not empty; the rest follow from its fields. */
const complete = (type: SchemaType): SchemaType => ({ ...type, defaults: { ...Object.fromEntries(type.fields.map((field) => [field.key, field.kind === "toggle" ? false : ""])), ...type.defaults } });

export const TYPES: SchemaType[] = [article, localBusiness, faq, howTo, course, recipe, job, video, event, product, software, service, review, book, custom].map(complete);

export const typeOf = (id: unknown): SchemaType | undefined => TYPES.find((type) => type.id === id);
