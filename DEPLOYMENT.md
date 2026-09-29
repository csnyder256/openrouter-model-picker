# Run OpenRouter Model Picker

## Hosted app

Use [the public app](https://csnyder256.github.io/openrouter-model-picker/).
No install or account with this project is needed. Supply an OpenRouter key in
the browser only when invoking model judging.

## Portable website

Download the `static.zip` or `static.tar.gz` asset and checksums from the
[latest release](https://github.com/csnyder256/openrouter-model-picker/releases/latest).
Extract it and serve the extracted directory over HTTP, for example:

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

Open <http://127.0.0.1:8080>. Keep `lib/` beside `app.js`: those local ES modules
are part of the product. `file://` cannot reliably load them. Catalog requests
and judging still need network access; the archive is not an offline model.
The same static directory can be hosted on any static hosting service.

## Container

From the extracted release directory (or a Git checkout), with Docker Compose:

```sh
docker compose up -d --build
```

Open <http://127.0.0.1:8080>. Set `PICKER_PORT` to change the host port. The
container serves static files as a nonroot user with a read-only filesystem;
keys are entered in the browser and are never baked into the image.

## Upgrade

Keep the prior download, extract the new version into a separate folder, verify
checksums and rebuild/restart the container from that folder. Browser settings
stay in browser storage. Delete a saved key in the app when using a shared device.
