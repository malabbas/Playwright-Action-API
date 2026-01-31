# Playwright Docker Render Service

A minimal, production-ready Playwright (Chromium) HTTP service designed for Render deployments. It launches headless Chromium inside the official Playwright Docker image and exposes a simple API for page inspection.

## Endpoints

### `GET /health`
Returns a health status JSON response.

```json
{ "ok": true }
```

### `POST /run`
Navigate to a URL, capture metadata, and return a screenshot.

**Request body**
```json
{ "url": "https://example.com" }
```

**Response body**
```json
{
  "title": "Example Domain",
  "finalUrl": "https://example.com",
  "status": 200,
  "screenshotBase64": "..."
}
```

## Render Deployment

1. Create a new Web Service on Render.
2. Connect this repository.
3. Render will detect `render.yaml` and deploy using Docker.
4. The service listens on the `PORT` provided by Render.

## Local Build (optional)

```bash
docker build -t playwright-render .
docker run -p 3000:3000 playwright-render
```
