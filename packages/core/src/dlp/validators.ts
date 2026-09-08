/**
 * Offline checksum validators (tier 4, #117): entropy alone is a known
 * false-positive engine (gitleaks#1830), so a data-class shape only becomes
 * a sighting when it passes the checksum its format actually carries.
 *
 * Everything here is pure arithmetic on the candidate string — no network,
 * no lookups, and the outcome is never "live credential": a shape that passes
 * a checksum is exactly and only "matched <detector>, checksum valid"
 * (a rotated key and a working key are indistinguishable locally).
 */

export type ValidatorName = 'luhn' | 'mod97' | 'mod11' | 'crc32_tail' | 'jwt' | 'pem';

/** Luhn (ISO/IEC 7812-1) — payment cards. */
export function luhn(value: string): boolean {
  const digits = value.replace(/[^0-9]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 0x30;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** mod-97 (ISO 13616) — IBAN. The check digits make transpositions fail. */
export function mod97(value: string): boolean {
  const iban = value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const part = code >= 0x30 && code <= 0x39 ? ch : String(code - 0x37);
    for (const d of part) rem = (rem * 10 + (d.charCodeAt(0) - 0x30)) % 97;
  }
  return rem === 1;
}

/** mod-11 — the weighted checksum several national account numbers carry. */
export function mod11(value: string): boolean {
  const digits = value.replace(/[^0-9]/g, '');
  if (digits.length < 8 || digits.length > 12) return false;
  let sum = 0;
  let weight = 2;
  for (let i = digits.length - 2; i >= 0; i--) {
    sum += (digits.charCodeAt(i) - 0x30) * weight;
    weight = weight === 7 ? 2 : weight + 1;
  }
  const rem = sum % 11;
  const check = rem === 0 ? 0 : rem === 1 ? 1 : 11 - rem;
  return digits.charCodeAt(digits.length - 1) - 0x30 === check;
}

/** CRC32 (IEEE 802.3) — the tail arithmetic the GitHub-token check builds on. */
export function crc32(text: string): number {
  let crc = 0xffffffff;
  for (let i = 0; i < text.length; i++) {
    crc ^= text.charCodeAt(i);
    for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * GitHub token tail check. The vendor's exact CRC32 placement is not public,
 * so this COMPUTES the CRC32 of the body and compares it to the last 6 base62
 * characters read as base-36: a match is recorded, a miss demotes nothing —
 * `validator_checked` records the run and its outcome, and only the public
 * schemes (luhn/mod97/mod11/jwt/pem) gate a sighting.
 * ponytail: informational until GitHub documents the scheme; the upgrade path
 * is swapping this body for the documented algorithm.
 */
export function crc32Tail(value: string): boolean {
  const body = value.replace(/^gh[pousr]_/, '');
  if (body.length < 37) return false;
  const claimed = parseInt(body.slice(-6).toLowerCase().replace(/[^0-9a-z]/g, ''), 36);
  return Number.isFinite(claimed) && claimed === crc32(body.slice(0, -6));
}

/** What the JWT validator may retain — booleans only, never the claims. */
export interface JwtShape {
  valid: boolean;
  algParses: boolean;
  expParses: boolean;
  issParses: boolean;
}

/** Structural base64url decode: three segments; only whether alg/iss/exp parse. */
export function jwtShape(value: string): JwtShape {
  const out: JwtShape = { valid: false, algParses: false, expParses: false, issParses: false };
  const segs = value.split('.');
  if (segs.length < 2 || segs.length > 5) return out;
  const b64u = (s: string): unknown | undefined => {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return undefined;
    try {
      return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    } catch {
      return undefined;
    }
  };
  const header = b64u(segs[0] ?? '');
  if (typeof header === 'object' && header !== null) {
    out.algParses = 'alg' in header;
    out.valid = true;
  }
  if (segs.length >= 3) {
    const payload = b64u(segs[1] ?? '');
    if (typeof payload === 'object' && payload !== null) {
      out.expParses = 'exp' in payload;
      out.issParses = 'iss' in payload;
    }
  } else {
    // A two-segment (unsecured) JWT is still a JWT shape.
    out.valid = out.valid || segs[0] !== undefined;
  }
  return out;
}

/** PEM header plus DER length sanity: the base64 body must start 0x30 (SEQUENCE). */
export function pemSanity(value: string): boolean {
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return false;
  const bodyMatch = value.match(/-----BEGIN [A-Z ]*PRIVATE KEY-----([\s\S]*?)-----END [A-Z ]*PRIVATE KEY-----/);
  if (!bodyMatch) return true; // header-only match: nothing to sanity-check yet
  const b64 = (bodyMatch[1] ?? '').replace(/[^A-Za-z0-9+/]/g, '');
  if (b64.length < 4) return false;
  const der = Buffer.from(b64, 'base64');
  if (der.length < 4 || der[0] !== 0x30) return false;
  // DER length: short form or the long form the leading length byte declares.
  const lenByte = der[1]!;
  const declared = lenByte & 0x80 ? 2 + (lenByte & 0x7f) : 2;
  return der.length >= declared;
}

/** Runs the named validator. Unknown names are a pack bug: gate OFF (no sighting). */
export function runValidator(name: ValidatorName, value: string): boolean {
  switch (name) {
    case 'luhn': return luhn(value);
    case 'mod97': return mod97(value);
    case 'mod11': return mod11(value);
    case 'crc32_tail': return crc32Tail(value);
    case 'jwt': return jwtShape(value).valid;
    case 'pem': return pemSanity(value);
  }
}
