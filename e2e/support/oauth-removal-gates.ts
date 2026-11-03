import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

/** The disposable wrapper supplies the SQL gates; no product endpoint or deployed hook exists. */
export const oauthRemovalBoundary = (step: "renewal" | "delete", id: string) =>
  Effect.gen(function* () {
    const origin = process.env.EXECUTOR_OAUTH_REMOVAL_GATE;
    if (origin === undefined) return yield* Effect.die("Run e2e/proofs/oauth-removal/prove.ts");
    const request = (action: string) => {
      const url = new URL(`/${action}`, origin);
      url.searchParams.set("step", step);
      url.searchParams.set("id", id);
      return HttpClient.execute(HttpClientRequest.post(url)).pipe(
        Effect.provide(FetchHttpClient.layer),
      );
    };
    const release = request("release").pipe(
      Effect.flatMap((response) =>
        response.status === 204 ? Effect.void : Effect.die("Gate release refused"),
      ),
    );
    const armed = yield* request("arm");
    if (armed.status !== 204) return yield* Effect.die("Gate arm refused");
    yield* Effect.addFinalizer(() => release.pipe(Effect.orDie));
    const read = <A>(action: string, schema: Schema.Codec<A>) =>
      request(action).pipe(
        Effect.flatMap((response) => response.json),
        Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      );
    return {
      entered: read("entered", Schema.Struct({ account: Schema.String })),
      settled: read("settled", Schema.Struct({ committed: Schema.Boolean })),
      release,
    };
  });
