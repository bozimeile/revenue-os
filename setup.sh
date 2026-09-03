#!/usr/bin/env bash

set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$PROJECT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js 22 or newer is required." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 22 )); then
  echo "Error: Node.js 22 or newer is required; found $(node --version)." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required." >&2
  exit 1
fi

if [[ ! -f .dev.vars.example || -L .dev.vars.example ]]; then
  echo "Error: .dev.vars.example is missing." >&2
  exit 1
fi

node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";

const content = readFileSync(".dev.vars.example", "utf8");
const values = Object.fromEntries(
  content
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator <= 0) throw new Error("invalid placeholder configuration line");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);

const required = [
  "ADMIN_TOKEN",
  "INVOICE_TOKEN_SECRET",
  "PAYMENT_CONFIG_JSON",
  "ALLOCATION_POLICY_JSON",
  "LEAD_SOURCES_JSON",
];
if (!required.every((name) => Object.hasOwn(values, name))) {
  throw new Error("placeholder configuration is incomplete");
}
if (
  !values.ADMIN_TOKEN.startsWith("replace-") ||
  !values.INVOICE_TOKEN_SECRET.startsWith("replace-")
) {
  throw new Error("refusing to copy a template containing non-placeholder credentials");
}

const payment = JSON.parse(values.PAYMENT_CONFIG_JSON);
if (!Array.isArray(payment.chains) || payment.chains.length === 0) {
  throw new Error("placeholder payment configuration is incomplete");
}
for (const chain of payment.chains ?? []) {
  if (!Array.isArray(chain.rpcUrls) || chain.rpcUrls.length === 0) {
    throw new Error("placeholder payment configuration has no RPC URLs");
  }
  for (const rpcUrl of chain.rpcUrls ?? []) {
    if (!new URL(rpcUrl).hostname.endsWith(".example")) {
      throw new Error("refusing to copy a template containing an operational RPC URL");
    }
  }
  if (!Array.isArray(chain.tokens) || chain.tokens.length === 0) {
    throw new Error("placeholder payment configuration has no tokens");
  }
  for (const token of chain.tokens) {
    if (
      token.address !== "0x1111111111111111111111111111111111111111" ||
      token.recipient !== "0x3333333333333333333333333333333333333333"
    ) {
      throw new Error("refusing to copy a template containing non-placeholder payment addresses");
    }
  }
}
NODE

if [[ -L .dev.vars || ( -e .dev.vars && ! -f .dev.vars ) ]]; then
  echo "Error: .dev.vars exists but is not a regular file." >&2
  exit 1
fi

if [[ ! -e .dev.vars ]]; then
  cp -n .dev.vars.example .dev.vars
  if [[ -L .dev.vars || ! -f .dev.vars ]] || ! cmp -s .dev.vars.example .dev.vars; then
    echo "Error: .dev.vars changed while setup was creating it; refusing to continue." >&2
    exit 1
  fi
  chmod 600 .dev.vars
  echo "Created .dev.vars from verified placeholders; replace them locally before authenticated use."
else
  echo "Preserving existing .dev.vars."
fi

npm ci --ignore-scripts
npm run db:migrate:local

echo "Setup complete. Start the local Worker with:"
echo "  npm run dev -- --test-scheduled --ip 127.0.0.1"
