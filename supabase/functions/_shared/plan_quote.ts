// =============================================================================
// plan_quote.ts — the payment plan a family is offered, priced by the server
// =============================================================================
// The join form, the renewal pages and checkout all ask this one function, so
// the schedule a family sees before committing is the one they are charged:
// every date, the dues on each, the $4 plan fee (unless the club's fees are
// waived) and the card fee when the club passes card fees on.
// =============================================================================

import { flexSchedule, payoffMonths, weeklySchedule, withFees, type FlexCheck, type FlexResult } from './flex_plan.ts';
import { planFeeSchedule, type FeePolicy } from './fees.ts';
import { rulesFor, tierAllowed, type PlanClub } from './plan_ops.ts';
import { isTestSlug } from './test_level.ts';

export type PlanRow = {
  sequence: number; due_date: string; today: boolean;
  amount_cents: number; plan_fee_cents: number; card_fee_cents: number; charge_cents: number;
};

export type PlanQuote = {
  available: boolean;
  reason?: string;
  total_cents: number;
  min_payment_cents: number;
  months: Array<{ value: string; label: string }>;
  deadlines: Array<{ date: string; label: string; pct: number }>;
  access_when: string;
  /** For the payment plan agreement (PLAN.md CL1): who it's with, and what coming back costs. */
  club_name: string;
  reactivation_fee_cents: number;
  /** The board's test level: $1 today, then $1 a week (PLAN.md BN1). Nothing to pick. */
  weekly?: boolean;
  choice: null | {
    today_cents: number;
    payoff_month: string;
    ok: boolean;
    code?: string;
    error?: string;
    min_today_cents?: number;
    /** The family didn't pick an amount, so the least that works was used. */
    adjusted?: boolean;
    rows?: PlanRow[];
    totals?: { dues_cents: number; plan_fee_cents: number; card_fee_cents: number; charge_cents: number };
    checks?: FlexCheck[];
  };
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function quotePlan(club: PlanClub, args: {
  totalCents: number;
  tierSlug: string | null;
  year: number;
  policy: FeePolicy;
  todayCents?: number | null;
  payoffMonth?: string | null;
}): PlanQuote {
  const cfg = club.cfg;
  const rules = rulesFor(club, args.year);
  const base: PlanQuote = {
    available: false,
    total_cents: args.totalCents,
    min_payment_cents: rules.minInstallmentCents,
    months: [],
    deadlines: rules.milestones.map(m => ({ date: m.date, label: m.label ?? (m.min_pct >= 100 ? 'Paid in full' : `${m.min_pct}% paid`), pct: m.min_pct })),
    access_when: cfg.access_when,
    club_name: club.name,
    reactivation_fee_cents: Number(cfg.reactivation_fee_cents ?? 0),
    choice: null,
  };
  if (!cfg.enabled) return { ...base, reason: 'This club does not offer payment plans.' };
  if (isTestSlug(club.sv.membership_tiers, args.tierSlug)) {
    if (!(args.totalCents > 0)) return { ...base, reason: 'There is nothing to pay.' };
    const w = weeklySchedule({ totalCents: args.totalCents, startDate: club.today, rules });
    if (!w.ok) return { ...base, weekly: true, reason: w.error };
    const month = w.payoff_date.slice(0, 7);
    return priced({
      ...base, available: true, weekly: true, min_payment_cents: 0,
      months: [{ value: month, label: `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}` }],
    }, w, { today: w.today_cents, payoffMonth: month, adjusted: false, policy: args.policy, club });
  }
  if (!tierAllowed(cfg, args.tierSlug)) return { ...base, reason: 'Payment plans are not offered for this membership type.' };
  if (cfg.plan_signup_cutoff_date && club.today > cfg.plan_signup_cutoff_date) {
    return { ...base, reason: 'Sign-up for payment plans has closed for this season. Please pay in full.' };
  }
  if (!(args.totalCents > 0)) return { ...base, reason: 'There is nothing to pay.' };
  const months = payoffMonths(rules, club.today);
  if (!months.length) {
    const final = base.deadlines[base.deadlines.length - 1]?.date;
    return { ...base, reason: final ? 'The deadline to finish a payment plan has passed, so only paying in full is available.' : 'This club has not set up its payment deadlines yet.' };
  }
  const out: PlanQuote = {
    ...base,
    available: true,
    months: months.map(v => ({ value: v, label: `${MONTHS[Number(v.slice(5, 7)) - 1]} ${v.slice(0, 4)}` })),
  };

  const picked = args.todayCents !== undefined && args.todayCents !== null;
  const payoffMonth = args.payoffMonth && months.includes(args.payoffMonth) ? args.payoffMonth : months[months.length - 1];
  let today = picked ? Math.max(0, Math.trunc(Number(args.todayCents) || 0)) : 0;
  let r = flexSchedule({ totalCents: args.totalCents, todayCents: today, payoffMonth, startDate: club.today, rules });
  let adjusted = false;
  // Nothing chosen yet: start them on the least that works, rather than on
  // an error.
  if (!picked && !r.ok && r.code === 'misses_deadline' && r.min_today_cents && r.min_today_cents < args.totalCents) {
    today = r.min_today_cents;
    r = flexSchedule({ totalCents: args.totalCents, todayCents: today, payoffMonth, startDate: club.today, rules });
    adjusted = true;
  }
  if (!r.ok) {
    out.choice = { today_cents: today, payoff_month: payoffMonth, ok: false, code: r.code, error: r.error, min_today_cents: r.min_today_cents };
    return out;
  }
  return priced(out, r, { today, payoffMonth, adjusted, policy: args.policy, club });
}

/** Every charge with its plan fee and card fee, and the totals. */
function priced(out: PlanQuote, r: Extract<FlexResult, { ok: true }>, a: {
  today: number; payoffMonth: string; adjusted: boolean; policy: FeePolicy; club: PlanClub;
}): PlanQuote {
  const fees = planFeeSchedule(r.schedule.length, a.policy);
  const rows = withFees(r.schedule, { planFees: fees, passFee: a.club.passFee, pct: a.club.pct, fixed: a.club.fixed })
    .map(x => ({ ...x, today: a.today > 0 && x.sequence === 1 }));
  out.choice = {
    today_cents: a.today, payoff_month: a.payoffMonth, ok: true, adjusted: a.adjusted, rows, checks: r.checks,
    totals: {
      dues_cents: rows.reduce((n, x) => n + x.amount_cents, 0),
      plan_fee_cents: rows.reduce((n, x) => n + x.plan_fee_cents, 0),
      card_fee_cents: rows.reduce((n, x) => n + x.card_fee_cents, 0),
      charge_cents: rows.reduce((n, x) => n + x.charge_cents, 0),
    },
  };
  return out;
}
