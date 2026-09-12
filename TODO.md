# Possible Follow-up Work

This is a lightweight list, not a required queue. Re-check each item against the
current code before starting it.

## Type injected web dependencies

Replace the untyped nullable `deps` values in `analysis.ts`, `session.ts`, and
`events-panel.ts` with explicit non-null TypeScript contracts. This is useful
preparation for enabling stricter null and implicit-any checks, but does not
require enabling those flags at the same time.

## Optimize integer filter arithmetic

Integer arithmetic still uses the wide scalar path. If profiling shows it
matters, add a safe narrow lowering while preserving overflow behavior and
correct handling of `u64` addresses near the top of their range.

## Shell hosting another domain

Do not generalize the shell speculatively. Revisit a domain-neutral host only
when a concrete second analysis domain exists with known data, views, and
persistence needs.
