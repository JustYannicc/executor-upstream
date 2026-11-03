import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
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
import { oauthDiscardGate } from "../support/oauth-discard-gates.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { scenarios } from "../test-plan.ts";

const rotatingAccount = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    http = yield* HttpClient.HttpClient,
    issuer = yield* oauthSetupIssuer,
    database = yield* cloudLocks,
    evidence = yield* Evidence;
  const prefix = `/api/organizations/${actors.organization.id}`;
  yield* issuer.configure({
    refreshTokens: true,
    rotateRefreshTokens: true,
    expiresIn: 20,
    revocation: "recorded",
  });
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name: `Discarded refresh ${randomUUID().slice(0, 8)}`,
    files: [
      appsManifest,
      {
        path: "index.ts",
        content: `import { defineApp, defineProvider, oauth2, router, query, object } from "apps";
const service=defineProvider({name:"Discarded refresh service",auth:{oauth:oauth2(${JSON.stringify({
          authorizationUrl: issuer.origin + "/authorize",
          tokenUrl: issuer.origin + "/token",
          revocationUrl: issuer.origin + "/revoke",
          scopes: ["read"],
        })})}});
export default defineApp({user:{accounts:{service}}},async({user:{accounts}})=>({tools:router({
  read:query({input:object({})},async({fetch})=>({usable:(await fetch(${JSON.stringify(issuer.origin + "/resource")},{headers:{authorization:"Bearer "+accounts.service.fields.access_token}})).ok})),
})}));`,
      },
    ],
  });
  expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
  const app = yield* body(Resource, deployed);
  yield* Effect.addFinalizer(() =>
    api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
  );
  const client = { clientId: "discard-client", clientSecret: "discard-secret" };
  const connect = (existing?: string, using = client) =>
    Effect.gen(function* () {
      const connection = yield* body(
        Resource,
        yield* api.request(
          actors.owner,
          "POST",
          connectionsPath(`${prefix}/apps/${app.id}`, "user", "service"),
          existing === undefined ? {} : { account: existing },
        ),
      );
      const started = yield* api.request(
        actors.owner,
        "POST",
        `${prefix}/connections/${connection.id}/oauth/start`,
        { method: "oauth", client: using },
      );
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      const redirect = yield* body(
        Schema.Struct({ authorizationUrl: Schema.String, redirectUri: Schema.String }),
        started,
      );
      yield* issuer.allowClient({ ...using, redirect: redirect.redirectUri });
      const callbackUrl = yield* Effect.scoped(
        Effect.gen(function* () {
          const response = yield* HttpClient.withScope(http).get(redirect.authorizationUrl);
          expect(response.status).toBe(302);
          if (response.headers.location === undefined)
            return yield* Effect.die("No OAuth callback returned");
          return response.headers.location;
        }),
      ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
      const completed = yield* api.request(
        actors.owner,
        "POST",
        `${prefix}/connections/${connection.id}/oauth/complete`,
        { callbackUrl },
      );
      expect(completed.status, JSON.stringify(completed.body)).toBe(200);
      return yield* body(Resource, completed);
    });
  const gate = yield* oauthDiscardGate;
  const account = yield* connect();
  expect((yield* gate.entered).account).toBe(account.id);
  expect((yield* issuer.metrics).refreshesIssued).toBe(1);
  const metrics = issuer.metrics.pipe(
    Effect.tap((current) =>
      evidence.json("discarded-refresh-revocations.json", {
        refreshes: current.refreshes,
        refreshesIssued: current.refreshesIssued,
        origins: current.revokedRefreshTokens,
        clients: current.revokedRefreshTokenClients,
        revocations: current.revocations,
      }),
    ),
  );
  return { api, actors, issuer, database, prefix, app, account, gate, client, connect, metrics };
});

layer(HostedLive, { excludeTestServices: true })("Discarded OAuth refresh", (it) => {
  it.effect(scenarios.oauthDiscardedRefresh.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, database, prefix, account, gate, client, metrics } =
          yield* rotatingAccount;
        const deleted = yield* api.request(
          actors.owner,
          "DELETE",
          `${prefix}/accounts/${account.id}`,
        );
        expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
        yield* gate.release;
        yield* gate.drained;
        const current = yield* metrics;
        expect(current.refreshes).toBe(1);
        expect(current.refreshesIssued).toBe(1);
        expect([...current.revokedRefreshTokens].sort()).toEqual(["refresh", "sign-in"]);
        expect(current.revokedRefreshTokenClients).toEqual([
          { issuedTo: client.clientId, presentedBy: client.clientId },
          { issuedTo: client.clientId, presentedBy: client.clientId },
        ]);
        expect(current.revocations).toEqual([
          { token: "refresh", hint: "refresh_token", clientAuthenticated: true },
          { token: "refresh", hint: "refresh_token", clientAuthenticated: true },
          { token: "access", hint: "access_token", clientAuthenticated: true },
        ]);
        for (const table of ["executor_accounts", "executor_oauth_grants"])
          expect(
            yield* database.run({
              sql: `select id from ${table} where id = $1`,
              params: [account.id],
            }),
          ).toEqual([]);
      }),
    ),
  );

  it.effect(scenarios.oauthDiscardedRefreshReconnect.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const {
          api,
          actors,
          issuer,
          database,
          prefix,
          app,
          account,
          gate,
          client,
          connect,
          metrics,
        } = yield* rotatingAccount;
        yield* issuer.configure({ expiresIn: 3600 });
        const replacement = { clientId: "replacement-client", clientSecret: "replacement-secret" };
        expect((yield* connect(account.id, replacement)).id).toBe(account.id);
        const stored = () =>
          database.run({
            sql: "select status, encrypted from executor_oauth_grants where id = $1",
            params: [account.id],
          });
        const before = yield* stored();
        expect(before).toHaveLength(1);
        yield* gate.release;
        yield* gate.drained;
        const current = yield* metrics;
        expect(current.refreshes).toBe(1);
        expect(current.refreshesIssued).toBe(1);
        expect(current.revokedRefreshTokens).toEqual(["refresh"]);
        expect(current.revokedRefreshTokenClients).toEqual([
          { issuedTo: client.clientId, presentedBy: client.clientId },
        ]);
        expect(current.revocations).toEqual([
          { token: "refresh", hint: "refresh_token", clientAuthenticated: true },
          { token: "access", hint: "access_token", clientAuthenticated: true },
        ]);
        expect(yield* stored()).toEqual(before);
        const read = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${app.id}/tools/call`,
          {
            tool: "read",
            input: {},
          },
        );
        expect(read.status, JSON.stringify(read.body)).toBe(200);
        expect(read.body).toEqual({ usable: true });
        expect((yield* metrics).revocations).toEqual(current.revocations);
      }),
    ),
  );
});
