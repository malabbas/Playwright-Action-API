# Playwright Action API

A browser automation service that turns a JSON workflow into a short-lived Chromium session. Open an approved website, interact with its interface, extract text, and return screenshots or an optional recording through an authenticated HTTP API.

This portfolio project demonstrates API design, reusable browser actions, container packaging, deployment configuration, and practical controls for running browser automation. It is intended for controlled demonstrations and workflows on websites you are authorized to automate.

## What you can try

- Send an ordered workflow to `POST /actions`.
- Navigate, click, fill fields, press keys, wait, and scroll.
- Extract page text or article content and capture screenshots as Base64.
- Request a video of a workflow, returned as Base64 without a server filesystem path.
- Start or stop the service locally with Node.js or Docker Compose.

The repository is the reusable project. It does not include a shared public API endpoint or anyone else's credentials. Each person who clones it supplies their own local service token.

## Start locally

Requirements: Node.js 24 or newer, npm, and the Chromium runtime dependencies for your platform. Chromium runs with its sandbox enabled. Linux hosts must permit the user namespaces needed by that sandbox. Docker Compose is an alternative if you prefer the packaged browser environment; its host still needs compatible sandbox support.

```bash
git clone https://github.com/malabbas/Playwright-Action-API.git
cd Playwright-Action-API
npm ci
npx playwright install --with-deps chromium
npm run setup
npm start
```

`npm run setup` creates an ignored local `.env` file with a unique random service token without printing it. It preserves an existing `.env` file. This token belongs to this service; you do not need to supply a third-party product's API key. The initial destination allowlist is `https://example.com`.

The service loads `.env` and listens at `http://127.0.0.1:3000`. In another terminal in the project folder:

```bash
curl http://127.0.0.1:3000/health
npm run demo
```

The demo reads your local service token and sends a sample workflow. Stop the foreground server with **Ctrl+C**. Run `npm start` again to restart it. `SIGTERM` also triggers graceful shutdown so managed containers can close active browser resources and stop the server.

## Run your own workflow

In Bash, read your service token without putting its literal value into shell history:

```bash
read -rsp 'Service API token: ' API_TOKEN
printf '\n'
curl --fail-with-body http://127.0.0.1:3000/actions \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{
    "url": "https://example.com",
    "mode": "actions",
    "actions": [
      { "action": "extract_text", "selector": "h1" },
      { "action": "screenshot", "fullPage": false }
    ]
  }'
unset API_TOKEN
```

The response contains `ok: true`, ordered `data.results`, and `data.finalUrl`. The heading extraction returns `Example Domain`; the screenshot result contains a Base64-encoded PNG. See [the API reference](docs/API.md) for action fields, recording, and error responses.

## Start and stop with Docker

Requirements: Docker with Compose. Create your ignored local `.env` using `npm run setup`; if Node is unavailable on the host, copy `.env.example` to `.env` and replace its token placeholder with a unique random value of at least 32 characters. Docker supplies the runtime and Chromium dependencies.

```bash
# Build and run in the background.
docker compose up -d --build

# Check health and follow service logs.
curl http://127.0.0.1:3000/health
docker compose logs -f api

# Stop, then start the existing container.
docker compose stop
docker compose start

# Stop and remove the container and Compose network.
docker compose down
```

**Ctrl+C** exits `docker compose logs -f`; use `docker compose stop` to stop the background service. Compose publishes the API on the local loopback interface by default. It runs Chromium as `pwuser`, drops Linux capabilities, applies the supplied seccomp profile, and sets a 1 GiB memory limit, 256-process limit, and 256 MiB shared-memory allocation. The profile permits the user-namespace operations Chromium needs for its sandbox; the host must also permit them. Keep the sandbox enabled when choosing a host.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_TOKEN` | Required | A random service secret of at least 32 characters. Supply it through ignored `.env` or deployment environment settings. |
| `ALLOWED_ORIGINS` | `https://example.com` | Comma-separated exact HTTPS origins the browser may contact; only the standard HTTPS port is supported. Add only origins you trust and need. |
| `PORT` | `3000` | HTTP listening port. |
| `HOST` | `127.0.0.1` | Listening interface. Container/deployment configuration sets `0.0.0.0` inside the container. |
| `MAX_CONCURRENT_JOBS` | `2` | Simultaneous workflows; configurable from 1 to 8. |
| `JOB_TIMEOUT_MS` | `60000` | Total workflow deadline; configurable from 1,000 to 120,000 milliseconds. |

