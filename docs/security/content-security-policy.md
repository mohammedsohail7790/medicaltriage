# Content Security Policy (NFR-152)

The service sends a Content-Security-Policy header on every response (set in `src/app.ts` with helmet). This is the default policy exactly as the running service sends it, captured from a response:

```
Content-Security-Policy: connect-src 'self'; img-src 'self' data:; script-src 'self'; script-src-elem 'self'; frame-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data: https://fonts.gstatic.com https://fonts.googleapis.com; default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'; object-src 'none'; script-src-attr 'none'
```

| Directive | Effect |
|---|---|
| `default-src 'self'` | Anything not named below may load only from the service's own origin. |
| `script-src 'self'`, `script-src-elem 'self'` | JavaScript only from the service itself. No inline scripts, no `eval`, no third-party scripts. |
| `script-src-attr 'none'` | Inline event attributes such as `onclick` are refused. |
| `style-src 'self' 'unsafe-inline'` | Stylesheets from the service itself, **and inline styles are allowed**. See the limit below. |
| `img-src 'self' data:` | Images from the service itself and embedded data images. |
| `font-src 'self' data: https://fonts.gstatic.com https://fonts.googleapis.com` | Fonts from the service itself, embedded fonts, and Google Fonts. |
| `connect-src 'self'` | Browser requests (fetch, WebSocket) only to the service itself. |
| `frame-src 'self'`, `frame-ancestors 'self'` | The service may frame only itself, and only itself may frame it. |
| `object-src 'none'` | No plug-ins. |
| `base-uri 'self'`, `form-action 'self'` | A page cannot change its base address or post a form elsewhere. |

The same responses also carry `Strict-Transport-Security` (180 days, subdomains), `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Resource-Policy: same-origin`.

## Limits stated plainly

- **Inline styles are allowed** (`'unsafe-inline'` in `style-src`) because the application's components set styles in the page. Scripts, the larger risk, are not weakened. Removing this needs the styles moved to files and is not done.
- Google Fonts is a third-party origin in `font-src`. If Qatar Airways wants no third-party origin, the fonts are bundled and the entry removed.
- When a CAPTCHA widget is enabled (NFR-020) its provider's origins are added to the policy by `src/services/captcha.ts`.
- The header was captured from a local run of this build. It has not been captured from the Qatar Airways tenant, where the load balancer could add or change headers; capture it there (`curl -sI`) and attach it as the evidence.
