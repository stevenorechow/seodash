## 1.0.4

- **IndexNow key file served for you.** On EmDash 1.6 or later, switching IndexNow on adds a redirect from the key file's address at the site root, listed under Redirects. It is removed when IndexNow or instant indexing is switched off, or SEOdash is uninstalled, and an existing redirect at that address is never replaced. This needs a new permission to manage redirects, which EmDash asks you to approve when updating. Search engines are expected to follow the redirect; this has not yet been confirmed with IndexNow itself. On EmDash 1.5, which ignores the redirect, download the file and add it to the public folder as before.
- **Image fields** (default sharing image, publisher logo, local business image) link to the media library, where Copy URL gives the address to paste.
- **Fixed:** the Settings and Structured data pages failed to load on a site with no collections.

## 1.0.3

- Leave entries out of the audit, such as a 404 page; Settings → Audit limits the audit to chosen collections.
- Hidden entries count only as hidden.
- The editor panel leaves the sharing image to EmDash's OG Image field and shows only what it can change.
- Google Indexing API removed to fit the registry size limit. IndexNow is unchanged.

## 1.0.2

Every finding names its entries with an Edit link; the Content tab filters by finding; the dashboard widget shows what to fix first; every failing check says what to do.

## 1.0.1

Screenshots for the listing.

## 1.0.0

First release.
