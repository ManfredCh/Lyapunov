# Outbound Session projection candidate

Status: **Candidate repaired and validated against the pinned native controller; registry integration remains Lead-owned.**

## Implemented behavior

- `dsh-session-outbound-projection.patch` projects paged history, the opening follow snapshot, durable live-follow events, live assistant chunks, and the reconnect baseline at `assistantStream.activeAttempt.stream`.
- The adapter consumes the product `projectEvent(event)` and `projectBlock(block)` service. Native stream chunks and packed assistant records are adapted to content blocks before projection. Stream metadata, including `time`, `index`, `revision`, attempt identity, cursors, `turn`, `step`, and `nextIndex`, remains unchanged.
- Projection inputs are detached copies. Durable Session events, stored assistant streams, and the native accumulator remain unchanged. Event envelopes retain `type`, `seq`, `time`, `sourceEventSeqs`, `surfaceOp`, and `ignorable`; the product projector can replace event data only.
- Provider lookup is strict and late-bound: each outbound operation calls `ctx.get('sessionOutboundProjection')`. Missing, disposed, inactive, or malformed providers throw `missing active sessionOutboundProjection service`; there is no identity fallback for private data. Provider replacement is observed by an existing controller, and provider exceptions propagate.
- The patch adds `src/outbound-projection.ts` to the pinned Host `tsconfig.host.json` file list and does not use a TypeScript suppression.
- The patch does not register a product provider. `script/upstream-patches.mjs` remains unchanged and registry integration is Lead-owned after semantic approval.

## Verification

Pinned upstream: `.upstream/deepseek-harness-20260911-candidate`, commit `7c3f05885033aa3aed74904d59a94692d12a47f7`.

Commands run:

```sh
git apply --check packages/lyapunov-shell/patches/dsh-session-outbound-projection.patch
/home/s18/.bun/bin/bun --no-env-file test packages/lyapunov-shell/test/host-projection-candidate.test.ts
git diff --check -- packages/lyapunov-shell/patches/dsh-session-outbound-projection.patch packages/lyapunov-shell/test/host-projection-candidate.test.ts packages/lyapunov-shell/patches/OUTBOUND-PROJECTION-BLOCKER.md
```

Results:

- Patch application check passed against the pinned checkout without modifying it.
- The candidate test passed **9 tests, 0 failures, 195 assertions**. It copies the pinned native Session Controller sources into a disposable scratch tree, applies the candidate patch, compiles the patched Host source with strict TypeScript, dynamically loads the compiled controller, and exercises page, opening follow, durable live events, live chunks, packed reconnect records, metadata preservation, pagination, detached inputs, durable-value immutability, late provider availability, replacement, disposal, malformed providers, provider failures, ordering, cancellation, and Agent disposal.
- Synthetic private markers include a token-like value, an absolute private path, an internal continuation instruction, and a private URL. The native test asserts they are absent from projected outputs while remaining in durable Session values.
- `git diff --check` passed for the three candidate deliverables.

## Shared harness note

The shared native wrapper now accepts all three patch targets, compiles the candidate, and passes **7 of 7** native cases. The outer Bun regression wrapper also passes. These are disposable pinned-source harnesses; they do not register the patch or establish real product Loader/Host composition.

No Host launch, network request, deployment, or inspection of real secrets is part of this evidence.
