// Test families in Bishop's live data, made and removed by the targeted test
// scripts so nothing they create is left for the board or real testers to see.
// `sql` is each script's Management API query function.

const q = s => `'${String(s).replace(/'/g, "''")}'`;

/** A paid, gate-enabled household with one primary member. */
export async function makeTempMember(sql, tenantId, familyName) {
  const [hh] = await sql(`insert into households (tenant_id, family_name, tier, active, dues_paid_for_year, paid_until_year)
    values (${q(tenantId)}, ${q(familyName)}, 'family', true, true, extract(year from now())::int)
    returning id`);
  const [m] = await sql(`insert into household_members (tenant_id, household_id, name, role, active, can_unlock_gate, can_book_parties, confirmed_at)
    values (${q(tenantId)}, ${q(hh.id)}, ${q(familyName + ' Tester')}, 'primary', true, true, true, now())
    returning id`);
  return { id: m.id, household_id: hh.id };
}

/** Remove test families whose name matches `familyLike` (SQL LIKE), their
 *  applications, and every trace they leave outside a cascading foreign key:
 *  tasks, audit rows, text and email logs, simulated Stripe events and queued
 *  Drive syncs. Phones use the fake 555 exchange and emails the +simtest tag,
 *  so the log cleanup can't touch a real person's rows. */
export async function purgeTestFamilies(sql, tenantId, familyLike) {
  const T = q(tenantId), L = q(familyLike);
  await sql(`begin;
    create temp table x_apps on commit drop as
      select id, stripe_session_id from applications where tenant_id = ${T} and family_name like ${L};
    create temp table x_hh on commit drop as
      select id from households where tenant_id = ${T} and family_name like ${L};
    create temp table x_members on commit drop as
      select m.id, m.phone_e164, m.email from household_members m where m.household_id in (select id from x_hh);
    delete from admin_tasks where tenant_id = ${T}
      and (source_id in (select id from x_apps) or source_id in (select id from x_hh));
    delete from audit_log where tenant_id = ${T}
      and (entity_id in (select id from x_apps) or entity_id in (select id from x_hh) or entity_id in (select id from x_members));
    delete from drive_sync_queue where application_id in (select id from x_apps);
    delete from referrals where application_id in (select id from x_apps);
    delete from stripe_processed_events where id in (select 'evt_' || stripe_session_id from x_apps where stripe_session_id like 'sim_%');
    delete from sms_log where tenant_id = ${T} and to_phone like '+1555%'
      and to_phone in (select phone_e164 from x_members union select primary_phone from applications where id in (select id from x_apps));
    delete from email_log where to_email ilike 'doug.frevele+simtest%'
      and lower(to_email) in (select lower(email) from x_members union select lower(primary_email) from applications where id in (select id from x_apps));
    delete from applications where id in (select id from x_apps);
    delete from households where id in (select id from x_hh);
    commit;`);
}
