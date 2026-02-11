# Backend Info

This document covers installation, environment variables, endpoints, and running the backend.
Tests are documented separately in `TESTING.md`.
Key Vault mapping (App Service references) is documented in `KEYVAULT.md`.

## Installation

Requirements:
- Node.js (LTS recommended)
- MongoDB
- (Optional) Azure services / OpenAI / Pinecone depending on features used

Install dependencies:
```bash
npm install
```

## Environment Variables

Copy and edit:
```bash
cp .env.example .env
```

Key groups (see `.env.example` for the full, commented list):
- Server / URLs / CORS: `NODE_ENV`, `HOST`, `PORT`, `BASE_URL`, `FRONTEND_BASE_URL`, `CORS_ALLOWED_ORIGINS`
- Database / Auth: `MONGO_URI`, `JWT_SECRET`, `JWT_EXPIRES_IN_*`
- OpenAI: `OPENAI_API_KEY` (model/dataset/rerank tuning is configured via **System settings** in the UI; SuperAdmin only)
- OpenAI (tenant AI profile): configured in **Admin → AI settings** (no Assistants API dependency)
- Governed RAG: dataset limits, chunking, rerank, standard explorer settings
- Pinecone (optional): `PINECONE_*`
- Azure: Blob, Document Intelligence, OCR, Custom Vision, Search, Entra ID
- Mail / Brevo: `MAIL_*`, `BREVO_*`
- Billing / Stripe: `STRIPE_*`, `BILLING_*`
- Captcha: `RECAPTCHA_*`, `CAPTCHA_*`

If you are unsure, start with:
```
NODE_ENV=development
HOST=0.0.0.0
PORT=3000
BASE_URL=http://localhost:3000
FRONTEND_BASE_URL=http://localhost:4200
CORS_ALLOWED_ORIGINS=http://localhost:4200,http://localhost:8100
MONGO_URI=...
JWT_SECRET=...
OPENAI_API_KEY=...
```

## Running

Start the API server:
```bash
npm start
```

Common dev usage (if `package.json` defines a dev script):
```bash
npm run dev
```

## Endpoints (detailed)

Base URL: `http://localhost:3000` (or `PORT` from `.env`)
All routes below are mounted under `/api` unless noted.

### System settings (SuperAdmin)
- GET `/api/admin/system-settings`
- PUT `/api/admin/system-settings`
- POST `/api/admin/system-settings/reset`

### Auth
- POST `/api/register`
- POST `/api/login`
- POST `/api/microsoft-login`
- POST `/api/renew-token`
- POST `/api/logout`
- POST `/api/auth/forgot-password`
- POST `/api/auth/change-password`
- POST `/api/auth/verify-email`
- POST `/api/auth/resend-verification`

### Conversation / Chat
- POST `/api/new-conversation`
- POST `/api/chat`
- POST `/api/chat/stream` (SSE)
- POST `/api/chat/governed/stream` (SSE, governed RAG)
- POST `/api/upload-and-ask/stream` (SSE)
- POST `/api/rate-message`
- POST `/api/save-feedback`
- DELETE `/api/conversation/:threadId`
- GET `/api/conversations`
- GET `/api/conversation`
- POST `/api/conversation/standard-explorer`
- POST `/api/aisearch`

### Assistant Instructions + Vector Store Files
- GET `/api/instructions`
- PUT `/api/instructions`
- GET `/api/vector-files`
- POST `/api/vector-files` (multipart: `file`)
- DELETE `/api/vector-files/:fileId`

### Governed RAG: Datasets & Standards
- POST `/api/projects/:projectId/datasets`
- GET `/api/projects/:projectId/datasets`
- GET `/api/projects/:projectId/datasets/:version/files`
- POST `/api/projects/:projectId/datasets/:version/files` (multipart)
- POST `/api/projects/:projectId/datasets/:version/files/stream` (SSE + multipart)
- PATCH `/api/projects/:projectId/dataset-files/:datasetFileId/approval`
- DELETE `/api/projects/:projectId/dataset-files/:datasetFileId`
- POST `/api/projects/:projectId/datasets/:version/approve`

- GET `/api/standards`
- GET `/api/standards/:standardRef`
- GET `/api/standards/:standardRef/pdf`
- GET `/api/standards/:standardRef/clauses`
- POST `/api/standards/upload` (multipart)
- DELETE `/api/standards/:standardRef`
- GET `/api/standard-sets`
- POST `/api/standard-sets`
- DELETE `/api/standard-sets/:setId`

### OCR / Vision
- POST `/api/plate`
- POST `/api/plate/multiple`
- POST `/api/pdfcert`
- POST `/api/vision/upload` (multipart: `image`)
- POST `/api/vision/analyze`

