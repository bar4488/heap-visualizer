// Heap domain: address-string normalization. Pure — a hex address in any of
// the spellings the UI accepts ("0x7f…", "7F…", with whitespace) becomes the
// one canonical lowercase `0x…` form, or null if it isn't an address at all.
// Callers treat null as "reject", never as "unbounded".

export function normAddr(v) {
  v = (v || '').trim().toLowerCase();
  if (!v) return null;
  if (!v.startsWith('0x')) v = `0x${v}`;
  if (!/^0x[0-9a-f]+$/.test(v)) return null;
  try { return `0x${BigInt(v).toString(16)}`; } catch { return null; }
}
