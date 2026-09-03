# Contributing to Revenue OS

Thanks for helping improve Revenue OS. Contributions should preserve its evidence-first, non-custodial, and fail-closed design.

## Before opening a change

Use a GitHub issue to describe substantial features or behavior changes before implementation. For security vulnerabilities, do not open a public issue; follow [SECURITY.md](SECURITY.md).

Good contributions are narrowly scoped, explain the user-visible behavior, and include validation appropriate to the risk. Changes involving authentication, payment verification, RPC trust, database transactions, or lead-source boundaries need tests for both success and failure paths.

## Local setup

Requirements are Node.js 22 or newer and npm.

```bash
./setup.sh
npm run check
```

The setup script creates `.dev.vars` only from the placeholder template. Replace placeholders locally when needed and never commit `.dev.vars`, credentials, private RPC URLs, customer records, wallet addresses, or production evidence.

## Development workflow

1. Create a focused branch from the current default branch.
2. Make the smallest maintainable change that solves the issue.
3. Add or update targeted tests for behavioral changes.
4. Run the complete validation set:

   ```bash
   npm run check
   npm run test:coverage
   npm run build
   npm audit --audit-level=low
   ```

5. Review the diff for secrets, personal information, private infrastructure, and generated state.
6. Open a pull request describing the problem, solution, risks, and validation evidence.

Do not commit `node_modules`, Wrangler state, coverage output, local databases, logs, `.dev.vars`, `.env` files, keys, tokens, or seed phrases.

## Code expectations

- Use ESM and the existing dependency-light JavaScript style.
- Keep external input validation at the system boundary.
- Preserve integer arithmetic for money and token units.
- Preserve RPC quorum checks and failure-closed behavior.
- Keep database changes migration-based and transactionally consistent.
- Avoid automatic outreach, wallet custody, signing, or fund-transfer features.
- Return generic external errors while retaining testable internal error codes.
- Prefer explicit functions and small modules over broad abstractions.

## Tests and review

Unit tests live in `test/` and use Node's built-in test runner. Payment and RPC changes should cover disagreement, malformed responses, insufficient confirmations, replay, and idempotency. Database changes should cover trigger and uniqueness behavior.

Pull requests may be declined when they weaken authorization, accept ambiguous payment evidence, add hidden network access, introduce unexplained dependencies, or expand the project into custody or transaction signing.

## Licensing

By submitting a contribution, you agree that it may be distributed under the repository's [MIT License](LICENSE). Do not submit code or content that you do not have permission to license.
