# Testing (no DB pollution)

## Backend (MongoDB isolated)

- Unit/integration tests use an ephemeral MongoDB via `mongodb-memory-server` (nothing is written to your real DB).
- Run: `npm test`

## Backend + Frontend smoke (optional)

- If you have already built the Angular app, the smoke test can also verify the backend serves the frontend `index.html`.
- Build frontend: `cd ../EPDS && npm i && npm run build`
- Run smoke: `cd ../Backend && npm run test:smoke`

Notes:
- The smoke test starts the backend with `NODE_ENV=test` + `DISABLE_BACKGROUND_JOBS=1` and an in-memory MongoDB.
- If `../EPDS/dist/ex-gpt/browser` is missing and `FRONTEND_DIST` is not set, the frontend part is skipped.

## Frontend unit test (no backend needed)

- Run: `cd ../EPDS && npm test`
