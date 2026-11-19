**Does it replace EmDash's SEO fields?**
No. The search title, description, image, canonical address and "hide from search engines" switch are EmDash's own fields. The SEOdash panel shows and scores them. A sandboxed plugin can read them but not change them, so they are edited in the SEO section of the editor.

**Does it add redirects, a sitemap or a robots.txt editor?**
No. EmDash has those already.

**Will it change my site when I install it?**
No. With default settings the public pages are unchanged.

**What happens to my data if I remove it?**
EmDash's own SEO fields keep their values. The uninstall dialog asks whether to delete plugin storage data: unticked, SEOdash's settings and per-entry data stay for a reinstall; ticked, they are deleted. Settings can be exported first under Settings, on the Import and export tab.

**Which outside services does it contact?**
Only IndexNow, after you switch instant indexing on. It receives your own page addresses and your IndexNow key.

**On Cloudflare, SEOdash's pages say "Plugin responded with 404" after installing.**
On EmDash 1.5 a new plugin reaches only some of the site's running copies at first, so some requests miss it, tags included. Deploy the site once to fix it.

**How long does a site scan take?**
A sandboxed plugin may make about 30 requests to EmDash per run, so the scan works in small batches: about 15 to 25 entries each time the button is pressed. A scheduled job continues an unfinished scan every five minutes.

**What licence is it under?**
GPL-3.0-only; the source is in the repository linked from this listing.
