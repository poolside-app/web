#!/usr/bin/env node
// Targeted check for the Drive backup queue (PLAN.md Z), and Delete for good
// removing everything tied to a family (PLAN.md BS1, against a pretend
// database). Offline. Costs nothing.
//
// Usage: node scripts/test_drive_queue.mjs
import { readFileSync } from 'node:fs';
import { importTs } from './lib/importts.mjs';
import { fakeDb } from './lib/fake_google.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const between = (s, a, b) => { const i = s.indexOf(a); return i < 0 ? '' : s.slice(i, s.indexOf(b, i + a.length)); };

console.log('Z1 · backups for deleted signups (offline)');
// The retry moved into _shared/drive_parties.ts (PLAN.md BP3), shared by the button and the nightly run.
const gd = read('supabase/functions/google_drive_sync/index.ts');
const dp = read('supabase/functions/_shared/drive_parties.ts');
const retry = between(dp, 'export async function retryDriveQueue', 'return { attempted');
check('"Retry failed syncs" uses it', /retryDriveQueue\(/.test(between(gd, "action === 'retry_queue'", 'return jsonResponse({ ok: true, attempted')));
check('a retry drops a backup whose signup was deleted, instead of retrying it forever',
  /application not found/.test(retry) && /drive_sync_queue'\)\.delete\(\)/.test(retry), retry.slice(0, 120));
check('"Retry failed syncs" tries every waiting backup now, not only ones past their wait', !/lte\('next_retry_at'/.test(retry));
// Delete for good lives in _shared/purge_household.ts (PLAN.md BS1).
let purge = '';
try { purge = read('supabase/functions/_shared/purge_household.ts'); } catch { /* checked below */ }
check('deleting a family for good also removes its waiting backups', /from\('drive_sync_queue'\)\.delete\(\)/.test(purge) && purge.indexOf("drive_sync_queue") < purge.indexOf("from('applications').delete()"));

console.log('BS1 · Delete for good removes everything tied to the family (offline)');
const hh = read('supabase/functions/households_admin/index.ts');
check('households_admin purge_household uses purgeHousehold', /purgeHousehold\(/.test(between(hh, "action === 'purge_household'", "action === 'add_member'")));
let P = null;
try { P = await importTs(new URL('supabase/functions/_shared/purge_household.ts', root)); } catch (e) { check('_shared/purge_household.ts loads', false, e.message); }
if (P) {
  const T = 't1', H = 'h1', other = 'h2';
  const db = fakeDb({
    households: [{ id: H, tenant_id: T, family_name: 'Frevele Family' }, { id: other, tenant_id: T, family_name: 'Other Family' }],
    household_members: [{ id: 'm1', tenant_id: T, household_id: H }, { id: 'm2', tenant_id: T, household_id: other }],
    member_sessions: [{ member_id: 'm1' }, { member_id: 'm2' }],
    member_magic_links: [{ member_id: 'm1' }],
    applications: [{ id: 'a1', tenant_id: T, household_id: H }, { id: 'a2', tenant_id: T, household_id: other }],
    drive_sync_queue: [{ tenant_id: T, application_id: 'a1' }, { tenant_id: T, application_id: 'a2' }],
    keyfobs: [{ id: 'k1', tenant_id: T, household_id: H }, { id: 'k2', tenant_id: T, household_id: other }],
    party_bookings: [{ id: 'p1', tenant_id: T, household_id: H }],
    help_requests: [{ id: 'r1', tenant_id: T, household_id: H }],
    payment_plans: [{ id: 'pl1', tenant_id: T, household_id: H }, { id: 'pl2', tenant_id: T, household_id: other }],
    payment_plan_installments: [{ id: 'i1', plan_id: 'pl1' }, { id: 'i2', plan_id: 'pl1' }, { id: 'i3', plan_id: 'pl2' }],
    payment_authorizations: [{ id: 'au1', tenant_id: T, household_id: H }, { id: 'au2', tenant_id: T, household_id: other }],
    admin_tasks: [
      { id: 't-app', tenant_id: T, source_kind: 'application', source_id: 'a1' },
      { id: 't-fob', tenant_id: T, source_kind: 'keyfob', source_id: 'k1' },
      { id: 't-fobhh', tenant_id: T, source_kind: 'keyfob_household', source_id: H },
      { id: 't-party', tenant_id: T, source_kind: 'party_booking', source_id: 'p1' },
      { id: 't-plan', tenant_id: T, source_kind: 'payment_plan', source_id: 'pl1' },
      { id: 't-help', tenant_id: T, source_kind: 'help_request', source_id: 'r1' },
      { id: 't-other-fob', tenant_id: T, source_kind: 'keyfob', source_id: 'k2' },
      { id: 't-other-plan', tenant_id: T, source_kind: 'payment_plan', source_id: 'pl2' },
      { id: 't-gate', tenant_id: T, source_kind: 'gate_panel', source_id: 'g1' },
      { id: 't-elsewhere', tenant_id: 't2', source_kind: 'keyfob_household', source_id: H },
    ],
  });
  const r = await P.purgeHousehold(db, T, H);
  const ids = t => (db.tables[t] || []).map(x => x.id);
  check('it reports what it removed', r && r.ok && r.family_name === 'Frevele Family' && r.members_removed === 1 && r.applications_removed === 1, JSON.stringify(r));
  check('the family, its people, signups and their backups are gone',
    !ids('households').includes(H) && !ids('household_members').includes('m1') && !ids('applications').includes('a1')
    && !db.tables.drive_sync_queue.some(q => q.application_id === 'a1') && !db.tables.member_sessions.some(s => s.member_id === 'm1'));
  check('every to-do about the family goes: signup, keyfob, the family\'s keyfob to-do, party, plan, help request',
    ['t-app', 't-fob', 't-fobhh', 't-party', 't-plan', 't-help'].every(id => !ids('admin_tasks').includes(id)), ids('admin_tasks').join(','));
  check('its payment plans go, with their payments', !ids('payment_plans').includes('pl1') && !ids('payment_plan_installments').includes('i1') && !ids('payment_plan_installments').includes('i2'));
  check('its auto-renew card consents go', !ids('payment_authorizations').includes('au1'));
  check('another family\'s to-dos, plan and consents stay', ['t-other-fob', 't-other-plan', 't-gate'].every(id => ids('admin_tasks').includes(id))
    && ids('payment_plans').includes('pl2') && ids('payment_plan_installments').includes('i3') && ids('payment_authorizations').includes('au2') && ids('households').includes(other));
  check('another club\'s rows stay', ids('admin_tasks').includes('t-elsewhere'));
  const miss = await P.purgeHousehold(db, T, 'nope');
  check('a family that isn\'t there is a clear error', miss && !miss.ok && /not found/i.test(miss.error || ''), JSON.stringify(miss));
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
