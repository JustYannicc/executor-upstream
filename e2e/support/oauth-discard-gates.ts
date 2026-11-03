import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

/** The disposable runner observes native work completion as well as settlement's SQL boundary. */
export const oauthDiscardGate = Effect.gen(function* () {
  const origin = process.env.EXECUTOR_OAUTH_DISCARD_GATE;
  if (origin === undefined) return yield* Effect.die("Run e2e/proofs/oauth-discard/prove.ts");
  const request = (action: string) =>
    HttpClient.execute(HttpClientRequest.post(new URL(`/${action}`, origin))).pipe(
      Effect.provide(FetchHttpClient.layer),
    );
  const command = (action: string) =>
    request(action).pipe(
      Effect.flatMap((response) =>
        response.status === 204 ? Effect.void : Effect.die("Discard proof command refused"),
      ),
    );
  yield* command("arm");
  const release = command("release");
  yield* Effect.addFinalizer(() => release.pipe(Effect.orDie));
  return {
    entered: request("entered").pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ account: Schema.String }))),
    ),
    release,
    drained: command("drained"),
  };
});
