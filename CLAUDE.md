# Revenue OS contributor guide

## Purpose and boundaries

Revenue OS is a Cloudflare Worker backed by D1. It discovers evidence-backed public GitHub leads, enforces a sales lifecycle, creates non-custodial ERC-20 invoices, verifies transfers through an EVM RPC quorum, and records allocations.

The application must not hold private keys, sign or send transactions, move funds, automatically contact leads, or count unverified transfers as revenue. Preserve failure-closed behavior across every payment and authorization path.

## Commands

```bash
./setup.sh                         # install, create placeholder-only .dev.vars, migrate local D1
npm run dev -- --test-scheduled --ip 127.0.0.1
npm run db:migrate:local
npm run check                     # syntax check + complete Node test suite
npm run test:coverage             # suite with 80% line/branch/function thresholds
npm run build                     # Wrangler dry-run build
npm audit --audit-level=low
```

Use `npm ci --ignore-scripts` for deterministic clean installs. Never run deployment, remote migration, account-login, or GitHub publication commands without explicit authorization.

## Architecture

- `src/index.js`: Worker entry point, runtime configuration loading, HTTP routing, request validation, and scheduled discovery.
- `src/config.js`: bounded JSON parsing, public-HTTPS validation, and chain/source allowlists.
- `src/discovery.js`: bounded GitHub issue retrieval and lead persistence.
- `src/leads.js`: GitHub issue normalization, exclusions, budget extraction, and scoring.
- `src/lifecycle.js`: allowed lead states and transitions.
- `src/auth.js`: constant-time token checks and HMAC-derived invoice IDs/capabilities.
- `src/payment.js`: strict ERC-20 transfer and receipt validation.
- `src/rpc.js`: chain, metadata, receipt, canonical-block, and confirmation quorum.
- `src/allocation.js`: exact USD-cent allocation by basis points.
- `src/store.js`: D1 persistence and atomic payment-ledger writes.
- `migrations/`: schema, uniqueness constraints, lifecycle triggers, and audit events.
- `test/`: built-in Node test suite with a D1-compatible SQLite fixture.
- `wrangler.jsonc`: Worker, Cron, and D1 binding configuration; the checked-in database ID is a placeholder.

Request flow:

```text
request -> validate/authenticate -> domain rule -> D1 store -> bounded JSON response
cron -> allowed GitHub search -> normalize/score -> D1 upsert
invoice -> token metadata quorum -> D1 insert
tx hash -> payment RPC quorum -> atomic payment/allocation/status/audit batch
```

## Change rules

- Validate external input before domain or storage operations.
- Use integer cents and `BigInt` token amounts; never use floating-point money math.
- Never assume token decimals. Verify them through the configured quorum.
- Require exact chain, contract, payer, recipient, amount, log, canonical block, and confirmation matches.
- Keep source URLs credential-free, HTTPS-only, bounded, and allowlisted.
- Maintain idempotency and replay-prevention constraints.
- Do not expose internal RPC, database, or parsing errors in API responses.
- Add migrations instead of editing an already-deployed schema in place.
- Keep new dependencies exceptional and explain their security/maintenance cost.
- Add targeted tests for new behavior and regression cases.

## Validation and security review

Before finalizing a change, run `npm run check`, `npm run test:coverage`, `npm run build`, and `npm audit --audit-level=low`. Then inspect the diff for credentials, private addresses, customer data, absolute local paths, generated artifacts, and weakened trust checks.

For changes touching auth, invoice capabilities, RPC verification, payment recognition, migrations, or outbound fetches, explicitly review malformed input, replay, concurrency, provider disagreement, sensitive-error leakage, and denial-of-service bounds.
