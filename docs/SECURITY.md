# Security and publication notes

## Sharing source and keeping credentials private

This project separates public code from runtime configuration. `.env.example` describes the settings; each developer or deployment supplies its own `API_TOKEN`. Local environment files, private keys, browser profiles, recordings, reports, and dependency folders belong outside version control and Docker build context.

Never use another product's API key as this service's bearer token. Do not place a service token in frontend JavaScript, a public request example, a committed configuration file, a screenshot, or a GitHub issue. Store deployment secrets in the hosting provider's secret settings and send credentials only over HTTPS when calling a remote service.

Changing `.gitignore` does not remove a credential already committed. A review of the locally reachable history during the portfolio preparation found no private credentials; this does not establish the contents of remote-only branches, provider settings, or external artifacts. Before publication, account for those separately. If a real private credential was ever committed, revoke or rotate it first, remove it from current files, and arrange history cleanup where needed. Do not rely on deleting the latest line to invalidate an exposed credential.

## Service access

The service requires a bearer token for automation and action discovery. `/health` is public so a process supervisor can check the service without storing a credential. Local development and Compose publish to loopback by default. Keep a hosted service limited to trusted clients; repository visibility and runtime access are separate choices.

The browser does not receive the API bearer token as a website header. Every workflow starts with a fresh context rather than a reused authenticated browser profile. The service does not intentionally log workflow bodies, form values, tokens, screenshots, or recording data.

Returned text and images can contain information from the visited page. Supplying credentials in a `fill` action can make them appear in an optional recording or screenshot. Use synthetic accounts and content for public demonstrations, and review artifacts before sharing them.

## Browser and network boundary

Configure `ALLOWED_ORIGINS` with the exact HTTPS origins that a workflow needs. Only standard HTTPS on port 443 is supported. Private addresses and local destinations are rejected. The request guard also applies to page resources, all HTTP 3xx redirect responses are blocked, and WebSocket connections are disabled. Redirects to the same origin are blocked as well: use the final allowed URL directly. These restrictions can cause a page to render without third-party assets until their trusted origins are explicitly added.

Caller-supplied `evaluate` scripts and server filesystem screenshot paths are unavailable. Workflows are bounded by action, concurrency, and runtime limits, and browser resources are closed on completion, failure, or shutdown. Temporary recording files are removed rather than retained as a public archive.

A browser still executes JavaScript supplied by the websites it visits. Chromium is launched with its sandbox enabled. Docker runs it as the unprivileged `pwuser` account and Compose uses the supplied seccomp profile rather than disabling sandboxing. Linux hosts must support the required user namespaces; choose a compatible host if they are unavailable. Render compatibility depends on that host capability and is not guaranteed by the deployment blueprint.

Run the service in a dedicated environment without unrelated credentials, mounted home directories, private browser profiles, or privileged host access. For internet deployment, enforce outbound network policy that blocks internal networks and cloud metadata at the infrastructure layer. Application-level hostname and request checks cannot provide the same guarantee as network isolation against DNS rebinding or browser/runtime vulnerabilities.

This project is a controlled automation demo, not a complete shared browser service. Hosting it for multiple untrusted users requires additional identity, quotas, audit design, isolation, and network controls appropriate to that environment.

## If a token is exposed

Replace `API_TOKEN` with a fresh random token in the local or hosting environment and restart the service. Update trusted clients separately. If the exposed value belongs to a third-party product, rotate it with that provider as well. Remove the value from public source and artifacts, then inspect history and copies without posting the credential into a public issue.
