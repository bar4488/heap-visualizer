import type { FilterCompletion, FilterCompletions } from './protocol.ts';

export function utf8Offset(source: string, utf16Offset: number): number {
  return new TextEncoder().encode(source.slice(0, utf16Offset)).length;
}

export function utf16Offset(source: string, byteOffset: number): number {
  const target = Math.max(0, byteOffset);
  let bytes = 0;
  let utf16 = 0;
  for (const char of source) {
    const codePoint = char.codePointAt(0)!;
    const width = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes + width > target) break;
    bytes += width;
    utf16 += char.length;
  }
  return utf16;
}

export function applyFilterCompletion(
  source: string,
  completions: FilterCompletions,
  item: FilterCompletion,
): { source: string; cursor: number } {
  const start = utf16Offset(source, completions.start);
  const end = utf16Offset(source, completions.end);
  return {
    source: source.slice(0, start) + item.insertText + source.slice(end),
    cursor: start + item.insertText.length,
  };
}
