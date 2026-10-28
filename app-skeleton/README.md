# Optional MEAN skeleton

Starter skeleton — replace freely. Nothing here is graded, and nothing here is domain logic.

## What's in it

**`docker-compose.yml`**: MongoDB 7 running as a single-node replica set, so multi-document transactions work if you want them. Connection string: `mongodb://localhost:27017/harborlight?directConnection=true`.

**`server/`** (Express 5, TypeScript via tsx, Mongoose 9)

| Route | Does |
|---|---|
| `GET /health` | Reports whether Mongo is connected |
| `POST /seed` | Copies `seed/data.json` into collections `org`, `series`, `exceptions`, `volunteers`, `signups_import`, exactly as-is. Idempotent. |
| `GET /api/users` | Coordinators and volunteers, for the client's user switcher |
| `POST /webhooks/tidewater` | Verifies `X-Tidewater-Signature` against the raw body and logs the payload. Returns `204`. Does nothing else. |

Env: `PORT` (3000), `MONGO_URL`, `TIDEWATER_SECRET` (`tidewater-dev`), `SEED_PATH`.

**`client/`** (Angular 21 standalone components, zoneless, Tailwind 4)

A header with a user switcher, and two empty routed pages: `/volunteer` and `/coordinator`. The dev server proxies `/api` and `/health` to `localhost:3000`.

## Run it

```bash
# from the repo root
npm run skeleton:db
npm run skeleton:server
curl -X POST localhost:3000/seed

cd app-skeleton/client
npm install
npm start          # http://localhost:4200
```

Then start the simulator with `TIDEWATER_WEBHOOK_URL=http://localhost:3000/webhooks/tidewater npm run sim` and you'll see signed deliveries logged by the server.
