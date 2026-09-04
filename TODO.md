# Possible Follow-up Work

This is a lightweight list, not a required queue. Re-check each item against the
current code before starting it.

## Connected analysis synchronization

Let connected tabs receive committed analysis changes from other clients
without continuously polling or reloading the trace:

- Add authenticated held `GET /api/v1/changes?after=&wait=` responses containing
  bounded, ordered deltas only.
- Signal revision gaps or expired history so the browser reloads a snapshot.
- Apply deltas through the existing analysis port and Rust core.
- Cancel held requests on disconnect or connection replacement, ignoring late
  responses.

Do not add WebSockets, view control, MCP, or multi-trace management as part of
this work.

## Type injected web dependencies

Replace the untyped nullable `deps` values in `analysis.ts`, `session.ts`, and
`events-panel.ts` with explicit non-null TypeScript contracts. This is useful
preparation for enabling stricter null and implicit-any checks, but does not
require enabling those flags at the same time.

## Support negative filter literals

Make expressions such as `malloc.fields.drift == -2.5` parse, check, and
evaluate. Unary minus should bind correctly, constant-fold in the lowered plan,
and be covered in parser, plan/oracle, and web predicate tests. Unary plus and
new arithmetic operators remain out of scope.

## Optimize integer filter arithmetic

Integer arithmetic still uses the wide scalar path. If profiling shows it
matters, add a safe narrow lowering while preserving overflow behavior and
correct handling of `u64` addresses near the top of their range.

## Shell hosting another domain

Do not generalize the shell speculatively. Revisit a domain-neutral host only
when a concrete second analysis domain exists with known data, views, and
persistence needs.
