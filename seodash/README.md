# SEOdash

SEO for EmDash. It builds on the SEO features EmDash already has and adds the ones it lacks.

## How it fits with EmDash

EmDash core already handles a lot: SEO fields on each entry, redirects and the 404 log,
`sitemap.xml`, `robots.txt`, staging mode, Google and Bing verification, the title separator, the
default sharing image, social profiles and media alt text. SEOdash does not keep a second copy of
any of that.

- **Entry SEO fields.** The SEO panel in the editor edits EmDash's own fields (search title,
  description, sharing image, canonical URL, hide from search engines) in place, next to the score,
  the content analysis and everything SEOdash adds. Nothing is copied, so turning SEOdash off loses
  nothing. Because the panel covers every core field, each editor can hide EmDash's smaller built-in
  SEO section from the editor's layout options.
- **Site settings.** Tagline, separator, default image, verification codes and social profiles are
  read from EmDash's settings and shown with a pointer to where they are edited.
- **Redirects, sitemap, robots.txt.** Left to EmDash. SEOdash adds only what is missing around
  them, such as instant indexing.

With default settings SEOdash changes nothing on the public site. A tag is printed only for a value
someone entered or a feature someone switched on.

## Features

| Area | What it adds |
| --- | --- |
| Editor panel | SEO score, content analysis against target keywords, EmDash's own SEO fields edited in place, social overrides, robots extras, structured data, indexing status |
| Titles & meta | Title and description templates per collection with variables, home page title, extra robots directives |
| Social | Open Graph and X card options, `twitter:site`, Facebook app and page IDs, Pinterest |
| Structured data | Fifteen types per entry, automatic rules per collection, local business, publisher, breadcrumbs |
| Site audit | Scores every published entry and lists what to fix, with a dashboard widget |
| Indexing | IndexNow, on publish or on demand; entries hidden from search are not announced. The key file downloads from the Indexing tab |
| Publishing rules | Optionally require a description or image alt text before an entry can be published |
| Settings | Import and export |

### Switching features on and off

Settings → Features has a switch for each feature. A feature that is off prints nothing, hides its
tabs and panel sections, and does no scheduled work; its settings are kept. A feature that needs
something first is listed with what it needs and cannot be switched on until that is in place.

## Install from the registry

Install SEOdash from the plugin registry in the EmDash admin. `marketplace/` is that package: a
sandboxed plugin with the same modules as the trusted build, inside the sandbox's 128 KB per-file limit.
Two limits of EmDash 1.5's sandbox shape the code: an invocation may make about 30 host calls
(every `ctx` read or write counts), so each invocation works on a remembering view of the context
(`src/core/scope.ts`) and scans run in small batches; and the sandbox bridge refuses to write an
entry's `seo` fields, so the panel shows them read-only there. `test/budget.test.ts` holds every
page, hook and scan batch under the limit.
The sandbox cannot read EmDash's site settings, so the few values needed (tagline, separator, social
profiles) are asked for under Settings → Verification.

```sh
npm run build                      # in this folder
cd marketplace
node scripts/manifest.mjs          # regenerates emdash-plugin.jsonc from the modules
npm test                           # validates the manifest, runs the plugin in the sandbox host
npm run bundle                     # checks the size limit and writes the tarball
```

To publish: set `publisher`, `author` and `security` in `marketplace/emdash-plugin.jsonc`, then
`npx emdash-plugin login <your handle>` and `npx emdash-plugin publish`. The registry page text is
in `marketplace/listing/`.

## Install as a trusted plugin

```js
// astro.config.mjs
import { seodash, seodashRoutes } from "seodash";

export default defineConfig({
	integrations: [emdash({ plugins: [seodash()] }), seodashRoutes()],
});
```

`seodashRoutes()` is optional. It serves the IndexNow key file at `/indexnow-key.txt`, which answers
404 until IndexNow is switched on.

Options: `seodash({ collections: ["posts"], disable: ["indexing"] })`. `disable` leaves a feature
out of the build entirely; the Features tab is for switching features at run time.

### Titles from templates

EmDash templates set `<title>` themselves, so a plugin cannot. To use SEOdash's title and
description templates where an entry has no SEO title of its own:

```astro
---
import { getSeoMeta } from "emdash";
import { seoTemplates } from "seodash/site";

const fromTemplate = await seoTemplates(entry, { collection: "posts" });
const seo = getSeoMeta(entry, { siteTitle, defaultDescription: fromTemplate.description ?? undefined });
---
<title>{fromTemplate.title ?? seo.title}</title>
```

`homeSeo()` returns the home page title and description.

## Development

```sh
npm install
npx tsc --noEmit
npx vitest run
```

`docs/MODULES.md` explains how a feature module is written.

## License

GPL-3.0-only. See `NOTICE`.
