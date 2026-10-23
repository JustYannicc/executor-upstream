/** An API token is sufficient; a personal access token also needs an organization id. */
import { Config, Effect, Option, Redacted } from "effect";

export interface AxiomSettings {
  readonly token: Redacted.Redacted<string>;
  readonly organizationId?: string;
}

export interface AxiomSessionQuerySettings extends AxiomSettings {
  readonly organizationId: string;
}

/** The session-retirement check needs an org-scoped token, so API tokens cannot query it. */
export const axiomSessionQuerySettings = (
  settings: AxiomSettings,
): Option.Option<AxiomSessionQuerySettings> =>
  settings.organizationId === undefined
    ? Option.none()
    : Option.some({ token: settings.token, organizationId: settings.organizationId });

/** Empty settings disable Axiom. An organization id without a token is invalid. */
export const axiomSettings = Effect.gen(function* () {
  const token = yield* Config.Redacted("AXIOM_TOKEN").pipe(
    Config.option,
    Effect.map(Option.filter((value) => Redacted.value(value) !== "")),
  );
  const organizationId = yield* Config.String("AXIOM_ORG_ID").pipe(
    Config.option,
    Effect.map(Option.filter((value) => value !== "")),
  );
  if (Option.isNone(token)) {
    if (Option.isSome(organizationId))
      return yield* Effect.die(new Error("AXIOM_ORG_ID requires AXIOM_TOKEN"));
    return Option.none();
  }
  return Option.some({
    token: token.value,
    ...(Option.isSome(organizationId) ? { organizationId: organizationId.value } : {}),
  });
});
