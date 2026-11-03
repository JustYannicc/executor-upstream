# OAuth account deletion race

Run this proof from a disposable checkout with the usual E2E prerequisites and Docker available:

```sh
bun run e2e:prepare
node e2e/proofs/oauth-removal/prove.ts
```

The wrapper invokes the existing managed Cloud suite with one worker. It temporarily instruments the native SQL transaction client, passes its loopback gate address to the test worker, then restores those files. Run it alone in its checkout. No production endpoint or runtime hook is added.

The scenario completes OAuth through the public connection API with a 20-second token. Native webhook reconciliation then renews that account. The proof pauses renewal before its first account update and starts a public DELETE. It waits until DELETE has claimed the account, then releases both operations.

With the old order, renewal already holds the grant while DELETE holds the account. PostgreSQL detects the actual cycle. A transaction-local `deadlock_timeout` chooses DELETE as the victim without injecting an error. With account-first settlement, renewal holds neither row at that pause, so DELETE completes and the resumed renewal observes removal.

The assertions require DELETE 200, a committed background settlement, no account or grant row, and exactly one authenticated refresh-token revocation.

## Recorded demo

A native reference run on a downstream integration returned DELETE 500 with the old order. The same regression passed with account-first settlement in 2262 ms, including every assertion above. This upstream port has not yet been run end to end. The command above reproduces it against this branch.

The scenario is excluded from ordinary CI selection because it requires the disposable SQL gates. Running the scenario directly without this wrapper fails with the required command.
