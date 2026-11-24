1. In the EmDash admin, open **Plugins**, find SEOdash in the registry, install it and approve the access it asks for. On Cloudflare with EmDash 1.5, deploy the site once after installing, so every part of the site picks SEOdash up.
2. Open **SEO** in the sidebar. The Overview page shows the first audit once it has run; the first scan starts by itself within five minutes, or press **Scan the site**.
3. Open any saved entry: the **SEOdash** panel shows its score, its search appearance and the settings SEOdash adds.

Nothing needs to be configured for the plugin to be useful, and nothing is printed on the site until you enter a value.

## Optional steps

- **Site details.** A sandboxed plugin cannot read EmDash's site settings, so the title separator, default sharing image, Google and Bing verification codes and social profiles used in tags and structured data are entered once under Settings, on the Verification tab.
- **IndexNow.** Under Settings, on the Indexing tab, switch IndexNow on. On EmDash 1.6 or later SEOdash serves the key file at the site root with a redirect. On EmDash 1.5, download the key file from the same tab, add it to the site's public folder and deploy.
- **Audit scope.** To audit only some collections, tick them under Settings, on the Audit tab. Single entries, such as a 404 page, can be left out from the Overview.
- **Page titles.** EmDash templates set `<title>` themselves, so the page title comes from the site template. Description and social title templates are applied automatically.
