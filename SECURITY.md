# Security Policy

Revenue OS sits on a public HTTP boundary and processes payment evidence. Treat every deployment as security-sensitive even though the application does not hold keys or move funds.

## Supported versions

Security fixes are provided for the latest code on the default branch. Pre-1.0 tags may receive fixes only when explicitly announced by the maintainer.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for `bozimeile/revenue-os`:

`https://github.com/bozimeile/revenue-os/security/advisories/new`

If private reporting is not yet enabled, open a minimal public issue asking the maintainer to establish a private channel. Do not include exploit details, secrets, customer data, wallet information, or a proof of concept in that issue.

Include, when safe:

- affected version or commit;
- impacted route or component;
- prerequisites and expected impact;
- minimal reproduction steps using local fixtures or a test network;
- a suggested mitigation, if available.

Do not test against production deployments, third-party wallets, mainnet funds, customer data, or infrastructure you do not own or have explicit permission to assess. Do not request or submit private keys, seed phrases, credentials, or live bearer tokens.

The maintainer will acknowledge reports when practical, assess severity, coordinate a fix, and credit reporters who request attribution. This project does not currently promise a bounty, response deadline, embargo duration, or payment.

## Deployment responsibilities

Before production use:

- generate independent, high-entropy admin and invoice secrets;
- store secrets with the deployment platform rather than tracked files;
- add Cloudflare Access or equivalent protection and rate limiting to admin routes;
- verify every chain, token contract, decimal count, recipient, and RPC operator independently;
- prove recipient control outside this application without sharing wallet secrets;
- test reorg, RPC disagreement, underpayment, replay, and failure paths on a test network;
- establish backup, recovery, incident-response, refund, dispute, accounting, and compliance procedures.

See [THREAT_MODEL.md](THREAT_MODEL.md) and [PAYMENT_CONFIGURATION.md](PAYMENT_CONFIGURATION.md) for known trust boundaries and residual risks.
