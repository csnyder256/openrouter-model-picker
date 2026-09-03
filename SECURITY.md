# Security

## Where the API key lives

This app has no backend. The key you paste in stays in this browser tab's `localStorage` and is sent only as the `Authorization` header on requests to `openrouter.ai`. It never reaches any server this project controls, because this project does not run one. Opening this page over `https://` (GitHub Pages, or your own static host) keeps that header encrypted in transit; do not serve it over plain `http://`.

`localStorage` is per-origin and per-browser. Clearing site data, using a private window, or opening the page in a different browser all mean re-entering the key. That is the trade-off for having no server that could otherwise be breached, logged, or subpoenaed for it.

Use "Forget key" before handing a shared or public machine back to someone else.

## What this repository enforces about itself

CI greps every tracked file for the OpenRouter key prefix (`sk-or-v1-`) and fails the build if one is found, so a committed key is a build failure, not a silent leak. See `.github/workflows/ci.yml`.

## Reporting a vulnerability

Open a private security advisory through the repository's Security tab rather than a public issue.
