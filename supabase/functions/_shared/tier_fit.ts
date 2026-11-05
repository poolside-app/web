// Which membership levels fit a family (PLAN.md BG4, from the 10/20 audit).
// A level can say how many people it covers (membership_tiers[].max_people,
// set on Money setup → Membership prices; blank = any). A card signup is
// approved with no one looking, so the form and the server both check it:
// before, a family of five could pick Single and be approved.
//
// PLAN.md BS3 (Doug 11/4, "family needs 2 or more"): a level can also say the
// fewest people it covers (min_people). That only applies when another level
// covers the family, so a club with no level for one person still lets one
// person join on Family. apply.html's applyTierDefault asks the same rule.

export type TierLike = { slug?: unknown; label?: unknown; max_people?: unknown; min_people?: unknown };

const limit = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

/** True when the level covers this many people (its most). */
export function tierFits(tier: TierLike | null | undefined, people: number): boolean {
  const max = limit(tier?.max_people);
  return max == null || people <= max;
}

/** True when the level covers this many people, its fewest and its most. */
function fitsExactly(tier: TierLike, people: number): boolean {
  const min = limit(tier.min_people);
  return tierFits(tier, people) && (min == null || people >= min);
}

/** The levels a family of this size can pick, in the club's order. */
export function pickableTiers<T extends TierLike>(tiers: unknown, people: number): T[] {
  const list = (Array.isArray(tiers) ? tiers : []).filter(Boolean) as T[];
  return list.filter(t => tierFits(t, people) && (fitsExactly(t, people) || !list.some(o => o !== t && fitsExactly(o, people))));
}

/** Why the chosen level doesn't fit, or null when it does (or isn't known). */
export function tierFitError(tiers: unknown, slug: unknown, people: number): string | null {
  const list = (Array.isArray(tiers) ? tiers : []).filter(Boolean) as TierLike[];
  const tier = list.find(t => t.slug === slug);
  if (!tier) return null;
  const name = String(tier.label || tier.slug || 'That level');
  if (!tierFits(tier, people)) {
    const max = Number(tier.max_people);
    return `${name} covers ${max} ${max === 1 ? 'person' : 'people'}, and you listed ${people}. Pick a level that covers your whole family.`;
  }
  if (pickableTiers(list, people).includes(tier)) return null;
  const other = list.find(o => o !== tier && fitsExactly(o, people))!;
  const otherName = String(other.label || other.slug || 'Another level');
  return `${name} is for ${limit(tier.min_people)} or more people. ${otherName} covers ${people === 1 ? 'just you' : 'your family'}.`;
}
