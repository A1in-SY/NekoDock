const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}_]+/gu;
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const STOP = new Set(['我','你','他','她','它','的','了','是','在','和','也','有','吗','呢','啊','呀','这','那','the','a','an','is','are','to','and','of']);

/** FTS receives spaced CJK unigrams/bigrams instead of treating a whole sentence as one word. */
export function memoryTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const run of text.slice(0,32768).normalize('NFKC').toLowerCase().match(CJK) ?? []) {
    if (!CJK_CHAR.test(run)) { if (!STOP.has(run)) terms.add(run); continue; }
    const chars = [...run];
    for (let i = 0; i < chars.length; i++) {
      if (!STOP.has(chars[i]!)) terms.add(chars[i]!);
      if (i + 1 < chars.length) terms.add(chars[i]! + chars[i + 1]!);
    }
  }
  return [...terms].slice(0, 4000);
}

export function memoryIndexText(text: string): string { return memoryTerms(text).join(' '); }
export function memoryFtsQuery(text: string): string {
  const terms = memoryTerms(text).slice(0, 100);
  // A two-character CJK query should prefer the complete bigram over either character.
  const longer = terms.filter(term => [...term].length > 1);
  return (longer.length ? longer : terms).map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
}

export function memoryRelevance(query: string, content: string): number {
  const normalized = query.normalize('NFKC').toLowerCase().trim();
  if (!normalized) return 0;
  const haystack = content.normalize('NFKC').toLowerCase();
  const tokens = new Set(memoryTerms(haystack));
  let score = haystack.includes(normalized) ? 20 : 0;
  for (const term of memoryTerms(normalized)) if (tokens.has(term)) score += [...term].length > 1 ? 3 : 0.2;
  return score;
}
