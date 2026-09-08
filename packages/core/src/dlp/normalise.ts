/**
 * The pre-match normalisation layer (tier 4, #127): everything Vole scans is
 * JSON, and agents routinely percent-encode a token into a URL or base64 a
 * file to move it — naive regexes miss all three. Before matching, the buffer
 * is replayed through every cheap, offline transform, and a sighting found
 * only in a transformed view carries the badge of the transform that found it.
 *
 * One decode level only: a double-encoded, gzipped, encrypted or
 * split-across-two-messages value is not found — that is the stated limit.
 */
import type { Content } from '../content';
import { contentOf } from '../content';

/** Provenance badge vocabulary — what the Data Exposure row prints. */
export type NormalisationBadge =
  | 'json_unescaped'
  | 'percent_decoded'
  | 'base64_decoded'
  | 'zero_width_stripped'
  | 'homoglyph_folded';

/** Zero-width and bidi control characters (the Rules-File Backdoor class). */
// eslint-disable-next-line no-control-regex
const ZERO_WIDTH = /[\u200b\u200c\u200d\u2060\ufeff\u202a-\u202e\u2066-\u2069]/g;

/**
 * The confusable fold: Cyrillic/Greek lookalikes → their ASCII twin. A modest
 * set, not the full confusables.org table — the common hiding spots.
 */
const HOMOGLYPHS: Record<string, string> = {
  // Lowercase Cyrillic/Greek → lowercase ASCII.
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x',
  'у': 'y', 'і': 'i', 'ѕ': 's', 'ԁ': 'd', 'һ': 'h', 'ј': 'j',
  'қ': 'k', 'Ӏ': 'l', 'м': 'm', 'т': 't', 'в': 'v',
  'α': 'a', 'β': 'b', 'ε': 'e', 'ο': 'o', 'ρ': 'p',
  'υ': 'y', 'ν': 'v', 'ω': 'w', 'κ': 'k', 'τ': 't', 'χ': 'x',
  // Uppercase Cyrillic → uppercase ASCII (an uppercase key must not fold lowercase).
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H',
  'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'У': 'Y',
};

export function stripZeroWidth(text: string): string {
  return text.replace(ZERO_WIDTH, '');
}

export function foldHomoglyphs(text: string): string {
  return text.replace(/[Ͱ-ԯ]/g, (c) => HOMOGLYPHS[c] ?? c);
}

export function percentDecode(text: string): string {
  if (!/%[0-9a-f]{2}/i.test(text)) return text;
  try {
    return decodeURIComponent(text.replace(/\+/g, '%20'));
  } catch {
    return text; // a lone % is not an encoding: leave it alone
  }
}

/** One level of JSON unescape over quoted-string runs (via JSON.parse — free). */
export function jsonUnescape(text: string): string {
  if (!/\\"|\\n|\\u[0-9a-f]{4}/i.test(text)) return text;
  return text.replace(/"(?:[^"\\\n]|\\.){12,}"/g, (run) => {
    try {
      const parsed = JSON.parse(run) as unknown;
      return typeof parsed === 'string' ? parsed : run;
    } catch {
      return run;
    }
  });
}

const PRINTABLE = /^[\x09\x0a\x0d\x20-\x7e\u00a0-\u00ff]*$/;

/** A run of >=40 base64 chars that decodes to printable ASCII. */
export function base64Runs(text: string): { start: number; decoded: string }[] {
  const out: { start: number; decoded: string }[] = [];
  const re = /[A-Za-z0-9+/]{40,}={0,2}/g;
  for (const m of text.matchAll(re)) {
    const candidate = m[0];
    // Must not be plain hex or a long word — base64 has mixed case or +/.
    if (!/[A-Z]/.test(candidate) || !/[a-z0-9]/.test(candidate)) continue;
    try {
      const decoded = Buffer.from(candidate, 'base64').toString('utf8');
      if (decoded.length >= 16 && PRINTABLE.test(decoded)) {
        out.push({ start: m.index ?? 0, decoded });
      }
    } catch {
      /* not base64: leave it */
    }
  }
  return out;
}

export interface Variant {
  text: Content;
  badges: NormalisationBadge[];
}

/**
 * Every view of the buffer the detectors should see: the raw text plus the
 * distinct transforms. Offsets in a transformed view refer to that view, not
 * to the file on disk — the honest limit of one decode level (ponytail:
 * byte-offset back-mapping into the encoded run when the viewer needs it).
 */
export function variants(buf: Content): Variant[] {
  const raw = buf as string;
  const out: Variant[] = [{ text: buf, badges: [] }];

  const stripped = stripZeroWidth(raw);
  const folded = foldHomoglyphs(stripped);
  if (folded !== raw) {
    const badges: NormalisationBadge[] = [];
    if (stripped !== raw) badges.push('zero_width_stripped');
    if (folded !== stripped) badges.push('homoglyph_folded');
    out.push({ text: contentOf(folded), badges });
    const foldedBadges = badges;
    const unescaped = jsonUnescape(folded);
    if (unescaped !== folded) {
      out.push({ text: contentOf(unescaped), badges: [...foldedBadges, 'json_unescaped'] });
      const decoded = percentDecode(unescaped);
      if (decoded !== unescaped) {
        out.push({
          text: contentOf(decoded),
          badges: [...foldedBadges, 'json_unescaped', 'percent_decoded'],
        });
      }
    } else {
      const decoded = percentDecode(folded);
      if (decoded !== folded) {
        out.push({ text: contentOf(decoded), badges: [...foldedBadges, 'percent_decoded'] });
      }
    }
  } else {
    const unescaped = jsonUnescape(raw);
    if (unescaped !== raw) {
      out.push({ text: contentOf(unescaped), badges: ['json_unescaped'] });
      const decoded = percentDecode(unescaped);
      if (decoded !== unescaped) {
        out.push({ text: contentOf(decoded), badges: ['json_unescaped', 'percent_decoded'] });
      }
    } else {
      const decoded = percentDecode(raw);
      if (decoded !== raw) {
        out.push({ text: contentOf(decoded), badges: ['percent_decoded'] });
      }
    }
  }

  // Base64 runs are scanned as their own mini-buffers (the decoded content is
  // what a detector must see), from every view produced above.
  for (const source of [...out]) {
    for (const run of base64Runs(source.text as string)) {
      out.push({ text: contentOf(run.decoded), badges: [...source.badges, 'base64_decoded'] });
    }
  }
  return out;
}
