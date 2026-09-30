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

## Deploy to AWS Lambda

The Lambda handler accepts Function URL / API Gateway HTTP API payload version 2.0
events. [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
and AWS credentials are needed to deploy. From the project root:

```bash
npm run build:lambda
sam build
sam deploy --guided
```

During guided deployment, choose a stack name and region, allow IAM role creation,
and enter a new `SessionSecret` of at least 32 characters. Generate one with
`openssl rand -hex 32`. Answer **No** when asked to save deployment arguments,
so the secret is not written to `samconfig.toml`. Both SAM config formats are
also gitignored.
The stack output `ViewerUrl` is the HTTPS URL. The URL is publicly reachable;
users still need their own Grafana credentials to access the app. The Lambda
function needs outbound HTTPS access to Grafana. If your Grafana endpoint is
private, configure network access in AWS before deploying.

`npm run build:lambda` stages only `server.js`, `lambda.js`, and `public/` in
`dist/lambda/`. Local `.env` files and dependencies used only by the local
server are excluded. Rebuild with `npm run build:lambda && sam build` before
each later `sam deploy --guided`. Set `GrafanaUrl` and `LokiDatasourceUid` parameters
if the defaults differ. The login throttle is per warm Lambda instance, so it
is not a global rate limit; put a shared rate limit in front of this URL if
that is required for your deployment.

## Login

Each person signs in with **their own Grafana username and password**, the same ones they use for grafana.rupeek.com. There are no shared credentials on the server.

- The server checks the credentials with Grafana's `GET /api/user`. A wrong password gives "Invalid username or password".
- On success the credentials go into an **AES-256-GCM encrypted cookie** keyed by `SESSION_SECRET`. The cookie is `HttpOnly`, `SameSite=Strict`, `Secure` over HTTPS, and lasts 12 h. Page JavaScript can never read it.
- Every Loki query runs as that user, so Grafana's permissions apply. If Grafana later rejects the credentials (for example after a password change), the user is signed out.
- Login attempts are limited to 10 per IP per 5 minutes.
- Users who sign in to Grafana only through Google/SSO have no Grafana password, so they can't use this login.
- Changing `SESSION_SECRET` signs everyone out.

Deep link: `http://localhost:4747/?id=<loanRequestId>`. If you're signed out, the loan loads right after you log in.

## Apps

Choose the source in the header, or with `?app=` in the URL:

| App | Journey | Stages |
|---|---|---|
| `lmApp` | Loan disbursal | 13 stages, from Pick & Arrive to Vault & Checkout |
| `rmApp` | Gold release (doorstep `rlagent/*` or branch `branchrelease/*`) | Start & Arrive → Customer Auth (OTP) → Release Scope → Customer Verification → Release Approval → Packet Verification → Checkout → Documents Handover |

Both apps are searched by loanRequestId. A stage the flow never used but went past (for example Customer Verification in a branch release) shows as **skipped**. A stage whose last call failed counts as **recovered**, not failed, if the journey carried on afterwards.

To add another app, add an entry to `APPS` in `server.js` and an `<option>` to `#src` in `public/index.html`.

## Tuning stages

Stages are regexes on the API path in `server.js` (`LM_STAGES`, `RM_STAGES`). Calls matching `CONTEXT_RE` or `STATUS_RE`
(getactivetransactions, flagsmith, `/status/{id}`) are treated as context and hidden by default.

## Backend service logs

Expand any call to see the logs of the backend service that handled it. Failed calls (4xx/5xx) load them automatically.

- The API path prefix maps to a Loki app (`SERVICE_APPS` in `server.js`): rpkweb→rupeekwebsvc, coresvc, titans, andromeda, referralproxy, coreproxy, heimdall→heimdallapi, collaterals→collateralsapi.
- Calls with a trace ID (`traceparent` / `x-trace-id`) match exactly on it. Calls without one (andromeda, collaterals, heimdall) match on the loanRequestId from 60 s before to 10 s after the call.
- **Search all services** runs `{namespace="logistics"} |= "<traceId>"` over the same window. Clicking any trace ID in a log line follows that trace across services.
- JWT and Bearer tokens are hidden server-side. Lines are cut at 4 KB, and at most 500 lines are returned per search.
