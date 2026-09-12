/**
 * Did a proposed fix actually help?
 *
 * Kept pure and separate from detection on purpose: this is the half that can be wrong
 * in the most expensive way. A tool that predicts savings and never checks them is
 * indistinguishable from one that makes them up, so the comparison has to be testable
 * without waiting three real days for a window to close.
 */

/** How much of the prediction has to land before a fix counts as having worked. */
export const WORKED_RATIO = 0.8;

/**
 * Improvements below this are noise, not results. Agent spend varies day to day for
 * reasons that have nothing to do with any fix, and calling a $0.02 drift a success
 * would make every finding look effective.
 */
export const NOISE_FLOOR_USD = 0.5;

/** The soonest a follow-up window can be judged. Shorter than this is sampling noise. */
export const VERIFY_AFTER_MS = 3 * 24 * 60 * 60_000;

export type Outcome = 'worked' | 'under_estimate' | 'did_not_help';

export interface OutcomeInput {
  /** What the finding said would be saved, in USD. */
  predictedUsd: number;
  /** The metric over the window before the fix. */
  baselineUsd: number;
  /** The same metric over a comparable window after it. */
  actualUsd: number;
}

export interface OutcomeVerdict {
  outcome: Outcome;
  /** What was actually saved. Negative when spend went UP. */
  realisedUsd: number;
  /** Realised over predicted; null when nothing was predicted. */
  ratio: number | null;
}

/**
 * Compares a prediction against what happened.
 *
 * The asymmetry is deliberate. `worked` requires most of the prediction to land, while
 * anything at or below the noise floor is `did_not_help` — including a negative, where
 * spend rose. Erring towards "this did not help" is the safe direction: the cost of
 * wrongly claiming success is a user who stops trusting every number in the product.
 */
export function compareOutcome(input: OutcomeInput): OutcomeVerdict {
  const realisedUsd = input.baselineUsd - input.actualUsd;
  const ratio = input.predictedUsd > 0 ? realisedUsd / input.predictedUsd : null;

  if (realisedUsd <= NOISE_FLOOR_USD) return { outcome: 'did_not_help', realisedUsd, ratio };
  if (input.predictedUsd <= 0) {
    // Nothing was promised, but something improved. Not a failure, and not a hit
    // against a prediction that never existed.
    return { outcome: 'worked', realisedUsd, ratio };
  }
  if (realisedUsd >= input.predictedUsd * WORKED_RATIO) {
    return { outcome: 'worked', realisedUsd, ratio };
  }
  return { outcome: 'under_estimate', realisedUsd, ratio };
}

/** Whether a finding applied at `appliedAt` is old enough to judge. */
export function isDueForVerification(appliedAt: number, now: number): boolean {
  return now - appliedAt >= VERIFY_AFTER_MS;
}

/**
 * Whether an applied fix should be rolled back.
 *
 * Only a fix this tool applied itself is ever reverted, and only when it demonstrably
 * did nothing. An under-estimate is left alone: it helped less than hoped, but it did
 * help, and undoing it would cost the user the part that worked.
 */
export function shouldRevert(outcome: Outcome, wasAutoApplied: boolean): boolean {
  return wasAutoApplied && outcome === 'did_not_help';
}
