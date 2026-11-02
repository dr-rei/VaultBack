# Cloudflare cache policy

VaultBack can give its public JavaScript and CSS files content-hashed URLs and send cache headers for those exact files. This lets browsers and Cloudflare reuse unchanged assets while the HTML app shell, APIs, authentication, event stream, downloads, exports, and all unversioned files remain uncached.

The policy is configured in **Settings → Cloudflare cache**. It does not store a Cloudflare token, call the Cloudflare API, or edit a Cloudflare zone. The defaults enable caching for one year; browser and edge lifetimes can be set independently from 60 seconds to one year, or disabled.

## Configure Cloudflare

1. Open the Cloudflare cache section as an administrator. Save the desired browser and edge lifetimes.
2. Copy the generated **Bypass all VaultBack traffic except current versioned assets** rule into **Caching → Cache Rules**.
3. Copy the generated **Cache only current versioned VaultBack assets** rule after it.
4. Paste each generated match expression into Cloudflare’s Expression Editor; the expressions use grouped conditions and the `in` operator.
5. Keep browser and edge TTL behavior set to respect the origin cache headers. Do not choose an override that ignores origin `no-store` headers.

The generated expressions are scoped to the hostname used to open VaultBack. Use a dedicated VaultBack hostname: the bypass expression applies to every other path on that hostname. The second expression lists the exact current JavaScript and CSS asset paths, so it does not make APIs, the app shell, or arbitrary `/_assets/` paths cacheable.

The hash changes whenever asset contents change. After each VaultBack release, refresh the generated rule and replace the old asset-path rule in Cloudflare. Cloudflare does not need a purge for new hash paths; old asset paths stop being referenced by the no-store app shell.

Cloudflare respects origin cache headers unless a Cache Rule overrides them. Its cache-specific response header takes precedence for Cloudflare edge decisions, while `Cache-Control` controls browser caching. See Cloudflare's documentation for [default cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/), [CDN-Cache-Control](https://developers.cloudflare.com/cache/concepts/cdn-cache-control/), [Cache Rule settings](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/), and [Rules language operators](https://developers.cloudflare.com/ruleset-engine/rules-language/operators/).

## Origin behavior

- The server hashes top-level regular `.js` and `.css` files when it starts, serves them at `/_assets/<sha256>/<filename>`, and rewrites their local references in `index.html`.
- Exact manifest matches receive `Cache-Control: public, max-age=<browser TTL>, immutable` and `Cloudflare-CDN-Cache-Control: public, max-age=<edge TTL>` when enabled.
- A disabled policy sends `no-store` for hashed assets. Unknown hashes, traversal attempts, unversioned assets, HTML, and every `/api/` response send `no-store` cache headers.
- Restart VaultBack after editing assets so the manifest and HTML references are rebuilt from the same files.

This is an origin-side cache policy with copyable Cloudflare guidance, not evidence that a Cloudflare rule has been installed or that a response was served from cache. Check the Cloudflare rule expression and response headers in Cloudflare Trace or the browser Network panel after configuring the zone.
