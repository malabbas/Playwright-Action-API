# API reference

All examples use a local service at `http://127.0.0.1:3000`. A deployed service uses its own HTTPS URL and a token stored in its deployment environment.

## Endpoints

| Method and path | Authentication | Behavior |
| --- | --- | --- |
| `GET /health` | None | Returns `{ "ok": true }` when the HTTP service is running. This does not launch Chromium or verify a destination website. |
| `GET /debug/actions` | Bearer token | Returns `ok` and the `supported_actions` array. |
| `POST /actions` | Bearer token | Executes an ordered browser workflow and returns the results. |

Send `Authorization: Bearer <your-service-token>` from a trusted caller. JSON requests also require `Content-Type: application/json`. `/run` is not an endpoint in this implementation.

## Workflow request

```json
{
  "url": "https://example.com",
  "mode": "actions",
  "recordVideo": false,
  "actions": [
    { "action": "extract_text", "selector": "h1" },
    { "action": "screenshot", "fullPage": false }
  ]
}
```

`url` is the initial destination and must belong to `ALLOWED_ORIGINS`. `mode` must equal `"actions"`. `actions` is an ordered array of up to 50 steps. `recordVideo` is an optional boolean, defaulting to `false`.

The browser navigates to `url` before running the array. Every subsequent request, including subresources, remains subject to the origin policy. HTTP 3xx responses are blocked rather than followed, even when the redirect points to the same origin. Supply the final allowed HTTPS URL directly; pages that require redirects may not work with this service. Approving a page origin does not automatically approve third-party fonts, images, analytics, frames, or other hosts. WebSocket connections are blocked.

## Actions

Each step uses `action` or the equivalent `type` field. Action names are normalized to lowercase. `navigate`, `go_to`, and `go` are aliases of `goto`.

For actions that accept a locator, use a CSS `selector` or a `text` value. An optional zero-based `nth` selects one matching element. A `selector` takes precedence over `text`.

| Action | Fields | Result |
| --- | --- | --- |
| `goto` | `url`; optional `waitUntil`, `timeout` in milliseconds. If `url` is omitted, uses the initial workflow URL. | `action`, resulting `url` |
| `wait` | `ms` in milliseconds | `action`, actual bounded `ms` |
| `scroll` | Optional locator; otherwise `scrollBy`, `maxScrolls`, `waitMsBetween` | `action` and locator or scroll settings |
| `click` | Locator | `action` |
| `fill` | Locator and string `value` | `action` |
| `press` | String `key`; optional `selector` | `action`, `key` |
| `wait_for` | `selector`; optional `timeout` in milliseconds | `action` |
| `screenshot` | Optional `fullPage` boolean | `action`, PNG `base64` |
| `extract_text` | `selector`; optional `keepExactText` boolean | `action`, `text` |
| `extract_articles` | Optional `containerSelectors` string array, `patterns` regex-source array, and `keepExactText` boolean | `action`, `articles` array containing text and optional pattern matches |

`press` uses the focused page when `selector` is absent. `scroll` brings the matching element into view when a locator is supplied. Otherwise it scrolls the page in bounded steps. `extract_text` uses the first match and normally collapses whitespace. `extract_articles` defaults to `article`, `main`, and `body`; overlapping containers may return overlapping content. Its regex patterns use JavaScript syntax without surrounding slashes.

`evaluate` is deliberately unavailable in this public service. Screenshots are returned in the response; the caller cannot provide a server filesystem `path`.

## Example response

```json
{
  "ok": true,
  "data": {
    "results": [
      { "action": "extract_text", "text": "Example Domain" },
      { "action": "screenshot", "base64": "<PNG bytes encoded as Base64>" }
    ],
    "finalUrl": "https://example.com/"
  }
}
```

The illustrative Base64 string above is not image data. Decode the actual response value on the caller's machine to save a PNG. The service does not return a downloadable public artifact URL.

## Recording

Set `"recordVideo": true` to record the session. The successful response also includes `data.video.base64`, containing a WebM recording. The service finalizes the recording when it closes the context, reads it into the response, and deletes its temporary files. It does not expose local recording paths.

Recording and screenshots can make responses large. Individual artifacts are limited to 5 MiB; the complete serialized JSON response is limited to 10 MiB. Store results only where the workflow's data is allowed to be stored. A failed or interrupted workflow does not produce a successful artifact response.

## Failures and limits

Error responses use an `ok: false` JSON shape. Missing or incorrect authentication is rejected before browser work. Invalid workflow input is rejected, busy services can decline additional jobs, and browser failures or timeouts return a generic error rather than a Playwright stack trace containing page details.

Requests have a 256 KiB JSON limit and a configurable total deadline (`JOB_TIMEOUT_MS`, 60 seconds by default). The service runs at most `MAX_CONCURRENT_JOBS` workflows at once, defaulting to two. Numeric action inputs are also bounded by their handlers; a long step cannot extend the total workflow deadline.

| HTTP status | Typical cause |
| --- | --- |
| `400` | Invalid JSON, unsupported action, invalid URL, or workflow input rejected by the policy. |
| `401` | Missing or incorrect bearer token. |
| `404` | Unknown endpoint after authentication. |
| `413` | Request body, screenshot, video, or response exceeds a size limit. |
| `429` | All browser slots are occupied. |
| `502` | Browser launch, navigation, or action execution failed. |
| `503` | Service shutdown is in progress. |
| `504` | The total workflow deadline expired. |

A failure stops the workflow; no later actions run. Responses are not a transaction: earlier website interactions may already have occurred. Retry only when it is safe for the website action to happen again. A caller disconnection, timeout, or server shutdown also closes active browser resources.
