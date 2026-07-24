# 04 — Minor

Small, self-contained items. Neither affects correctness of output today.

---

<a id="f16"></a>

## F16 — `to_tag.dedup()` is dead code

**Fixed** in `57661a8` ("F16: replace dead to_tag.dedup() with the invariant
it guarded") — the second option in the fix below: the line was deleted and
replaced with a comment recording the `death`-written-once invariant.

**Where** `core/src/lib.rs:606`.

**What**

```rust
to_tag.dedup();
let n = to_tag.len() as u32;
```

`Vec::dedup` removes only *consecutive* duplicates, so it is a no-op unless the
vector is sorted. It cannot fire here in either mode:

- `by_free == 0` collects `e` itself over an ascending range — strictly
  increasing, no duplicates possible.
- `by_free != 0` collects `s.target[e]`. A creator's `death` is written once
  (`parse.rs:380`) and a second free of the same id resolves to `NONE_U32` with
  a `W_DOUBLE_FREE` warning (`parse.rs:299`), so each target appears at most
  once.

**Why it matters** It reads as a guard against double-counting in the returned
tag count, which is the number reported to the user. A future reader may
assume duplicates are possible and preserve the call, or "fix" it by adding a
sort — both wrong.

**Fix** Delete the line. If the intent was defensive, replace it with a comment
recording *why* duplicates cannot occur (the `death`-written-once invariant),
which is the fact worth keeping. `tag_freed_range` already covers the behavior.

---

<a id="f17"></a>

## F17 — `parseSize` fails silently, unlike its sibling inputs

**Fixed** in `6984e55` ("F17: give parseSize a distinguishable failure"),
folded into `web/fmt.js` by the later F15 fix. `parseSize` returns `null` on
an unparsable input (0 stays "empty"), accepts exponent notation matching the
jump box, and the size-filter inputs now get the same red-border treatment
`row-bytes`/`collapse-min` already had, keeping the previous constraint
instead of clearing it.

**Where** `web/main.js:98`, used by `sendFilter` (`main.js:926`) and
`rowBytesValue` (`main.js:680`).

**What** `parseSize` returns `0` for anything its regex rejects:

```js
const m = s.match(/^(0x[\da-f]+|[\d.]+)\s*([kmgt]?)i?b?$/);
if (!m) return 0;
```

In the size filter, `0` means "unbounded" — so a typo (`1e6`, `12 kb ` with a
stray character, `1,024`) reads as *no constraint* and the filter silently does
nothing. The same function backs `row-bytes` and `collapse-min`, but those call
sites check the result and mark the input:

```js
input.style.borderColor = value > 0 ? '' : 'var(--red)';
```

`f-size-min` / `f-size-max` do not.

Note `1e6` specifically: `[\d.]+` does not match `e`, so scientific notation is
rejected here even though `TASKS.md` records making the *jump* box accept it
(`parseFloat`, so `1e6` → seq 1000000). The two inputs now disagree about a
notation the user has been taught works.

**Why it matters** Cosmetic in isolation, but it is a filter that silently
matches everything — the user sees an unchanged view and concludes the filter is
broken rather than that the input was rejected.

**Fix** Give `parseSize` a distinguishable failure (`null` rather than `0`) and
have all three call sites treat it uniformly: red border on `null`, and for the
filter, leave the previous constraint in place rather than clearing it. Accept
exponent notation while there, for consistency with the jump box.
