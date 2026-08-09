export type FilterJoin = 'and' | 'or';

type TopLevelSource = {
  operands: string[];
  operators: FilterJoin[];
};

const WORD = /[A-Za-z0-9_]/;

function splitTopLevel(source: string, splitOn?: FilterJoin): TopLevelSource {
  const operands: string[] = [];
  const operators: FilterJoin[] = [];
  let start = 0;
  let depth = 0;
  let quote = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') {
      quote = true;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && !WORD.test(source[i - 1] ?? ' ')) {
      // the operators are words now, so a match has to be a whole one:
      // `android == 1` does not begin with the `and` operator
      const op = source.startsWith('and', i) ? 'and' : source.startsWith('or', i) ? 'or' : null;
      if (op && !WORD.test(source[i + op.length] ?? ' ') && (!splitOn || op === splitOn)) {
        operands.push(source.slice(start, i).trim());
        operators.push(op);
        start = i + op.length;
        i += op.length - 1;
      }
    }
  }
  operands.push(source.slice(start).trim());
  return { operands, operators };
}

function splitLogicalRoot(source: string): TopLevelSource {
  const operators = splitTopLevel(source).operators;
  return splitTopLevel(source, operators.includes('or') ? 'or' : 'and');
}

export function quoteFilterString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * How a custom trace field is spelled in the filter language. Dot access is
 * sugar for an identifier-shaped key; anything else needs the bracket form.
 *
 * `atDeath` reads the record that freed the allocation rather than the one
 * that created it — the same key on the two records is two operands
 * ([ANL-010]), and each hangs off the object for its own record.
 */
export function customFieldRef(key: string, atDeath = false): string {
  const root = atDeath ? 'free.fields' : 'malloc.fields';
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    ? `${root}.${key}`
    : `${root}[${quoteFilterString(key)}]`;
}

/**
 * The predicate matching one custom field value, or null when the value is
 * not something the language can address — an object, an array, or `null`,
 * which is missingness rather than a value ([ANL-010]).
 */
export function customFieldPredicate(
  key: string,
  value: unknown,
  atDeath = false,
): string | null {
  const ref = customFieldRef(key, atDeath);
  if (typeof value === 'string') return `${ref} == ${quoteFilterString(value)}`;
  if (typeof value === 'boolean') return value ? ref : `not ${ref}`;
  // Numbers are exact on both sides: the language reads a fractional literal
  // as the same double the trace's own text parsed to, so `== 0.986` matches
  // the record it was written from (T034). Infinities and NaN cannot be
  // written as JSON numbers, so a finite check is enough.
  if (typeof value === 'number' && Number.isFinite(value)) return `${ref} == ${value}`;
  return null;
}

export function hasTopLevelPredicate(source: string, predicate: string): boolean {
  return splitLogicalRoot(source).operands.includes(predicate.trim());
}

export function toggleFilterPredicate(
  source: string,
  predicate: string,
  join: FilterJoin = 'and',
): string {
  const trimmed = source.trim();
  const target = predicate.trim();
  if (!trimmed) return target;

  const split = splitLogicalRoot(trimmed);
  const index = split.operands.indexOf(target);
  if (index >= 0) {
    if (split.operands.length === 1) return '';
    if (index === 0) {
      split.operands.shift();
      split.operators.shift();
    } else {
      split.operands.splice(index, 1);
      split.operators.splice(index - 1, 1);
    }
    let result = split.operands[0];
    for (let i = 0; i < split.operators.length; i++) {
      result += ` ${split.operators[i]} ${split.operands[i + 1]}`;
    }
    return result;
  }

  const base = join === 'and' && split.operators[0] === 'or'
    ? `(${trimmed})`
    : trimmed;
  return `${base} ${join} ${target}`;
}
