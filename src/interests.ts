/**
 * Listener interest profile (M14 — personalized salience).
 *
 * This profile biases curation *importance scoring* toward the listener's
 * topical interests. It is a weighting nudge, NOT a filter: a genuinely major
 * AI development always surfaces regardless of how well it fits the profile
 * (the floor is enforced in the curate system prompt — see
 * buildInterestProfileBlock in src/curate.ts).
 *
 * Edit DEFAULT_INTEREST_PROFILE to retune what the show leans toward, or set
 * the INTEREST_PROFILE env var to override it per run without code changes.
 * Set INTEREST_PROFILE to an empty string to disable personalization (the
 * curate prompt then behaves exactly as it did before this feature).
 */

export const DEFAULT_INTEREST_PROFILE = `The listener is a veteran senior software engineer fascinated by how AI is changing the way people work. Lean toward:
- AI technologies broadly (research, models, capabilities)
- Consumer AI products
- Developer AI products and tooling
- How AI is changing the way the listener and others work day to day
- AI capability changes that could shift how people work — mostly near-term, but meaningful long-term shifts too
- Longer-horizon, science-fiction-adjacent advances in health and lifestyle (disease prevention, longevity) and human augmentation`;

/**
 * Resolves the active interest profile: the INTEREST_PROFILE env override when
 * set to non-empty text, otherwise the committed default. Returns "" when the
 * override is explicitly set to empty/whitespace (personalization disabled).
 */
export function getInterestProfile(): string {
  const override = process.env.INTEREST_PROFILE;
  if (override !== undefined) return override.trim();
  return DEFAULT_INTEREST_PROFILE.trim();
}