### Fire (Custom Vision)
- POST `/api/fire/analyze` (multipart: `image`)

### Certificates
- POST `/api/certificates/upload`
- POST `/api/certificates/preview-atex`
- GET `/api/certificates/samples`
- GET `/api/certificates`
- GET `/api/certificates/public`
- GET `/api/certificates/public/paged`
- GET `/api/certificates/paged`
- GET `/api/certificates/public/contribution`
- POST `/api/certificates/:id/adopt`
- DELETE `/api/certificates/:id/adopt`
- POST `/api/certificates/resolve-bulk`
- POST `/api/certificates/sas`
- PUT `/api/certificates/update-to-public`
- DELETE `/api/certificates/:id`
- PUT `/api/certificates/:id`
- GET `/api/certificates/reports`
- GET `/api/certificates/:certNo`
- POST `/api/certificates/:id/reports`
- GET `/api/certificates/:id/reports`
- PATCH `/api/certificates/:id/reports/:reportId`

### Certificate Drafts
- POST `/api/certificates/bulk-upload`
- POST `/api/certificates/drafts/process/:uploadId`
- GET `/api/certificates/drafts/:uploadId`
- PATCH `/api/certificates/drafts/by-id/:id`
- POST `/api/certificates/drafts/finalize/by-id/:id`
- POST `/api/certificates/drafts/finalize/:uploadId`
- GET `/api/certificates/uploads/pending`
- DELETE `/api/certificates/uploads/:uploadId`
- GET `/api/certificates/drafts/by-id/:id/pdf`
- GET `/api/certificates/drafts/by-id/:id/pdf-sas`
- DELETE `/api/certificates/drafts/by-id/:id`
- GET `/api/certificates/drafts/pending/count`

### Certificate Requests
- POST `/api/cert-requests/`
- GET `/api/cert-requests/`

### Inspections & Exports
- POST `/api/inspections`
- PUT `/api/inspections/:id`
- POST `/api/inspections/:id/regenerate`
- POST `/api/inspections/upload-attachment`
- DELETE `/api/inspections/attachment`
- GET `/api/inspections`
- GET `/api/inspections/punchlist`
- GET `/api/inspections/project-report`
- GET `/api/inspections/export-zip`
- GET `/api/inspections/export-jobs`
- GET `/api/inspections/export-jobs/:jobId`
- DELETE `/api/inspections/export-jobs/:jobId`
- GET `/api/inspections/:id/export-xlsx`
- GET `/api/inspections/:id`
- DELETE `/api/inspections/:id`

### Sites
- POST `/api/sites`
- GET `/api/sites`
- GET `/api/sites/:id/summary`
- GET `/api/sites/:id/operational-summary`
- GET `/api/sites/:id/overall-status-summary`
- GET `/api/sites/:id/maintenance-severity-summary`
- GET `/api/sites/:id/health-metrics`
- GET `/api/sites/:id`
- PUT `/api/sites/:id`
- DELETE `/api/sites/:id`
- POST `/api/sites/:id/upload-file` (multipart)
- GET `/api/sites/:id/files`
- DELETE `/api/sites/:siteId/files/:fileId`

### Zones (Projects)
- POST `/api/zones`
- GET `/api/zones`
- GET `/api/zones/:id`
- GET `/api/zones/:id/operational-summary`
- GET `/api/zones/:id/maintenance-severity-summary`
- GET `/api/zones/:id/health-metrics`
- PUT `/api/zones/:id`
- DELETE `/api/zones/:id`
- POST `/api/zones/:id/upload-file` (multipart)
- POST `/api/zones/import-xlsx` (multipart)
- GET `/api/zones/:id/files`
- DELETE `/api/zones/:zoneId/files/:fileId`
- DELETE `/api/zones/:id/equipment-images`

### Equipment (Ex Register)
- POST `/api/exreg` (multipart: `pictures`)
- POST `/api/exreg/import`
- POST `/api/exreg/:id/upload-images` (multipart: `pictures`)
- POST `/api/exreg/:id/upload-documents` (multipart: `files`)
- POST `/api/exreg/import-xlsx` (multipart)
- POST `/api/exreg/import-documents-zip` (multipart)
- POST `/api/exreg/import-documents-zip/cleanup-temp`
- GET `/api/exreg/documents-template`
- GET `/api/exreg/export-xlsx`
- GET `/api/exreg/export-ui-xlsx`
- GET `/api/exreg/certificate-summary`
- GET `/api/exreg/certificate-summary-compact`
- GET `/api/exreg/:id/documents`
- DELETE `/api/exreg/:id/documents/:docId`
- GET `/api/exreg`
- GET `/api/exreg/:id`
- GET `/api/exreg/:id/versions`
- GET `/api/exreg/:id/versions/:versionId`
- GET `/api/exreg/:id/history`
- POST `/api/exreg/:id/maintenance/faults`
- POST `/api/exreg/:id/maintenance/repairs/start`
- POST `/api/exreg/:id/maintenance/repairs/:repairId/complete`
- PUT `/api/exreg/:id` (multipart: `pictures`)
- DELETE `/api/exreg/:id`
- POST `/api/exreg/bulk-delete`
- GET `/api/manufacturers`

