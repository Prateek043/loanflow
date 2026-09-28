# Loan Journey Viewer

Enter a `loanRequestId` to see its journey through the LM app:

- **Funnel**: 13 disbursement stages, each colour-coded (success, recovered after a failure, failed, not reached), plus a Gantt bar showing where the time went.
- **API pipeline**: every lmApp API call in order, with the full request and response, trace IDs and cURL copy. Polling calls are grouped, idle gaps are marked, and backward writes are flagged as possible restorations.

Data source: Loki-prod via Grafana, `{app="lmApp"} |= "<loanRequestId>"`.

## Run

```bash
npm install
cp .env.example .env   # set SESSION_SECRET (openssl rand -hex 32)
npm start              # → http://localhost:4747
```

## Deploy to Vercel

The Vercel function in `api/index.js` serves the page and API through the same
handler as the local server. `vercel.json` includes the page in the function bundle.

```bash
npx vercel login
npx vercel link
npx vercel env add SESSION_SECRET production
npx vercel --prod
```

Set `SESSION_SECRET` to a long random value (for example, generate one with
`openssl rand -hex 32`). Add `GRAFANA_URL` and `LOKI_DS_UID` in Vercel if you need
to override their defaults. Local `.env` files are excluded from deployments.
The deployed function must be able to reach Grafana to sign in and query logs.
The login throttle is held in memory per function instance.

## Login

Each person signs in with **their own Grafana username and password**, the same ones they use for grafana.rupeek.com. There are no shared credentials on the server.

- The server checks the credentials with Grafana's `GET /api/user`. A wrong password gives "Invalid username or password".
- On success the credentials go into an **AES-256-GCM encrypted cookie** keyed by `SESSION_SECRET`. The cookie is `HttpOnly`, `SameSite=Strict`, `Secure` over HTTPS, and lasts 12 h. Page JavaScript can never read it.
- Every Loki query runs as that user, so Grafana's permissions apply. If Grafana later rejects the credentials (for example after a password change), the user is signed out.
- Login attempts are limited to 10 per IP per 5 minutes.
- Users who sign in to Grafana only through Google/SSO have no Grafana password, so they can't use this login.
- Changing `SESSION_SECRET` signs everyone out.

Deep link: `http://localhost:4747/?id=<loanRequestId>`. If you're signed out, the loan loads right after you log in.

## Tuning stages

Stages are regexes on the API path in `server.js` (`STAGES`). Calls matching `CONTEXT_RE` or `STATUS_RE`
(getactivetransactions, flagsmith, `/status/{id}`) are treated as context and hidden by default.

## Backend service logs

Expand any call to see the logs of the backend service that handled it. Failed calls (4xx/5xx) load them automatically.

- The API path prefix maps to a Loki app (`SERVICE_APPS` in `server.js`): rpkweb→rupeekwebsvc, coresvc, titans, andromeda, referralproxy, coreproxy, heimdall→heimdallapi, collaterals→collateralsapi.
- Calls with a trace ID (`traceparent` / `x-trace-id`) match exactly on it. Calls without one (andromeda, collaterals, heimdall) match on the loanRequestId from 60 s before to 10 s after the call.
- **Search all services** runs `{namespace="logistics"} |= "<traceId>"` over the same window. Clicking any trace ID in a log line follows that trace across services.
- JWT and Bearer tokens are hidden server-side. Lines are cut at 4 KB, and at most 500 lines are returned per search.
