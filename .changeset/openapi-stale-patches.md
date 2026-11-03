---
"apps": patch
---

OpenAPI sources skip a `patches` entry whose path item or operation, in
`paths`, `webhooks` or `components.pathItems`, the definition no longer has,
and log the skipped patches, instead of failing every tool the app offers. Any
other missing target, such as a field of an operation that still exists, and a
malformed patch still fail the definition.
