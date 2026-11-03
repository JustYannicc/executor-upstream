import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { connectionsPath } from "../support/app-accounts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { cloudLocks } from "../support/cloud-locks.ts";
import { Resource } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { oauthRemovalBoundary } from "../support/oauth-removal-gates.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { scenarios } from "../test-plan.ts";

const Redirect = Schema.Struct({ authorizationUrl: Schema.String, redirectUri: Schema.String });

layer(HostedLive, { excludeTestServices: true })("OAuth account removal", (it) => {
  it.effect(scenarios.oauthAccountRemoval.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          http = yield* HttpClient.HttpClient;
        const database = yield* cloudLocks,
          evidence = yield* Evidence,
          issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        yield* issuer.configure({ refreshTokens: true, expiresIn: 20, revocation: "recorded" });
        const appResponse = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `OAuth removal ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, oauth2, query, object, router } from "apps";
const service=defineProvider({name:"Removal service",auth:{oauth:oauth2(${JSON.stringify({
                authorizationUrl: `${issuer.origin}/authorize`,
                tokenUrl: `${issuer.origin}/token`,
                revocationUrl: `${issuer.origin}/revoke`,
                scopes: ["read"],
              })})}});
export default defineApp({user:{accounts:{service}}},async()=>({tools:router({read:query({input:object({})},async()=>({ok:true}))})}));`,
            },
            appsManifest,
          ],
        });
        expect(appResponse.status, JSON.stringify(appResponse.body)).toBe(200);
        const app = yield* body(Resource, appResponse);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const connection = yield* body(
          Resource,
          yield* api.request(
            actors.owner,
            "POST",
            connectionsPath(`${prefix}/apps/${app.id}`, "user", "service"),
            {},
          ),
        );
        const client = { clientId: "removal-client", clientSecret: "removal-secret" };
        const started = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/oauth/start`,
          { method: "oauth", label: "Removal evidence", client },
        );
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const redirect = yield* body(Redirect, started);
        yield* issuer.allowClient({ ...client, redirect: redirect.redirectUri });
        const callbackUrl = yield* Effect.scoped(
          Effect.gen(function* () {
            const consent = yield* HttpClient.withScope(http).get(redirect.authorizationUrl);
            expect(consent.status).toBe(302);
            if (consent.headers.location === undefined)
              return yield* Effect.die("No callback returned");
            return consent.headers.location;
          }),
        ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
        const renewing = yield* oauthRemovalBoundary("renewal", "any");
        const completed = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/oauth/complete`,
          { callbackUrl },
        );
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        const account = yield* body(Resource, completed);
        expect((yield* renewing.entered).account).toBe(account.id);
        const removing = yield* oauthRemovalBoundary("delete", account.id);
        const deletion = yield* api
          .request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`)
          .pipe(Effect.forkChild);
        yield* Effect.raceFirst(
          removing.entered,
          Fiber.join(deletion).pipe(
            Effect.flatMap((response) =>
              Effect.die(`DELETE completed before its SQL claim: ${response.status}`),
            ),
          ),
        );
        yield* renewing.release;
        yield* removing.release;
        const deleted = yield* Fiber.join(deletion);
        const settled = yield* renewing.settled;
        yield* evidence.json("oauth-removal-lock-order.json", {
          account: account.id,
          deletionStatus: deleted.status,
          deletionBody: deleted.body,
          backgroundSettlementCommitted: settled.committed,
        });
        expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
        expect(settled.committed).toBe(true);
        expect(
          (yield* api.request(actors.owner, "GET", `${prefix}/accounts/${account.id}`)).status,
        ).toBe(403);
        expect(
          yield* database.run({
            sql: "select id from executor_accounts where id = $1",
            params: [account.id],
          }),
        ).toEqual([]);
        expect(
          yield* database.run({
            sql: "select id from executor_oauth_grants where id = $1",
            params: [account.id],
          }),
        ).toEqual([]);
        yield* issuer.revoked;
        const metrics = yield* issuer.metrics;
        expect(metrics.refreshes).toBe(1);
        expect(metrics.refreshesIssued).toBe(1);
        expect(metrics.revocations).toEqual([
          { token: "refresh", hint: "refresh_token", clientAuthenticated: true },
        ]);
      }),
    ),
  );
});
