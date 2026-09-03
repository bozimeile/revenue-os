# Revenue OS

An evidence-first control plane for turning public opportunities into non-custodial ERC-20 invoices on Cloudflare Workers and D1.

Revenue OS discovers public GitHub issues, scores and stores evidence, enforces a sales lifecycle, creates exact-token invoices, verifies transfers through an RPC quorum, and records payment allocations atomically. It never holds wallet keys, signs transactions, moves funds, or sends outreach automatically.

> **Status:** pre-1.0 reference implementation. Self-hosters are responsible for validating every chain, token, RPC endpoint, recipient address, and compliance requirement before production use. This software cannot guarantee customers, awards, revenue, token value, or profit.

## Why Revenue OS

- Evidence stays attached to every discovered lead.
- Sales stages are explicit and invalid transitions are rejected.
- Linked invoices can only be opened for contracted leads.
- Invoice amounts use integer token units, not floating-point arithmetic.
- Payment verification fails closed when RPC providers disagree.
- Only confirmed transfers are counted as revenue.
- Funds remain in a wallet controlled outside this application.

## Architecture

```text
Cloudflare Cron
      |
      v
GitHub issue search -> validate + score -> D1 leads
                                           |
                                           v
                              approved sales lifecycle
                                           |
                                           v
Admin API -> exact ERC-20 invoice -> customer wallet transfer
                                           |
                                           v
                          independent EVM RPC quorum
                                           |
                                           v
                         D1 payment + allocation ledger
```

The lifecycle is:

```text
new -> qualified -> drafted -> approved -> sent -> replied -> proposal
    -> contracted -> invoice_open -> paid -> delivering -> delivered -> closed
```

Terminal paths include `disqualified`, `no_response`, `lost`, and `expired`. D1 triggers require a linked lead to be `contracted` before invoice creation and move it to `invoice_open` in the same database operation.

## Quick start

Requirements:

- Node.js 22 or newer
- npm
- A Unix-like shell for `setup.sh`

```bash
git clone https://github.com/bozimeile/revenue-os.git
cd revenue-os
./setup.sh
npm run dev -- --test-scheduled --ip 127.0.0.1
```

`setup.sh` installs locked dependencies, copies the checked-in placeholder configuration to `.dev.vars` only when that file does not exist, and applies the local D1 migrations. It never generates credentials or overwrites local configuration.

Check the service:

```bash
curl --request GET 'http://127.0.0.1:8787/health'
```

Trigger local scheduled discovery:

```bash
curl --request GET 'http://127.0.0.1:8787/__scheduled?cron=0+1+*+*+*'
```

The example values are intentionally non-production placeholders. Before calling authenticated routes, replace both example tokens in `.dev.vars` with independent values of at least 32 random characters. Never commit `.dev.vars`.

## Configuration

| Variable | Required | Purpose |
|---|---:|---|
| `ADMIN_TOKEN` | Yes | Bearer token for administrative routes; minimum 32 characters |
| `INVOICE_TOKEN_SECRET` | Yes | HMAC key used to derive per-invoice capability tokens |
| `PAYMENT_CONFIG_JSON` | Yes | Allowed chains, RPC quorum, ERC-20 contracts, recipients, decimals, and confirmation thresholds |
| `ALLOCATION_POLICY_JSON` | Yes | Allocation buckets totaling exactly 10,000 basis points |
| `LEAD_SOURCES_JSON` | Yes | Up to five allowed GitHub issue searches and score/budget thresholds |
| `GITHUB_TOKEN` | No | Raises GitHub API limits; use a least-privilege token |

See [.dev.vars.example](.dev.vars.example) for the schema and [PAYMENT_CONFIGURATION.md](PAYMENT_CONFIGURATION.md) for the production checklist. The sample chain, RPC hosts, addresses, and credentials are not operational.

Generate local development secrets only after reviewing the template:

```bash
openssl rand -hex 32
```

## API

