// Stand-ins for Google Drive + Sheets and for the Supabase client, kept in
// memory, so the real backup code can run offline (PLAN.md BO, BP).
//
//   const g = fakeGoogle(); globalThis.fetch = g.fetch;   // g.files, g.sheets, g.formats
//   const db = fakeDb({ tenants: [...], ... });            // db.from(...), db.tables
//
// Each tab keeps what a person would see: rows, and its look (text and
// wrapped columns, widths, frozen rows and columns, tab color, banding,
// conditional color rules). A batchUpdate is all or nothing, like Google's:
// adding banding where there already is some fails the whole batch. A
// formula typed into a column formatted as text stays text, shown here as
// "TEXTFORMULA:=…".
// ── A pretend Google ────────────────────────────────────────────────────
export function fakeGoogle() {
  const g = { files: {}, sheets: {}, formats: [], n: 0, calls: [] };
  const id = p => `${p}${++g.n}`;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const tabOf = (sid, title) => g.sheets[sid]?.tabs.find(t => t.title === title);
  const parseRange = r => { const [title, cells = ''] = decodeURIComponent(r).split('!'); return { title, cells }; };
  const colIdx = letters => [...letters].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;
  // Sheets with USER_ENTERED reads "+14085551234" as a number; "408-555-1234" stays text.
  const entered = v => (typeof v === 'string' && /^[+-]?\d+(\.\d+)?$/.test(v)) ? Number(v) : (typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v);
  const typed = (tab, i, v) => {
    if (!tab.text?.has(i) || typeof v !== 'string') return entered(v);
    if (v.startsWith('=')) return `TEXTFORMULA:${v}`;
    return v.startsWith("'") ? v.slice(1) : v;
  };
  g.fetch = async (url, init = {}) => {
    const u = new URL(url); const m = (init.method || 'GET').toUpperCase();
    g.calls.push(`${m} ${u.pathname}`);
    if (u.host === 'oauth2.googleapis.com') return json({ access_token: 'at' });
    if (u.pathname.startsWith('/upload/drive/v3/files')) {
      const body = new TextDecoder().decode(init.body);
      const meta = JSON.parse(body.slice(body.indexOf('{'), body.indexOf('}\r\n') + 1));
      const fid = id('pdf'); g.files[fid] = { id: fid, name: meta.name, mimeType: meta.mimeType, parents: meta.parents, trashed: false };
      return json({ id: fid });
    }
    if (u.pathname === '/drive/v3/files' && m === 'GET') {
      const q = u.searchParams.get('q');
      const name = q.match(/name = '((?:[^'\\]|\\.)*)'/)[1].replace(/\\'/g, "'");
      const parent = q.match(/'([^']+)' in parents/)[1];
      const mime = (q.match(/mimeType = '([^']+)'/) || [])[1];
      const hit = Object.values(g.files).find(f => f.name === name && f.parents.includes(parent) && !f.trashed && (!mime || f.mimeType === mime));
      return json({ files: hit ? [{ id: hit.id, name: hit.name }] : [] });
    }
    if (u.pathname === '/drive/v3/files' && m === 'POST') {
      const b = JSON.parse(init.body);
      const fid = id(b.mimeType.endsWith('spreadsheet') ? 'sheet' : 'folder');
      g.files[fid] = { id: fid, name: b.name, mimeType: b.mimeType, parents: b.parents, trashed: false };
      if (b.mimeType.endsWith('spreadsheet')) g.sheets[fid] = { tabs: [{ sheetId: 0, title: 'Sheet1', rows: [] }] };
      return json({ id: fid });
    }
    const fm = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (fm) { const f = g.files[fm[1]]; return f ? json({ id: f.id, trashed: f.trashed }) : json({ error: 'notFound' }, 404); }
    const sm = u.pathname.match(/^\/v4\/spreadsheets\/([^/:]+)(.*)$/);
    if (sm) {
      const [, sid, rest] = sm; const sh = g.sheets[sid];
      if (!sh) return json({ error: 'not found' }, 404);
      if (rest === '' && m === 'GET') return json({ sheets: sh.tabs.map((t, index) => ({
        properties: { sheetId: t.sheetId, title: t.title, index },
        bandedRanges: (t.banding || []).map(b => ({ bandedRangeId: b.bandedRangeId })),
        conditionalFormats: (t.rules || []).map(r => ({ ranges: r.ranges, booleanRule: r.booleanRule })),
      })) });
      if (rest === ':batchUpdate') {
        const reqs = JSON.parse(init.body).requests; const replies = [];
        const byId = sheetId => sh.tabs.find(x => x.sheetId === sheetId);
        // All or nothing: check the ones Google refuses first.
        const sim = new Map(sh.tabs.map(t => [t.sheetId, { banding: (t.banding || []).length, rules: (t.rules || []).length }]));
        for (const r of reqs) {
          if (r.addBanding) { const c = sim.get(r.addBanding.bandedRange.range.sheetId); if (c && c.banding > 0) return json({ error: { message: 'Invalid requests: You cannot add alternating background colors to a range that already has alternating background colors.' } }, 400); if (c) c.banding++; }
          if (r.deleteBanding) { const t = sh.tabs.find(x => (x.banding || []).some(b => b.bandedRangeId === r.deleteBanding.bandedRangeId)); if (!t) return json({ error: { message: 'No banded range with that id' } }, 400); sim.get(t.sheetId).banding--; }
          if (r.deleteConditionalFormatRule) { const c = sim.get(r.deleteConditionalFormatRule.sheetId); if (!c || r.deleteConditionalFormatRule.index >= c.rules) return json({ error: { message: 'No conditional format at that index' } }, 400); c.rules--; }
          if (r.addConditionalFormatRule) { const c = sim.get(r.addConditionalFormatRule.rule.ranges[0].sheetId); if (c) c.rules++; }
        }
        for (const r of reqs) {
          let reply = {};
          if (r.addSheet) {
            const p = r.addSheet.properties, t = { sheetId: 1000 + (++g.n), title: p.title, rows: [], color: p.tabColorStyle?.rgbColor, frozen: { rows: p.gridProperties?.frozenRowCount || 0, cols: 0 } };
            typeof p.index === 'number' ? sh.tabs.splice(p.index, 0, t) : sh.tabs.push(t);
            reply = { addSheet: { properties: { sheetId: t.sheetId, title: t.title } } };
          } else if (r.deleteSheet) sh.tabs = sh.tabs.filter(t => t.sheetId !== r.deleteSheet.sheetId);
          else if (r.addBanding) { const t = byId(r.addBanding.bandedRange.range.sheetId); const b = { bandedRangeId: ++g.n }; (t.banding ||= []).push(b); reply = { addBanding: { bandedRange: b } }; }
          else if (r.deleteBanding) { for (const t of sh.tabs) t.banding = (t.banding || []).filter(b => b.bandedRangeId !== r.deleteBanding.bandedRangeId); }
          else if (r.addConditionalFormatRule) { const t = byId(r.addConditionalFormatRule.rule.ranges[0].sheetId); (t.rules ||= []).splice(r.addConditionalFormatRule.index ?? t.rules.length, 0, r.addConditionalFormatRule.rule); }
          else if (r.deleteConditionalFormatRule) { const t = byId(r.deleteConditionalFormatRule.sheetId); t.rules.splice(r.deleteConditionalFormatRule.index, 1); }
          else if (r.updateSheetProperties) {
            const p = r.updateSheetProperties.properties, t = byId(p.sheetId), f = r.updateSheetProperties.fields;
            if (/frozenRowCount/.test(f)) (t.frozen ||= {}).rows = p.gridProperties?.frozenRowCount ?? 0;
            if (/frozenColumnCount/.test(f)) (t.frozen ||= {}).cols = p.gridProperties?.frozenColumnCount ?? 0;
            if (/tabColor/.test(f)) t.color = p.tabColorStyle?.rgbColor;
          } else if (r.updateDimensionProperties?.range?.dimension === 'COLUMNS') {
            const d = r.updateDimensionProperties; const t = byId(d.range.sheetId);
            for (let i = d.range.startIndex; i < d.range.endIndex; i++) (t.widths ||= {})[i] = d.properties.pixelSize;
          } else {
            g.formats.push(r);
            // A column formatted as text keeps what's entered as typed (a zip's leading zero).
            const rc = r.repeatCell;
            if (rc && (rc.range.startRowIndex ?? 0) >= 1) {
              const t = byId(rc.range.sheetId); const fmt = rc.cell?.userEnteredFormat || {};
              for (let i = rc.range.startColumnIndex; i < (rc.range.endColumnIndex ?? rc.range.startColumnIndex + 1); i++) {
                if (/numberFormat/.test(rc.fields)) fmt.numberFormat?.type === 'TEXT' ? (t.text ||= new Set()).add(i) : t.text?.delete(i);
                if (/wrapStrategy/.test(rc.fields)) fmt.wrapStrategy === 'WRAP' ? (t.wrap ||= new Set()).add(i) : t.wrap?.delete(i);
              }
            }
          }
          replies.push(reply);
        }
        return json({ replies });
      }
      const vm = rest.match(/^\/values\/([^:?]+)(:append)?$/);
      if (vm) {
        const { title, cells } = parseRange(vm[1]); const tab = tabOf(sid, title);
        if (!tab) return json({ error: { message: `Unable to parse range: ${title}` } }, 400);
        if (vm[2] === ':append') {
          const vals = JSON.parse(init.body).values[0].map((v, i) => typed(tab, i, v));
          tab.rows.push(vals); const r = tab.rows.length;
          return json({ updates: { updatedRange: `${title}!A${r}:Z${r}` } });
        }
        if (m === 'PUT') {
          const vals = JSON.parse(init.body).values; const a1 = cells.match(/^([A-Z]+)(\d+)/);
          const c0 = colIdx(a1[1]), r0 = Number(a1[2]) - 1;
          vals.forEach((rv, i) => { tab.rows[r0 + i] = tab.rows[r0 + i] || []; rv.forEach((v, j) => { tab.rows[r0 + i][c0 + j] = typed(tab, c0 + j, v); }); });
          return json({});
        }
        // GET: a whole row ("1:1"), a column from row 2 ("T2:T"), one cell ("S3"), or a block.
        let mm;
        if ((mm = cells.match(/^(\d+):(\d+)$/))) return json({ values: tab.rows[Number(mm[1]) - 1] ? [tab.rows[Number(mm[1]) - 1].map(String)] : [] });
        if ((mm = cells.match(/^([A-Z]+)(\d+):([A-Z]+)$/))) { const c = colIdx(mm[1]); return json({ values: [tab.rows.slice(Number(mm[2]) - 1).map(r => String(r?.[c] ?? ''))] }); }
        if ((mm = cells.match(/^([A-Z]+)(\d+)$/))) { const v = tab.rows[Number(mm[2]) - 1]?.[colIdx(mm[1])]; return json(v == null || v === '' ? {} : { values: [[String(v)]] }); }
        return json({ values: tab.rows.length ? tab.rows.map(r => Array.from(r, v => String(v ?? ''))) : undefined });
      }
    }
    return json({ error: `fake google: no route for ${m} ${u.pathname}` }, 501);
  };
  return g;
}

