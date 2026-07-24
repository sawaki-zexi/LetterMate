# LetterMate

LetterMate is a responsive workspace for monitoring topics, grouping reports into events, showing the evidence behind trust decisions, and notifying users about confirmed high-priority events.

## Phase-one status

This branch contains the executable phase-one foundation:

- React event feed, monitor rules, evidence detail, notifications, source status, settings, and browser service worker;
- NestJS `/api/v1` vertical slice with authenticated-user repository boundaries and deterministic local seed data;
- framework-free matching, URL normalization, evidence trust, status-transition, and notification rules;
- worker collector policy, response limits, retry rules, fingerprinting, and AI-degradation behavior;
- Prisma PostgreSQL schema, PostgreSQL/Redis local Compose services, and desktop/tablet/mobile Playwright acceptance tests.

The HTTP app currently uses the deterministic in-memory repository so the full UI can be tried without external credentials. The Prisma model is ready for the database adapter; real source collectors, VAPID delivery, production sessions, migrations, and deployment remain integration work and must not be represented as live external delivery.

## Local development

Requirements: Node.js 24+, npm 11+, and optionally Docker Desktop.

```powershell
npm install
Copy-Item .env.example .env
docker compose -f infra/compose.yaml up -d
npm run dev
```

Open `http://localhost:5173`. The Vite server proxies `/api` to `http://localhost:3000`.

## Verification

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Playwright runs the acceptance workflow at desktop, tablet, and mobile viewports. Install Chromium once with `npx playwright install chromium` if it is not already available.

## Compliance boundary

Only sources whose stored compliance state is `allowed` and whose policy permits the requested path may be scheduled. The worker blocks local/private literal addresses, non-HTTP protocols, oversized responses, and redirects to blocked addresses. A production transport must additionally resolve every hostname and re-check all returned IP addresses before each connection to prevent DNS rebinding.
