# Wheel Data Local Project

## Run locally

```bash
npm install
npm run dev
```

Open http://127.0.0.1:8000 and log in with:

```text
local
```

Vite serves the React app in development, maps `/api/*` routes to `api/data.js`, and stores development data in `.local-data/wheel_data.json` when Upstash Redis environment variables are not configured.

## Build and preview

```bash
npm run build
npm start
```

The production server serves the Vite output from `dist/` and keeps the same `/api/*` routes.

## Production environment variables

- `ACCESS_PASSWORD`: required for login, cloud sync, and Futu proxy access.
- `UPSTASH_REDIS_REST_URL`: required for persistent production sync.
- `UPSTASH_REDIS_REST_TOKEN`: required for persistent production sync.
- `FUTU_API_URL`: required only if using `/api/futu/*`.
