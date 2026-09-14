# T3N Funded Opportunity Trust Agent

A small, deployable agent-side trust gate for online revenue opportunities.

## What it demonstrates

- Terminal 3 sandbox session initialization with `@terminal3/t3n-sdk`
- wallet-derived T3N authentication using a backend-only `T3N_API_KEY`
- a public, redacted proof endpoint that never returns the raw key
- a deterministic opportunity policy that rejects unfunded, deceptive, physical-action, unsupported-identity, or unpermissioned work
- scoring by funded value per irreducible human-checkpoint minute

## Run

```bash
npm install
T3N_API_KEY=... npm start
```

Then open:

- `GET /health`
- `GET /proof`
- `POST /assess`

Example assessment:

```bash
curl -sS -X POST http://localhost:3000/assess \
  -H 'content-type: application/json' \
  -d '{
    "reward": 25,
    "humanMinutes": 5,
    "prefunded": true,
    "payoutRail": "Wise USD",
    "explicitPermission": true
  }'
```

## Security

The API key remains server-side. Errors are scrubbed for key-like values, wallet addresses, and DID values before they are returned. Public proof data is masked.
