# Payment Configuration Guide

This repository does not include a live payment configuration, recipient address, private RPC credential, or proof of wallet control. `.dev.vars.example` contains non-production placeholders only.

## Required configuration

Set `PAYMENT_CONFIG_JSON` as a Cloudflare secret. For every enabled chain, provide:

- the expected chain ID;
- one to three HTTPS RPC endpoints, preferably from independent operators;
- an RPC quorum that does not exceed the endpoint count;
- the intended ERC-20 contract and symbol;
- a recipient address controlled by the deployer;
- token decimals and a deliberately selected confirmation threshold.

Never copy a recipient address from documentation. Confirm it in the wallet UI and use a signed message or another non-transaction proof of control before accepting payment. Do not share a private key, seed phrase, password, or authentication token.

## Verification behavior

Invoice creation reads `decimals()` through the configured RPC quorum and rejects a value that disagrees with configuration. Payment verification fails closed unless the quorum agrees on the chain, receipt, canonical block, transfer log and confirmation depth.

The configured confirmation count is an operational threshold, not an absolute finality guarantee. L2 confirmations may not prove parent-chain finality. Public RPC endpoints may be rate-limited, unavailable or backed by a shared upstream even when they use different hostnames.

## Deployment checklist

1. Obtain the token contract from the issuer's official documentation on the day of deployment.
2. Verify the chain ID and `decimals()` independently.
3. Confirm recipient ownership outside this application.
4. Exercise success, RPC disagreement, reorg, underpayment and replay paths on a test network.
5. Store the final JSON only as a deployment secret.
6. Recheck all values immediately before enabling a production chain.

For USDC, start with Circle's official contract directory: https://developers.circle.com/stablecoins/usdc-contract-addresses