### Questions
- POST `/api/questions/`
- GET `/api/questions/`
- PUT `/api/questions/:id`
- DELETE `/api/questions/:id`
- GET `/api/questions/export-xlsx`
- POST `/api/questions/import-xlsx` (multipart)
- GET `/api/questions/mappings`
- POST `/api/questions/mappings`
- PUT `/api/questions/mappings/:id`
- DELETE `/api/questions/mappings/:id`

### Users
- GET `/api/users`
- GET `/api/user/:userId`
- PUT `/api/user/:userId` (multipart: `signature`)
- PUT `/api/users/:userId/professions` (Admin/SuperAdmin) body: `{ "professions": ["manager"|"operative"|"ex_inspector"|"technician", ...] }`
- DELETE `/api/user/:userId`
- GET `/api/user/me/quota`
- POST `/api/users/move-to-tenant/:toTenantId`
- POST `/api/admin/create-paid-tenant-user`

### RBAC (Professions)
The backend supports app-level multi-role RBAC via `user.professions` (in addition to system `user.role` like `Admin` / `SuperAdmin`).
Access tokens (JWT) include `professions` and derived `permissions`.

Professions:
- `manager`: full access
- `operative`: read-only + can report maintenance faults
- `ex_inspector`: can edit site/zone/equipment; full inspection access; can only report maintenance faults
- `technician`: can edit site/zone/equipment; full maintenance access; cannot manage inspections (read-only)

### Tenants
- GET `/api/tenants`
- GET `/api/tenants/:id`
- GET `/api/tenants/search`
- POST `/api/tenants`
- PATCH `/api/tenants/:id`
- DELETE `/api/tenants/:id`

### Notifications
- GET `/api/notifications/stream` (SSE, token via `?token=...`)
- GET `/api/notifications`
- POST `/api/notifications/:id/read`
- POST `/api/notifications/read-all`
- DELETE `/api/notifications/:id`

### Billing
- POST `/api/billing/checkout`
- POST `/api/billing/portal`
- GET `/api/billing/portal/return`
- GET `/api/billing/invoices`
- POST `/api/billing/free-next-invoice`
- POST `/api/billing/update-quantity`
- POST `/api/billing/grant-credit`
- POST `/api/billing/pause`
- POST `/api/billing/resume`
- POST `/api/billing/grant-manual-license`
- POST `/api/billing/revoke-manual-license`
- POST `/api/stripe/webhook` (raw body)

### Metrics / Analytics / Summaries
- GET `/api/combined-statistics`
- GET `/api/health-metrics`
- GET `/api/status-stacked-summary`
- GET `/api/maintenance-severity-summary`
- GET `/api/root-causes/maintenance`
- GET `/api/root-causes/compliance`
- GET `/api/dashboard-analytics`
- GET `/api/dashboard-settings/sla-targets`
- PUT `/api/dashboard-settings/sla-targets`
- GET `/api/planned-inspections`

### Consent
- POST `/api/consent`

### Mail
- POST `/api/mail/send`

### Downloads
- GET `/api/downloads/yearbook-2026`

### Microsoft Graph (OneDrive/SharePoint)
- GET `/api/graph/onedrive`
- POST `/api/graph/onedrive/upload`
- POST `/api/graph/onedrive/folder`
- DELETE `/api/graph/onedrive/item/:itemId`
- PATCH `/api/graph/onedrive/item/:itemId`
- GET `/api/graph/sharepoint`
- POST `/api/graph/sharepoint/upload`
- POST `/api/graph/sharepoint/folder`
- DELETE `/api/graph/sharepoint/item/:itemId`
- PATCH `/api/graph/sharepoint/item/:itemId`
- PATCH `/api/graph/sharepoint/move`

### Mobile Sync
- POST `/api/mobile/sync` (multipart)
- GET `/api/mobile/sync/:jobId/status`
- GET `/api/mobile/deletions`

### Upgrade
- POST `/api/upgrade-to-team`

Note: Some endpoints are tenant- or plan-gated. See the corresponding controller in `controllers/` for exact behavior.