// ── A pretend database ──────────────────────────────────────────────────
export function fakeDb(tables) {
  const T = tables;
  const like = (v, pat) => new RegExp('^' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$').test(String(v ?? ''));
  function q(table) {
    const st = { tests: [], op: 'select', patch: null, rows: null, order: null, limit: null };
    const match = r => st.tests.every(t => t(r));
    const run = () => {
      const all = T[table] = T[table] || [];
      if (st.op === 'insert') { const made = st.rows.map(r => ({ id: `id${all.length + 1}`, ...r })); all.push(...made); return { data: made, error: null }; }
      if (st.op === 'update') { for (const r of all.filter(match)) Object.assign(r, st.patch); return { data: null, error: null }; }
      if (st.op === 'delete') { T[table] = all.filter(r => !match(r)); return { data: null, error: null }; }
      if (st.op === 'upsert') { for (const r of st.rows) { const hit = all.find(x => x.tenant_id === r.tenant_id && (!r.application_id || x.application_id === r.application_id)); hit ? Object.assign(hit, r) : all.push({ id: `id${all.length + 1}`, ...r }); } return { data: null, error: null }; }
      let out = all.filter(match);
      if (st.order) { const [k, asc] = st.order; out = [...out].sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * (asc ? 1 : -1)); }
      if (st.limit != null) out = out.slice(0, st.limit);
      return { data: out, error: null };
    };
    const b = {
      select: () => b,
      order: (k, o = {}) => { st.order = [k, o.ascending !== false]; return b; },
      limit: n => { st.limit = n; return b; },
      eq:  (k, v) => { st.tests.push(r => r[k] === v); return b; },
      neq: (k, v) => { st.tests.push(r => r[k] !== v); return b; },
      in:  (k, vs) => { st.tests.push(r => vs.includes(r[k])); return b; },
      is:  (k, v) => { st.tests.push(r => (v === null ? r[k] == null : r[k] === v)); return b; },
      not: (k, op, v) => { st.tests.push(r => (op === 'is' ? (v === null ? r[k] != null : r[k] !== v) : op === 'like' ? !like(r[k], v) : true)); return b; },
      insert: rows => { st.op = 'insert'; st.rows = Array.isArray(rows) ? rows : [rows]; return b; },
      update: patch => { st.op = 'update'; st.patch = patch; return b; },
      delete: () => { st.op = 'delete'; return b; },
      upsert: rows => { st.op = 'upsert'; st.rows = Array.isArray(rows) ? rows : [rows]; return b; },
      // Like PostgREST: two or more rows is an error, not the first row (PLAN.md BS5).
      maybeSingle: async () => {
        const r = run();
        if (Array.isArray(r.data) && r.data.length > 1) return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } };
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: null };
      },
      then: (res, rej) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  }
  return { from: q, tables: T };
}
