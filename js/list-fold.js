/* =============================================================================
 * list-fold.js — keep the board's lists short with 100+ families (PLAN.md AP)
 * =============================================================================
 * Doug, 10/12: "with 100+ members the list will be so long… How can we
 * prevent the list from super growing and doom scrolling". The rule: lists
 * show work, not history; history is a lookup. Nothing is dropped, only
 * folded.
 *
 * Needs you (club/admin/index.html):
 *   groupTodos(sortedTasks)        3+ of a kind become one { group: true } item
 *   todoLabel(kind, n, fallback)   "12 keyfobs to issue"
 * Keyfobs page (club/admin/keyfobs.html):
 *   workQueue(fobs)                oldest first
 *   familyRows(fobs, households)   one row per family with its active/off fobs
 *   findFamilies(rows, q)          by family, address or fob number
 *   firstN(rows, n)                the first n (paging)
 * ============================================================================= */
(function () {
  'use strict';

  var MIN_GROUP = 3;

  // Kinds that group together, and how a group reads. First match wins.
  var TODO_KINDS = [
    [/^payments\.approve_due/, 'payment approvals'],
    [/^(venmo\.claim|party\.venmo_claim|keyfob\.venmo)/, 'Venmo payments to check'],
    [/^application\.submitted/, 'signups to review'],
    [/^keyfob\.issue/, 'keyfobs to issue'],
    [/^keyfob\.off/, 'lost keyfobs to turn off'],
    [/^help\.request/, 'member questions'],
    [/^party\.requested/, 'party requests'],
    [/^party\.booked/, 'booked parties to contact'],
    [/^photo\./, 'photos to approve'],
  ];
  function kindIndex(kind) {
    for (var i = 0; i < TODO_KINDS.length; i++) if (TODO_KINDS[i][0].test(String(kind || ''))) return i;
    return -1;
  }
  function groupKey(kind) {
    var i = kindIndex(kind);
    return i < 0 ? String(kind || '') : String(TODO_KINDS[i][0]);
  }

  /** Tasks already in the order they'll show. 3+ of a kind → one item where the first was. */
  function groupTodos(tasks, min) {
    min = min || MIN_GROUP;
    var byKey = {}, order = [];
    (tasks || []).forEach(function (t) {
      var k = groupKey(t.kind);
      if (!byKey[k]) { byKey[k] = []; order.push(k); }
      byKey[k].push(t);
    });
    var out = [];
    (tasks || []).forEach(function (t) {
      var k = groupKey(t.kind), all = byKey[k];
      if (all.length >= min) {
        if (all[0] === t) out.push({ group: true, key: String(t.kind || ''), tasks: all });
      } else {
        out.push({ group: false, task: t });
      }
    });
    return out;
  }

  function todoLabel(kind, n, fallback) {
    var i = kindIndex(kind);
    if (i >= 0) return n + ' ' + TODO_KINDS[i][1];
    return (fallback || 'To-dos') + ' · ' + n;
  }

  // ── Keyfobs ──────────────────────────────────────────────────────────
  function workQueue(fobs) {
    return (fobs || []).slice().sort(function (a, b) {
      return String(a.requested_at || '').localeCompare(String(b.requested_at || ''));
    });
  }

  /** One row per family that has a fob on (active) or turned off. */
  function familyRows(fobs, households) {
    var addr = {};
    (households || []).forEach(function (h) { addr[h.id] = h.address || ''; });
    var rows = {}, list = [];
    (fobs || []).forEach(function (f) {
      if (f.status !== 'active' && f.status !== 'off') return;
      var k = f.household_id || ('?' + (f.family_name || ''));
      if (!rows[k]) {
        rows[k] = { household_id: f.household_id || null, family_name: f.family_name || 'Family', address: addr[f.household_id] || '', fobs: [] };
        list.push(rows[k]);
      }
      rows[k].fobs.push(f);
    });
    list.forEach(function (r) {
      r.fobs.sort(function (a, b) { return (a.status === 'off') - (b.status === 'off') || (Number(a.card_number) || 0) - (Number(b.card_number) || 0); });
    });
    return list.sort(function (a, b) { return a.family_name.toLowerCase().localeCompare(b.family_name.toLowerCase()); });
  }

  // A fob's number as printed: 0000786777, or facility,card like 012,00345.
  function fobNumber(q) {
    var pair = String(q).trim().match(/^(\d{1,3})\s*[,.\s/-]\s*(\d{1,5})$/);
    if (pair && Number(pair[1]) <= 255 && Number(pair[2]) <= 65535) return String(Number(pair[1]) * 65536 + Number(pair[2]));
    return null;
  }

  function findFamilies(rows, q) {
    q = String(q || '').trim().toLowerCase();
    if (!q) return rows || [];
    var exact = fobNumber(q);
    var digits = /^\d{3,}$/.test(q) ? String(Number(q)) : null;   // drop leading zeros
    return (rows || []).filter(function (r) {
      if (r.family_name.toLowerCase().indexOf(q) >= 0) return true;
      if (r.address && r.address.toLowerCase().indexOf(q) >= 0) return true;
      return r.fobs.some(function (f) {
        var n = String(f.card_number == null ? '' : f.card_number);
        return (exact && n === exact) || (digits && n.indexOf(digits) >= 0);
      });
    });
  }

  function firstN(rows, n) { return (rows || []).slice(0, Math.max(0, n || 0)); }

  window.PoolsideFold = {
    groupTodos: groupTodos, todoLabel: todoLabel,
    workQueue: workQueue, familyRows: familyRows, findFamilies: findFamilies, firstN: firstN,
  };
})();
