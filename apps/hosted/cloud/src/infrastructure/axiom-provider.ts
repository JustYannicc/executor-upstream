/** Initialize Axiom's Cloud provider only when both credentials are present. */
import * as Axiom from "alchemy/Axiom";
import { Effect, Layer, Option } from "effect";
import { axiomSettings } from "./axiom-settings.ts";

export const axiomProviders = Layer.unwrap(
  axiomSettings.pipe(
    Effect.orDie,
    Effect.map((settings) => (Option.isSome(settings) ? Axiom.providers() : Layer.empty)),
  ),
);