Each workflow accepts at most 50 actions. JSON request bodies are limited to 256 KiB, responses to 10 MiB, and individual screenshots or videos to 5 MiB. Authentication applies to automation and action discovery; `/health` is public for health checks. The API does not enable permissive browser CORS access.

HTTP redirects are blocked, including redirects to the same origin. Use the final allowed HTTPS URL directly. A site that requires a redirect before rendering may be incompatible with the demo until you choose a direct destination.

## Render deployment configuration

The repository includes a Render blueprint, but a compatible container host must support Chromium's user-namespace sandbox. Verify that support with the provider before relying on this deployment. The blueprint alone does not establish that Render's runtime supports the required sandbox; if it does not, use a host that does.

1. Connect your own copy of the repository and create a service using its `render.yaml` blueprint.
2. The blueprint generates a fresh `API_TOKEN` using `generateValue: true`. Retrieve it through Render's environment settings for trusted clients. Do not copy the value into `render.yaml`, a Docker build argument, a README, or source control.
3. Set `ALLOWED_ORIGINS` to the exact HTTPS origins required by your workflow, including any asset origins the page needs.
4. Deploy and verify `/health`. Use the assigned service URL with the same authenticated `/actions` request shown above.
5. Stop or suspend the service through Render when you no longer need it. Local `docker compose stop` only controls the local container.

Use HTTPS for a remote deployment. Keep the token in server-side callers or a secret manager; a static webpage cannot conceal a token embedded in its JavaScript. Publishing this repository does not require exposing a live automation service.

## Azure Container Instances

For an existing Azure Container Instance whose public IP changes, use [the Azure DNS guide](docs/AZURE-DNS.md). Its Cloud Shell helper previews a DNS label update and can apply it using the complete existing deployment while handling registry credentials privately. This keeps the deployed image and settings in place; it does not build a new image or enable HTTPS.

## Design and boundaries

`server.js` owns HTTP requests, authentication, job lifecycle, browser creation, response handling, and shutdown. `actions.js` implements the workflow vocabulary. Every request gets a fresh browser context, without a reused login profile. The package version and Docker browser image are pinned together so a clone uses a matching browser runtime.

The public version excludes caller-supplied JavaScript evaluation and filesystem screenshot paths. It guards requested destinations, rejects HTTP redirects, checks for private network targets, avoids logging raw action values, and removes temporary video files after the response is prepared. Website content, screenshots, and videos may still contain whatever information you choose to browse; treat the returned results accordingly.

Application URL checks are one layer. A hosted service also needs isolation from internal networks and cloud metadata through its deployment network policy. This project is not a multi-tenant browser platform or an invitation to accept untrusted workflows anonymously. See [security and publication notes](docs/SECURITY.md) for the operating model and credential handling.

## Checks and extension

```bash
npm test
```

The automated checks cover the service's configuration and security behavior. Run `npm run demo` against your running instance to check the real browser and destination in your environment as well.

Add focused handlers to `actions.js`, validate their inputs, and document their response shape in [docs/API.md](docs/API.md). Keep the origin guard and request lifecycle in place when adding navigation or network behavior. Use your own token and website allowlist when sharing a runnable copy.

`package.json` sets `private: true` to prevent accidental npm publication; it does not prevent sharing the source in a public GitHub repository. The seccomp profile has separate upstream attribution in [third-party notices](docs/THIRD_PARTY_NOTICES.md).
