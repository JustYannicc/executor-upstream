# Discarded OAuth renewal tokens

Run these proofs from a disposable checkout with the usual E2E prerequisites and Docker available:

```sh
bun run e2e:prepare
node e2e/proofs/oauth-discard/prove.ts
```

The wrapper invokes the existing managed Cloud suite with one worker. It temporarily observes native SQL settlement and background completion, passes its loopback gate address to the test worker, then restores those files. Run it alone in its checkout. No production endpoint or runtime hook is added.

The issuer rotates a refresh token. The proof pauses the native renewal after the issuer responds but before settlement reads or locks the account. The public API then either deletes the account or reconnects it with a different client. After releasing renewal, the proof drains native work before checking exact revocation counts.

Deletion must revoke the removed grant's refresh token and both tokens from the discarded response, three requests in total. Reconnect must revoke only the discarded response's refresh and access tokens, two requests. Every discarded token uses the client that requested it. The replacement grant must remain byte-for-byte unchanged and usable through a public tool call.

## Recorded demo

Native reference runs on a downstream integration produced these outcomes:

| Case           | Refresh-only cleanup                          | Independent cleanup                         |
| -------------- | --------------------------------------------- | ------------------------------------------- |
| Deletion wins  | Two revocations, access-token assertion fails | Three revocations, passes                   |
| Reconnect wins | One revocation, access-token assertion fails  | Two revocations, replacement remains usable |

Both fixed cases passed again in a later run, 2231 ms for deletion and 1919 ms for reconnect. A separate control made every revocation endpoint return HTTP 503. Both cases still passed with exactly three and two attempts, and five sanitized failure warnings. No retry was added.

These are reference results, not execution of this upstream port. The command above remains to be run against this branch. To repeat the failed-issuer control, temporarily change the scenario's `revocation: "recorded"` to `revocation: "failing"`, run the same command, then restore it.

The scenarios are excluded from ordinary CI selection because they require the disposable gates. Running them directly without this wrapper fails with the required command.
