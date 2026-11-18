# SEOdash

SEO for EmDash. SEOdash works with the SEO features EmDash already has and adds the ones it lacks. It is a sandboxed plugin, installed from the EmDash plugin registry.

The plugin's source is in [`seodash/`](seodash/).

## What it does

EmDash already gives entries in collections with SEO turned on the basics:
- a search title and description;
- a sharing image and a canonical address;
- a switch to hide the entry from search engines.

It also handles redirects, `sitemap.xml` and `robots.txt`. SEOdash keeps no second copy of any of that. It reads EmDash's own values and adds the rest:

| Area | What it adds |
| --- | --- |
| Editor panel | An SEO score and a content analysis against target keywords. It also has sharing overrides, extra robots directives and structured data for the entry. |
| Titles and meta | Title and description templates per collection, with variables. A home page title and description. Extra robots directives for the whole site or a collection. |
| Social | Open Graph and X card options, and Facebook app and page IDs |
| Verification | Pinterest, Yandex and Baidu verification codes, and optional Dublin Core tags |
| Structured data | Fourteen schema types per entry (article, product, event, recipe, FAQ, how-to, job posting, video and more) and custom JSON-LD. Automatic rules per collection, publisher and local business details, and breadcrumbs. |
| Site audit | Scores every published entry and lists what to fix first, with a dashboard widget |
| Instant indexing | IndexNow and the Google Indexing API, on publish or on demand |
| Publishing rules | Optionally require a description or image alt text before an entry can be published |
| Settings | Export and import |

How it behaves:
- **Default settings change nothing on the public site.** A tag is printed only for a value someone entered or a feature someone switched on.
- **Existing SEO values are never overwritten.**
- **Every feature can be switched off** on the Features tab under Settings. A feature that is off prints nothing and does no background work. Its settings are kept.
- **Nothing is added to public pages** apart from the tags you set up: no scripts, styles or other assets.
- **Outside services are contacted only after you switch them on.** That means IndexNow and Google's indexing service. They receive the addresses of your own pages, with your IndexNow key or a sign-in token made from your Google key.

## Install

1. In the EmDash admin, open **Plugins**, search the registry for **SEOdash** and install it. The site needs a plugin sandbox runner; see EmDash's Plugin Sandbox guide.
2. Approve the access it asks for:
   - read content;
   - read the content schema and taxonomies;
   - add a publishing check;
   - send requests to `api.indexnow.org`, `indexing.googleapis.com` and `oauth2.googleapis.com` only.
3. On Cloudflare, deploy the site once after installing, so every part of the site picks SEOdash up.
4. Open **SEO** in the sidebar. The Overview shows the first site audit once it has run.

Nothing needs to be set up before the plugin is useful.

## Limits of the sandbox

SEOdash runs in EmDash's plugin sandbox. A few things work differently there because of it:

- **Core SEO fields are read-only in the panel.** A sandboxed plugin cannot change an entry's own SEO fields, so this build does not ask to edit content. The SEOdash panel in the editor shows the current search title, description, sharing image and canonical address, and points to the SEO section of the editor, where they are edited. Everything SEOdash stores itself (sharing overrides, robots directives, target keywords, structured data) is edited in the panel.
- **IndexNow needs a key file you add yourself.** IndexNow checks for a key file at the site root, and a sandboxed plugin cannot serve a file there. When you switch IndexNow on, the Indexing tab shows the file name and its one line of content. Add that file to the site's `public/` folder, deploy, then confirm on the same tab that it is in place.
- **Site details are entered once.** A sandboxed plugin cannot read EmDash's site settings. The title separator, default sharing image, Google and Bing verification codes and social profiles used in tags and structured data go under **Site details** on the Verification tab.
- **Scans run in small batches.** A sandboxed plugin may make about 30 requests to EmDash per run. The site audit scans about 15 to 25 entries each time **Scan the site**, **Scan now** or **Continue the scan** is pressed. A scheduled job continues an unfinished scan every five minutes, and starts a new one a day after the last one finished.
- **The page title comes from the site template.** EmDash templates set `<title>` themselves, and no plugin can change it. SEOdash's description and social title templates are applied automatically.
- **API keys need an encryption key.** EmDash encrypts saved keys, such as a Google service account key, and refuses to save one unless the site sets `EMDASH_ENCRYPTION_KEY`.

## Removing it

Uninstall SEOdash from EmDash's Plugins screen. The uninstall dialog has a checkbox, **Also delete plugin storage data**, which is off by default:

- **Left off:** SEOdash's settings and saved keys, and what it stored per entry (sharing overrides, robots directives, target keywords, structured data, audit results), stay in the database. Installing SEOdash again picks them up.
- **Ticked:** all of that is deleted for good.

Either way, EmDash's own SEO fields on each entry are untouched, and SEOdash's scheduled scan is cancelled. To keep a copy of the settings, export them first from the Import and export tab under Settings.

## Development

```sh
cd seodash
npm install
npm run typecheck
npm test
npm run build
cd marketplace
npm run validate
npm run bundle    # builds the sandbox bundle and checks the 128 KB limit
npm test
```

## Licence

GPL-3.0-only. See [`seodash/LICENSE`](seodash/LICENSE).