| Method | Path | Authentication | Purpose |
|---|---|---|---|
| `GET` | `/health` | None | Health check |
| `GET` | `/v1/leads?status=new&limit=50` | Admin Bearer | List evidence-backed leads |
| `PATCH` | `/v1/leads/{id}/status` | Admin Bearer | Optimistic lifecycle transition |
| `POST` | `/v1/invoices` | Admin Bearer + `Idempotency-Key` | Create an exact ERC-20 invoice |
| `GET` | `/v1/invoices/{id}` | `X-Invoice-Token` | Read one invoice |
| `POST` | `/v1/invoices/{id}/verify` | `X-Invoice-Token` | Submit a transaction hash for verification |
| `GET` | `/v1/revenue` | Admin Bearer | Summarize verified receipts only |

Invoice creation template (replace every placeholder, including an expiry within 30 days):

```bash
curl --request POST 'http://127.0.0.1:8787/v1/invoices' \
  --header 'Authorization: Bearer REPLACE_ADMIN_TOKEN' \
  --header 'Idempotency-Key: example-invoice-001' \
  --header 'Content-Type: application/json' \
  --data '{"leadId":null,"offerCode":"reliability_diagnostic","amountUsdCents":137500,"chainId":46630,"tokenSymbol":"USDC","payerAddress":"0x2222222222222222222222222222222222222222","expiresAt":"REPLACE_WITH_ISO_TIMESTAMP_WITHIN_30_DAYS"}'
```

Production sales should reach `contracted` before an invoice is created with that lead's ID. `leadId: null` is an explicit administrative compatibility path for pre-existing customers and local demonstrations.

## Payment integrity

The implementation includes:

- an allowlist for chain IDs, token contracts, recipients, and HTTPS RPCs;
- runtime `decimals()` checks through the configured quorum, cached by chain and contract for 24 hours;
- exact matching of chain, transaction success, token, payer, recipient, amount, transfer log, canonical block, and confirmation depth;
- configurable agreement across one to three RPC endpoints;
- idempotent invoice IDs and request fingerprints;
- a unique `(chain_id, tx_hash, log_index)` constraint against transfer replay;
- atomic D1 writes for the payment, allocation ledger, invoice status, and audit event;
- no revenue recognition for pending, failed, mismatched, or under-confirmed transfers.

The application cannot infer whether an allowlisted chain is a test network. Keep test and production configurations and D1 databases separate so test transfers cannot enter a production ledger.

Different hostnames do not prove independent infrastructure. Confirmation thresholds are operational policy, not absolute finality, and L2 confirmations may not prove parent-chain finality. Review the full [threat model](THREAT_MODEL.md).

## Lead-discovery boundaries

Discovery accepts only credential-free GitHub issue-search URLs over HTTPS. Responses and item counts are bounded. Bot-authored entries, mirrors, internal roadmaps, unsupported security research, low-budget work, and high-risk requests are filtered before storage.

The scheduler only discovers and records leads. It does not message anyone, register accounts, submit applications, make commitments, deploy software, or spend money.

## Development

```bash
npm ci --ignore-scripts
npm run db:migrate:local
npm run check
npm run test:coverage
npm run build
npm audit --audit-level=low
```

Tests use a local D1-compatible adapter and mocked RPC responses. A green suite proves the checked-out behavior only; it is not evidence of a deployment, a live RPC quorum, wallet control, or received revenue.

## Deploying to Cloudflare

Deployment is intentionally manual:

1. Run `wrangler login` with the intended Cloudflare account.
2. Create D1 with `wrangler d1 create revenue-os` and replace the all-zero database ID in `wrangler.jsonc`.
3. Store production values with `wrangler secret put`; do not put them in tracked files.
4. Apply migrations with `wrangler d1 migrations apply revenue-os --remote`.
5. Validate authentication, lifecycle, test-network payment, RPC disagreement, reorg, replay, and failure paths at a non-public test URL.
6. Deploy only after reviewing [SECURITY.md](SECURITY.md), [THREAT_MODEL.md](THREAT_MODEL.md), and the payment checklist.

The configured Cron runs at UTC 01:00 on weekdays. Adjust it deliberately; Cloudflare Cron schedules use UTC.

## Project policies

- Contributions: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reports: [SECURITY.md](SECURITY.md)
- License: [MIT](LICENSE), copyright 2026 Bozimeile

Publishing this repository does not deploy infrastructure, create production secrets, configure a payment recipient, contact leads, or move funds. Those remain explicit operator actions outside the source release.
