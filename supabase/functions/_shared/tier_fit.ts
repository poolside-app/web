// Which membership levels fit a family (PLAN.md BG4, from the 10/20 audit).
// A level can say how many people it covers (membership_tiers[].max_people,
// set on Money setup → Membership prices; blank = any). A card signup is
// approved with no one looking, so the form and the server both check it:
// before, a family of five could pick Single and be approved.

export type TierLike = { slug?: unknown; label?: unknown; max_people?: unknown };

/** True when the level covers this many people. */
export function tierFits(tier: TierLike | null | undefined, people: number): boolean {
  const max = Number(tier?.max_people);
  return !(Number.isFinite(max) && max > 0) || people <= max;
}

/** Why the chosen level doesn't fit, or null when it does (or isn't known). */
export function tierFitError(tiers: unknown, slug: unknown, people: number): string | null {
  const list = Array.isArray(tiers) ? tiers as TierLike[] : [];
  const tier = list.find(t => t && t.slug === slug);
  if (!tier || tierFits(tier, people)) return null;
  const max = Number(tier.max_people);
  const name = String(tier.label || tier.slug || 'That level');
  return `${name} covers ${max} ${max === 1 ? 'person' : 'people'}, and you listed ${people}. Pick a level that covers your whole family.`;
}
