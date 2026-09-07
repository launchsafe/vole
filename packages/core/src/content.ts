/**
 * The content boundary — the load-bearing type of the product's privacy claim.
 *
 * "Vole never stores prompt or tool content" is the sentence every DPO
 * conversation rests on, and today it is an unenforced convention spread across
 * the collector parse loops where the raw line is in scope. This brand makes the
 * convention mechanical: `Content` is a string that can only be produced by
 * `contentOf()` — an explicit, greppable cast at the exact point raw text enters
 * scope — and once branded it can only leave through `hashOf()`, `classifyOf()`
 * or `lengthOf()`, none of which retain the text. A UsageEvent field typed
 * `string` cannot be assigned a raw line by accident: the line is not a `string`
 * you have, it is a `Content` you can only measure.
 *
 * Every `contentOf(` in the tree is a review point: grep it and you have the
 * complete list of places the boundary was widened.
 */
declare const __content: unique symbol;
export type Content = string & { readonly [__content]: true };

/** The only way raw text becomes Content. Each call site is a review point. */
export function contentOf(raw: string): Content {
  return raw as Content;
}

/** A stable digest of content that must not be retained (DLP fingerprints, Tier 4). */
export function hashOf(c: Content): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < c.length; i++) {
    h1 = (h1 ^ c.charCodeAt(i)) * 0x01000193;
    h2 = (h2 + c.charCodeAt(i) * 31) | 0;
  }
  return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
}

/** Length in code units — measurement, not retention. */
export function lengthOf(c: Content): number {
  return c.length;
}

/**
 * Coarse classification for ledgers that must record what KIND of thing was seen
 * without the thing (Tier 4/5). Returns a closed vocabulary, never a substring.
 */
export function classifyOf(c: Content): 'json' | 'jsonl' | 'text' | 'binaryish' {
  const t = c.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) return (t.includes('\n') ? 'jsonl' : 'json') as never;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0e-\x1f]/.test(t)) return 'binaryish' as never;
  return 'text' as never;
}
