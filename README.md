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
| Instant indexing | IndexNow, on publish or on demand |
| Publishing rules | Optionally require a description or image alt text before an entry can be published |
| Settings | Export and import |

How it behaves:
- **Default settings change nothing on the public site.** A tag is printed only for a value someone entered or a feature someone switched on.
- **Existing SEO values are never overwritten.**
- **Every feature can be switched off** on the Features tab under Settings. A feature that is off prints nothing and does no background work. Its settings are kept.
- **Nothing is added to public pages** apart from the tags you set up: no scripts, styles or other assets.
- **Outside services are contacted only after you switch them on.** That means IndexNow, which receives the addresses of your own pages and your IndexNow key.

## Install

1. In the EmDash admin, open **Plugins**, search the registry for **SEOdash** and install it. The site needs a plugin sandbox runner; see EmDash's Plugin Sandbox guide.
2. Approve the access it asks for:
   - read content;
   - read the content schema and taxonomies;
   - add a publishing check;
   - manage redirects, used only to serve the IndexNow key file at the site root while IndexNow is on;
   - send requests to `api.indexnow.org` only.
3. On Cloudflare with EmDash 1.5, deploy the site once after installing, so every part of the site picks SEOdash up. EmDash 1.6 does not need this.
4. Open **SEO** in the sidebar. The Overview shows the first site audit once it has run.

Nothing needs to be set up before the plugin is useful.

## Limits of the sandbox

SEOdash runs in EmDash's plugin sandbox. A few things work differently there because of it:

- **Core SEO fields are read-only in the panel.** A sandboxed plugin cannot change an entry's own SEO fields, so this build does not ask to edit content. The SEOdash panel in the editor shows the current search title, description, sharing image and canonical address, and points to the SEO section of the editor, where they are edited. Everything SEOdash stores itself (sharing overrides, robots directives, target keywords, structured data) is edited in the panel.
- **The IndexNow key file is served through a redirect.** IndexNow checks for a key file at the site root, where a sandboxed plugin cannot add a route. On EmDash 1.6 or later, switching IndexNow on adds a redirect (listed under Redirects) from that address to the key, which SEOdash serves. The redirect is removed when IndexNow or instant indexing is switched off or SEOdash is uninstalled, and SEOdash never replaces a redirect someone else set at that address. EmDash 1.5 ignores redirects for file addresses: download the key file from the Indexing tab, add it to the site's `public/` folder and deploy.
- **Site details are entered once.** A sandboxed plugin cannot read EmDash's site settings. The title separator, default sharing image, Google and Bing verification codes and social profiles used in tags and structured data go under **Site details** on the Verification tab.
- **Scans run in small batches.** A sandboxed plugin may make about 30 requests to EmDash per run. The site audit scans about 15 to 25 entries each time **Scan the site**, **Scan now** or **Continue the scan** is pressed. A scheduled job continues an unfinished scan every five minutes, and starts a new one a day after the last one finished.
- **The page title comes from the site template.** EmDash templates set `<title>` themselves, and no plugin can change it. SEOdash's description and social title templates are applied automatically.
- **Images are pasted as addresses.** The plugin's forms cannot show EmDash's media picker. Image fields link to the media library, where **Copy URL** gives the address to paste.

## Removing it

Uninstall SEOdash from EmDash's Plugins screen. The uninstall dialog has a checkbox, **Also delete plugin storage data**, which is off by default:

- **Left off:** SEOdash's settings (including the IndexNow key) and what it stored per entry (sharing overrides, robots directives, target keywords, structured data, audit results), stay in the database. Installing SEOdash again picks them up.
- **Ticked:** all of that is deleted for good.

Either way, EmDash's own SEO fields on each entry are untouched, SEOdash's scheduled scan is cancelled, and the IndexNow key file redirect is removed. To keep a copy of the settings, export them first from the Import and export tab under Settings.

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
