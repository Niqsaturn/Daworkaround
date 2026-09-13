# CKPool HTTP Bridge 1.1

A persistent bridge for one specific network boundary:

```text
restricted client -- HTTPS/JSON --> bridge host -- raw TCP Stratum V1 --> CKPool
```

The bridge host owns the long-lived TCP socket. The restricted client never needs permission to open TCP/3333.

## Execution defaults

This build has the payout address requested for the experiment compiled in as the default execution fallback:

```text
bc1qtlqwdh6va8x50ax5nmgt4hq8ca66qsrv9l4k0c
```

`BTC_ADDRESS` can override that value deliberately. The default worker name is `chatgpt`, so the default Stratum username is `<address>.chatgpt`.

The upstream defaults to:

```text
stratum.ckpool.org:3333
```

## The important 1.1 change

The process now starts one **managed default session** automatically. It reconnects with bounded exponential backoff after DNS/connect errors or pool disconnects. That means a cloud runtime can be deployed once and left running while the constrained client uses normal HTTPS.

Default-session API:

```text
GET  /health
GET  /v1/default
GET  /v1/default/events?after=0&wait=20000
POST /v1/default/submit
POST /v1/default/reconnect
```

The original manually-created session API remains available:

```text
POST   /v1/session
GET    /v1/session/:id
GET    /v1/session/:id/events?after=0&wait=20000
POST   /v1/session/:id/submit
DELETE /v1/session/:id
```

## Local run

```bash
npm test
npm start
```

A direct raw-TCP probe is also included and now uses the hardcoded payout address automatically:

```bash
npm run probe
```

If it reports `EAI_AGAIN`/`ENETUNREACH` in a restricted sandbox, that proves the environment—not the Stratum protocol—is the remaining boundary.

## Railway / persistent cloud runtime

This project is intentionally Docker-friendly. A persistent container platform should run the existing `Dockerfile` and expose the service port. The server honors the platform `PORT` environment variable and automatically binds `0.0.0.0` when `RAILWAY_ENVIRONMENT` is present.

Before exposing it publicly, set a strong `BRIDGE_TOKEN`. Clients can send it as:

```text
Authorization: Bearer <token>
```

The bridge will then maintain the CKPool socket while clients use HTTPS only.

## Example flow

Check whether the managed session reached CKPool:

```bash
curl -sS https://YOUR-HOST/health
curl -sS https://YOUR-HOST/v1/default \
  -H "authorization: Bearer $BRIDGE_TOKEN"
```

Long-poll for a new CKPool job:

```bash
curl -sS 'https://YOUR-HOST/v1/default/events?after=0&wait=20000' \
  -H "authorization: Bearer $BRIDGE_TOKEN"
```

Submit a verified share through the exact same upstream Stratum session:

```bash
curl -sS -X POST https://YOUR-HOST/v1/default/submit \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $BRIDGE_TOKEN" \
  -d '{
    "jobId":"...",
    "extranonce2":"00000001",
    "ntime":"01234567",
    "nonce":"89abcdef"
  }'
```

## Tests

```bash
npm test
```

The tests verify both the ordinary persistent session and the new managed auto-reconnect path against a local Stratum mock, including an upstream disconnect followed by successful reconnection and share submission.

## Security

- This is not an arbitrary TCP proxy. The upstream is fixed by process configuration.
- Keep `BRIDGE_TOKEN` enabled on any public deployment.
- Do not put the bearer token in source, chat, URLs, or logs.
- The payout address is public by nature and is intentionally present in this experimental build.
