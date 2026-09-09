#!/usr/bin/env node
/**
 * LOUDEN DESK — build-dashboard.mjs
 * -----------------------------------------------------------------------------
 * Scans the Obsidian vault filesystem and computes every metric, time series,
 * and precomputed graph layout the dashboard needs. Zero dependencies.
 *
 *   node build-dashboard.mjs            # writes ./dashboard-data.json
 *   node build-dashboard.mjs --redact   # ...with free-text labels generalised
 *   node build-dashboard.mjs --inline   # also writes ./index.html
 *
 * Vault-derived data only (meeting notes, note activity, check-ins, link graph).
 * Buffer / Gmail numbers come from ./external-data.json via merge-external.mjs.
 *
 * Who and what the vault is about lives in taxonomy.config.mjs (git-ignored);
 * taxonomy.example.mjs is the committed, genericised version.
 * -----------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const HERE = import.meta.dirname;
const OUT = path.join(HERE, 'dashboard-data.json');

// Vault root. Defaults to three levels up (where this folder lives inside the vault);
// override with --vault=/path/to/vault. Guarded below so a clone of this repo sitting
// anywhere else can never walk an unrelated directory tree.
const argOf = k => (process.argv.find(a => a.startsWith('--' + k + '=')) || '').split('=').slice(1).join('=');
const VAULT = argOf('vault') ? path.resolve(argOf('vault')) : path.resolve(HERE, '../../..');
const REDACT = process.argv.includes('--redact');

const NOW = new Date();

// Rolling windows the dashboard can show, in days.
const WINDOWS = { '4w': 28, '12w': 84, '26w': 182, '52w': 364 };
const MAX_WINDOW = 364;

// Taxonomy lives in taxonomy.config.mjs (git-ignored — it names real people and
// folders). Falls back to the committed example so a fresh clone still runs.
const CFG_PATH = fs.existsSync(path.join(HERE, 'taxonomy.config.mjs'))
  ? './taxonomy.config.mjs' : './taxonomy.example.mjs';
const {
  TZ, DOMAINS, PROJECTS, NAME_PREFIX, PERSONAL, NAMES,
  CHECKIN_DIR, CHECKIN_WORK, CHECKIN_LINE_SKIP, CHECKIN_SKIP_SECTION,
  BLOCKER_RE, BULK_DAY_CAP,
} = await import(CFG_PATH);
process.stderr.write('taxonomy: ' + CFG_PATH.replace('./', '') + '\n');

const DOMAIN_BY_DIR = Object.fromEntries(DOMAINS.map(d => [d.dir, d.id]));

// Refuse to scan anything that isn't recognisably the vault.
if (!DOMAINS.some(d => fs.existsSync(path.join(VAULT, d.dir)))) {
  process.stderr.write(
    '\n  This script reads a specific Obsidian vault and found none at:\n    ' + VAULT +
    '\n\n  It is the regeneration tool for the dashboard, not part of viewing it.\n' +
    '  To just look at the dashboard, open index.html — the snapshot is already built.\n' +
    '  To point it at your own vault:  node build-dashboard.mjs --vault=/path/to/vault\n' +
    '  ...after describing it in taxonomy.config.mjs (copy taxonomy.example.mjs).\n\n');
  process.exit(1);
}


// ─────────────────────────────────────────────────────────────────────────────
// SMALL UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const dayKey = d => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
const iso = d => new Date(d).toISOString();
const daysAgo = (a, b = NOW) => Math.floor((b - new Date(a)) / 86400000);
const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const stdev = xs => { const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); };
const uniq = xs => [...new Set(xs)];

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  const fm = {};
  for (const line of text.slice(3, end).split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) fm[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return fm;
}

function walk(dir, hits = [], depth = 0) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return hits; }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, hits, depth + 1);
    else if (e.name.endsWith('.md')) hits.push(full);
  }
  return hits;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLASSIFY
// ─────────────────────────────────────────────────────────────────────────────

function domainOf(relPath) {
  const top = relPath.split('/')[0];
  return DOMAIN_BY_DIR[top] || 'work';
}

function classify({ title = '', relPath = '', body = '', email = '', fallbackDomain = null }) {
  const base = (title || path.basename(relPath, '.md'));
  const hay = `${base}\n${body.slice(0, 2000)}`;

  if (PERSONAL.test(base) || PERSONAL.test(relPath)) return { project: 'personal', personal: true };

  const namePfx = base.toLowerCase().match(/^([a-z]+)[_\d]/);
  if (namePfx && NAME_PREFIX[namePfx[1]]) {
    const p = NAME_PREFIX[namePfx[1]];
    return { project: p, personal: p === 'personal' };
  }

  // priority: title → path → email → named people → body keywords → domain fallback
  for (const p of PROJECTS) if (p.match.title && p.match.title.test(base)) return { project: p.id };
  for (const p of PROJECTS) if (p.match.path && p.match.path.some(s => relPath.includes(s))) return { project: p.id };
  if (email) for (const p of PROJECTS) if (p.match.email && p.match.email.some(s => email.includes(s))) return { project: p.id };
  for (const n of NAMES) if (n.re.test(hay)) return { project: n.project, personal: n.project === 'personal' };
  for (const p of PROJECTS) if (p.match.kw && p.match.kw.test(hay)) return { project: p.id };
  return { project: '_' + (fallbackDomain || domainOf(relPath)) };
}

// ─────────────────────────────────────────────────────────────────────────────
// COLLECT EVENTS
// ─────────────────────────────────────────────────────────────────────────────

const cutoff = new Date(NOW.getTime() - (MAX_WINDOW + 5) * 86400000);
const events = [];      // { ts, source, project, domain, title, relPath, personal }
const notesTouched = []; // { relPath, mtime, project, domain, tags:Set, links:[] } within MAX_WINDOW
const checkinDates = new Set();
let granolaCount2026 = 0;

const allMd = walk(VAULT);
process.stderr.write(`scanned ${allMd.length} markdown files\n`);

for (const full of allMd) {
  const rel = path.relative(VAULT, full);
  if (rel.includes('/Work Dashboard/')) continue; // don't count this tool's own files
  let stat; try { stat = fs.statSync(full); } catch { continue; }

  // ---- Check-ins ----------------------------------------------------------
  if (rel.startsWith(CHECKIN_DIR)) {
    // only the real daily notes: ".../Check-Ins/YYYY/MM MonthName/YYYY-..-..-Ddd.md"
    const folder = rel.match(/Check-Ins\/(\d{4})\/(\d{2})\s/);
    const nums = path.basename(full, '.md').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!folder || !nums) continue;
    const y = +folder[1], mo = +folder[2];
    // filename is YYYY-DD-MM-Ddd; fall back to YYYY-MM-DD if the middle field is the month
    let da = +nums[2] === mo ? +nums[3] : +nums[3] === mo ? +nums[2] : +nums[2];
    if (da < 1 || da > 31) continue;
    const d = new Date(Date.UTC(y, mo - 1, da, 12));
    if (isNaN(d)) continue;
    checkinDates.add(dayKey(d));
    if (d < cutoff || d > NOW) continue;

    let text = ''; try { text = fs.readFileSync(full, 'utf8'); } catch {}
    let curHour = 9;       // set by "- HH:00(...)-HH:00" time-block headers
    let skipSection = false; // inside a dream / routine / gratitude block
    for (const line of text.split('\n')) {
      if (/^#{1,6}\s|^\s*-\s*#{2,6}\s/.test(line)) skipSection = CHECKIN_SKIP_SECTION.test(line);
      const hdr = line.match(/^\s*-\s*(\d{1,2}):00\b/);
      if (hdr) { curHour = clamp(+hdr[1], 0, 23); skipSection = false; continue; }
      if (skipSection) continue;
      const txt = line.replace(/^\s*-\s*\d*\s*/, '').trim();
      if (CHECKIN_LINE_SKIP.test(txt)) continue;
      for (const rule of CHECKIN_WORK) {
        if (!rule.re.test(line)) continue;
        const cl = rule.project ? { project: rule.project } : classify({ title: line, body: line });
        if (cl.personal || cl.project.startsWith('_')) break; // generic line that didn't route → drop
        const ts = new Date(Date.UTC(y, mo - 1, da, curHour + 5)); // CT→UTC (approx, CDT)
        events.push({
          ts: iso(ts), source: 'checkin', project: cl.project, domain: 'work',
          title: line.replace(/^\s*-\s*\d*\s*/, '').replace(/\*\*/g, '').trim().slice(0, 90),
          relPath: rel, blocker: BLOCKER_RE.test(line),
        });
        break;
      }
    }
    continue;
  }

  // ---- Granola meetings --------------------------------------------------
  if (rel.includes('/Granola/')) {
    let text = ''; try { text = fs.readFileSync(full, 'utf8'); } catch {}
    const fm = parseFrontmatter(text);
    const when = fm.meeting_start || fm.created_at || null;
    const title = fm.title || path.basename(full, '.md');
    if (when && new Date(when).getFullYear() === 2026) granolaCount2026++;
    if (!when) continue;
    const d = new Date(when);
    if (isNaN(d) || d < cutoff || d > NOW) continue;
    const body = text.split('\n---')[1] || text;
    const cl = classify({ title, relPath: rel, body, fallbackDomain: 'work' });
    events.push({ ts: iso(d), source: 'meeting', project: cl.project,
      domain: cl.personal ? 'bloodline' : cl.project === 'learning' ? 'learning' : 'work',
      title: title.replace(/_/g, ' ').slice(0, 90), relPath: rel, personal: !!cl.personal,
      blocker: BLOCKER_RE.test(body.slice(0, 1200)) });
    continue;
  }

  // ---- Generic note activity (mtime) -----------------------------------
  const mt = stat.mtime;
  if (mt < cutoff || mt > NOW) continue;
  let head = ''; try { head = fs.readFileSync(full, 'utf8'); } catch {}
  const fm = parseFrontmatter(head);
  const cl = classify({ relPath: rel, body: head });
  const tags = uniq((head.match(/(?:^|\s)#([A-Za-z][\w/-]{2,40})/g) || []).map(s => s.trim().slice(1).toLowerCase()));
  const links = uniq((head.match(/\[\[([^\]|#]+)/g) || []).map(s => s.slice(2).trim()));
  const rec = { relPath: rel, mtime: iso(mt), project: cl.project, domain: domainOf(rel),
    personal: !!cl.personal, tags, links, base: path.basename(full, '.md'),
    created: fm.created || fm.date || null };
  notesTouched.push(rec);
  if (!cl.personal) {
    events.push({ ts: iso(mt), source: 'note', project: cl.project, domain: rec.domain,
      title: rec.base.replace(/_/g, ' ').slice(0, 90), relPath: rel });
  }
}

events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
process.stderr.write(`events: ${events.length} · notesTouched: ${notesTouched.length} · checkins: ${checkinDates.size} · granola2026: ${granolaCount2026}\n`);

// ─────────────────────────────────────────────────────────────────────────────
// ANNOTATE events with cheap primitives (local day / hour / week-bucket)
// ─────────────────────────────────────────────────────────────────────────────

const _parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', hour12: false, weekday: 'short',
});
const NOW_MS = NOW.getTime();
for (const e of events) {
  const d = new Date(e.ts);
  const p = Object.fromEntries(_parts.formatToParts(d).map(x => [x.type, x.value]));
  e._t = d.getTime();
  e._day = `${p.year}-${p.month}-${p.day}`;
  e._hour = (+p.hour) % 24;
  e._dow = p.weekday;                                   // "Mon"
  e._wago = Math.floor((NOW_MS - e._t) / 604800000);    // 0 = last 7 days
}

// last N local calendar days as YYYY-MM-DD (ascending)
const _dfmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayList = days => Array.from({ length: days }, (_, i) => _dfmt.format(new Date(NOW_MS - (days - 1 - i) * 86400000)));
const localDay = ms => _dfmt.format(new Date(ms));

// ─────────────────────────────────────────────────────────────────────────────
// OUTLIER FILTER — cap bulk-edit note events per (day, folder)
// ─────────────────────────────────────────────────────────────────────────────

{
  const perFolder = new Map();     // note events: per (day, folder)
  const perDayNotes = new Map();   // note events: per day (vault-wide, catches reorg days)
  const ci = new Map();            // checkin events: per (day, project)
  const kept = [];
  for (const e of events) {
    if (e.source === 'note') {
      const fk = `${e._day}|${e.relPath.split('/').slice(0, 3).join('/')}`;
      const nf = (perFolder.get(fk) || 0) + 1; perFolder.set(fk, nf);
      const nd = (perDayNotes.get(e._day) || 0) + 1; perDayNotes.set(e._day, nd);
      if (nf <= BULK_DAY_CAP && nd <= 10) kept.push(e);
    } else if (e.source === 'checkin') {
      const k = `${e._day}|${e.project}`;
      const n = (ci.get(k) || 0) + 1; ci.set(k, n);
      if (n <= 3) kept.push(e);     // at most 3 logged items per project per day
    } else kept.push(e);
  }
  process.stderr.write(`outlier filter dropped ${events.length - kept.length} events\n`);
  events.length = 0; events.push(...kept);
}

// ─────────────────────────────────────────────────────────────────────────────
// PROJECT META (resolve fallback buckets into display projects)
// ─────────────────────────────────────────────────────────────────────────────

const PROJECT_META = Object.fromEntries(PROJECTS.map((p, i) => [p.id, {
  id: p.id, name: p.name, codename: p.codename, tagline: p.tagline, num: String(i + 1).padStart(2, '0'),
}]));
for (const d of DOMAINS) {
  PROJECT_META['_' + d.id] = {
    id: '_' + d.id, name: d.dir.replace(/^[^ ]+ /, '').replace(' OG', ''),
    codename: d.id.toUpperCase(), tagline: `general ${d.id} activity`, num: '·',
  };
}
PROJECT_META['personal'] = { id: 'personal', name: 'Personal', codename: 'OFFDUTY', tagline: 'not work', num: '·' };

const codename = id => PROJECT_META[id]?.codename || id.replace(/^_/, '').toUpperCase();
const pname = id => PROJECT_META[id]?.name || id;

// ─────────────────────────────────────────────────────────────────────────────
// INDEXES over workEvents (built once)
// ─────────────────────────────────────────────────────────────────────────────

const workEvents = events.filter(e => !e.personal && e.project !== 'personal');

const byProject = new Map();
for (const e of workEvents) (byProject.get(e.project) || byProject.set(e.project, []).get(e.project)).push(e);

// weekly counts per project (index 0 = last 7d) for sparklines
function weeklyCounts(evts, weeks) {
  const a = new Array(weeks).fill(0);
  for (const e of evts) if (e._wago >= 0 && e._wago < weeks) a[e._wago]++;
  return a.reverse(); // oldest → newest
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-WINDOW BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

function dailySeries(evts, days) {
  const idx = Object.fromEntries(dayList(days).map(d => [d, { date: d, meeting: 0, note: 0, checkin: 0, post: 0, email: 0, total: 0 }]));
  for (const e of evts) {
    const row = idx[e._day];
    if (!row) continue;
    row[e.source] = (row[e.source] || 0) + 1;
    row.total++;
  }
  return Object.values(idx);
}

// Cadence ridge: one ridge per week (0 = current), x = hour of day 0-23.
function cadenceRidge(evts, weeks) {
  const ridges = Array.from({ length: weeks }, (_, w) => ({
    week: localDay(NOW_MS - w * 604800000), hours: new Array(24).fill(0), total: 0,
  }));
  for (const e of evts) {
    if (e._wago < 0 || e._wago >= weeks) continue;
    const r = ridges[e._wago];
    r.hours[e._hour]++; r.total++;
  }
  return ridges.reverse(); // oldest → newest
}

// Project flow: days where two projects were both active.
function projectFlow(evts) {
  const byDay = new Map();
  const byDayProj = new Map();
  for (const e of evts) {
    (byDay.get(e._day) || byDay.set(e._day, new Set()).get(e._day)).add(e.project);
    const k = e._day + '|' + e.project;
    byDayProj.set(k, (byDayProj.get(k) || 0) + 1);
  }
  const pairs = new Map();
  let switchDays = 0;
  for (const set of byDay.values()) {
    const ps = [...set].sort();
    if (ps.length > 1) switchDays++;
    for (let i = 0; i < ps.length; i++)
      for (let j = i + 1; j < ps.length; j++) {
        const k = ps[i] + '|' + ps[j];
        pairs.set(k, (pairs.get(k) || 0) + 1);
      }
  }
  let deepestDay = { day: null, project: null, count: 0 };
  for (const [k, c] of byDayProj) {
    const [day, project] = k.split('|');
    if (c > deepestDay.count && byDay.get(day)?.size === 1) deepestDay = { day, project, count: c };
  }
  const nDays = byDay.size || 1;
  const pairArr = [...pairs].map(([k, v]) => ({ a: k.split('|')[0], b: k.split('|')[1], days: v })).sort((x, y) => y.days - x.days);
  return {
    nodes: uniq(evts.map(e => e.project)),
    pairs: pairArr,
    switchRate: +(switchDays / nDays).toFixed(2),
    deepestDay,
    tightestPair: pairArr[0] || null,
  };
}

function domainBalance(winEvts, prevEvts) {
  const tally = es => { const t = {}; for (const e of es) t[e.domain] = (t[e.domain] || 0) + 1; return t; };
  const cur = tally(winEvts), prev = tally(prevEvts);
  const curTot = Object.values(cur).reduce((s, x) => s + x, 0) || 1;
  const prevTot = Object.values(prev).reduce((s, x) => s + x, 0) || 1;
  return DOMAINS.map(d => ({
    id: d.id, emoji: d.emoji,
    share: +(100 * (cur[d.id] || 0) / curTot).toFixed(1),
    prevShare: +(100 * (prev[d.id] || 0) / prevTot).toFixed(1),
    count: cur[d.id] || 0,
  }));
}

function roster(days) {
  const winMs = NOW_MS - days * 86400000;
  const defined = new Set(PROJECTS.map(p => p.id));
  const out = [];
  const ids = uniq([...PROJECTS.map(p => p.id), ...workEvents.map(e => e.project)]);
  for (const id of ids) {
    const es = byProject.get(id);
    if (!es || !es.length) continue;
    const winCount = es.filter(e => e._t >= winMs).length;
    // fallback buckets only appear when they have activity this window
    if (!defined.has(id) && winCount === 0) continue;
    const last = es[es.length - 1];
    const ageDays = Math.floor((NOW_MS - last._t) / 86400000);
    const recentBlocker = es.slice(-6).some(e => e.blocker);
    out.push({
      ...(PROJECT_META[id] || { id, name: id, codename: codename(id), tagline: '', num: '·' }),
      events: winCount,
      lastTouch: last.ts, ageDays,
      spark: weeklyCounts(es, 12),
      status: winCount === 0 ? 'dormant' : ageDays <= 3 ? 'active' : ageDays <= 10 ? 'warm' : 'cold',
      blocker: recentBlocker && ageDays >= 4 && ageDays <= 45,
      lastTitle: ageDays <= 120 ? last.title : null, lastSource: last.source,
    });
  }
  return out.sort((a, b) => b.events - a.events);
}

function streak() {
  let s = 0;
  for (let i = 0; i < 3000; i++) {
    const d = localDay(NOW_MS - i * 86400000);
    if (checkinDates.has(d)) s++;
    else if (i === 0) continue; // today's check-in may not be written yet
    else break;
  }
  let longest = 0, run = 0, prev = null;
  for (const d of [...checkinDates].sort()) {
    const t = Date.parse(d);
    run = prev && t - prev === 86400000 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = t;
  }
  let activeThisMonth = 0;
  const mo = _dfmt.format(NOW).slice(0, 7);
  for (const d of checkinDates) if (d.startsWith(mo)) activeThisMonth++;
  return { current: s, longest, activeThisMonth, dayOfMonth: NOW.getDate(), totalLogged: checkinDates.size };
}

// ─────────────────────────────────────────────────────────────────────────────
// KNOWLEDGE GRAPH — computed once, 84-day lookback, node-capped
// ─────────────────────────────────────────────────────────────────────────────

function knowledgeGraph(days = 84) {
  const startMs = NOW_MS - days * 86400000;
  const byBase = new Map();
  for (const n of notesTouched) {
    if (n.personal) continue;
    if (new Date(n.mtime).getTime() < startMs) continue;
    const k = n.base.toLowerCase();
    const cur = byBase.get(k);
    if (cur) { cur.edits++; cur.tags = uniq([...cur.tags, ...n.tags]); cur.links = uniq([...cur.links, ...n.links]); }
    else byBase.set(k, { ...n, edits: 1 });
  }
  const all = [...byBase.values()];
  const idByBase = new Map(all.map((n, i) => [n.base.toLowerCase(), i]));

  // build candidate edges over ALL notes first
  const rawEdges = [];
  const seen = new Set();
  const add = (s, t, kind) => {
    if (s == null || t == null || s === t) return;
    const k = s < t ? `${s}-${t}` : `${t}-${s}`;
    if (seen.has(k)) return;
    seen.add(k); rawEdges.push({ s, t, kind });
  };
  all.forEach((n, i) => { for (const l of n.links) add(i, idByBase.get(l.toLowerCase()), 'link'); });
  const linkEdges = rawEdges.length;
  const tagMap = {};
  all.forEach((n, i) => { for (const t of n.tags) (tagMap[t] ||= []).push(i); });
  for (const arr of Object.values(tagMap)) {
    const u = uniq(arr);
    if (u.length < 2 || u.length > 5) continue;
    for (let i = 0; i < u.length; i++) for (let j = i + 1; j < u.length; j++) add(u[i], u[j], 'tag');
  }

  // keep only connected notes (+ up to 6 most-edited singletons for context)
  const degAll = new Array(all.length).fill(0);
  for (const e of rawEdges) { degAll[e.s]++; degAll[e.t]++; }
  const keep = new Set(all.map((_, i) => i).filter(i => degAll[i] > 0));
  all.map((n, i) => [i, n.edits]).filter(([i]) => !keep.has(i))
    .sort((a, b) => b[1] - a[1]).slice(0, 6).forEach(([i]) => keep.add(i));

  const noteGraph = keep.size >= 10;
  let nodes, edges;

  if (noteGraph) {
    const remap = new Map([...keep].map((old, i) => [old, i]));
    nodes = [...keep].map(old => {
      const n = all[old];
      return { id: remap.get(old), base: n.base, project: n.project, domain: n.domain,
        edits: n.edits, r: +clamp(3.5 + Math.sqrt(n.edits) * 1.9, 3.5, 14).toFixed(1) };
    });
    edges = rawEdges.filter(e => keep.has(e.s) && keep.has(e.t))
      .map(e => ({ s: remap.get(e.s), t: remap.get(e.t), kind: e.kind }));
  } else {
    // fallback: project co-occurrence over the lookback (projects as nodes)
    const evts = workEvents.filter(e => e._t >= startMs);
    const cnt = {}, byDay = {};
    for (const e of evts) { cnt[e.project] = (cnt[e.project] || 0) + 1; (byDay[e._day] ||= new Set()).add(e.project); }
    const ids = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]);
    const ix = Object.fromEntries(ids.map((p, i) => [p, i]));
    const mx = Math.max(1, ...Object.values(cnt));
    nodes = ids.map(p => ({ id: ix[p], base: PROJECT_META[p]?.name || p, project: p,
      domain: 'work', edits: cnt[p], r: +clamp(5 + Math.sqrt(cnt[p] / mx) * 14, 5, 20).toFixed(1) }));
    const pair = {};
    for (const set of Object.values(byDay)) {
      const ps = [...set];
      for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
        const k = [ps[i], ps[j]].sort().join('|'); pair[k] = (pair[k] || 0) + 1;
      }
    }
    edges = Object.entries(pair).filter(([, v]) => v >= 2)
      .map(([k, v]) => ({ s: ix[k.split('|')[0]], t: ix[k.split('|')[1]], kind: 'link', w: v }));
  }

  layout(nodes, edges, 220);
  const deg = new Array(nodes.length).fill(0);
  for (const e of edges) { deg[e.s]++; deg[e.t]++; }
  nodes.forEach((n, i) => { n.deg = deg[i]; });
  const top = [...nodes].sort((a, b) => b.deg - a.deg)[0];
  return {
    mode: noteGraph ? 'notes' : 'projects',
    nodes, edges,
    stats: {
      notes: nodes.length, edges: edges.length, linkEdges,
      mostConnected: top?.base || null, mostConnectedDeg: top?.deg || 0,
      clusters: uniq(nodes.map(n => n.project)).length,
      lookbackDays: days,
    },
  };
}

// Cluster-then-relax layout → node.x in [PAD, 1000-PAD], node.y in [PAD, 560-PAD].
// Deterministic. Groups nodes by project into blobs around a ring, then a short
// force relax to declump and pull cross-project links together.
function layout(nodes, edges, iters) {
  const W = 1000, H = 560, cx = W / 2, cy = H / 2, PAD = 28;
  const n = nodes.length;
  if (!n) return;

  // order groups biggest-first so the largest clusters get the roomy ring points
  const groups = [...new Set(nodes.map(nd => nd.project))]
    .map(g => [g, nodes.filter(nd => nd.project === g)])
    .sort((a, b) => b[1].length - a[1].length);
  const RX = 372, RY = 150;
  groups.forEach(([, m], i) => {
    const a = -Math.PI / 2 + (i / groups.length) * 2 * Math.PI;
    const gx = groups.length === 1 ? cx : cx + RX * Math.cos(a);
    const gy = groups.length === 1 ? cy : cy + RY * Math.sin(a);
    const spread = 8 + Math.sqrt(m.length) * 9;
    m.forEach((nd, k) => {
      const aa = k * 2.399963, rr = spread * Math.sqrt((k + 0.4) / m.length);
      nd.x = gx + rr * Math.cos(aa); nd.y = gy + rr * Math.sin(aa);
    });
  });

  const adj = nodes.map(() => []);
  for (const e of edges) { adj[e.s].push(e.t); adj[e.t].push(e.s); }

  for (let it = 0; it < iters; it++) {
    const cool = 1 - it / iters;
    for (let i = 0; i < n; i++) {
      let fx = 0, fy = 0;
      for (let j = 0; j < n; j++) {               // short-range repulsion only
        if (i === j) continue;
        const dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y;
        const d2 = dx * dx + dy * dy || 1;
        if (d2 > 9000) continue;
        const d = Math.sqrt(d2), rep = 520 / d;
        fx += (dx / d) * rep; fy += (dy / d) * rep;
      }
      for (const j of adj[i]) {                   // springs pull toward ~58px
        const dx = nodes[j].x - nodes[i].x, dy = nodes[j].y - nodes[i].y;
        const d = Math.hypot(dx, dy) || 1;
        fx += (dx / d) * (d - 58) * 0.5; fy += (dy / d) * (d - 58) * 0.5;
      }
      fx += (cx - nodes[i].x) * 0.03;
      fy += (cy - nodes[i].y) * 0.03;
      const step = Math.min(Math.hypot(fx, fy), 10) * cool;
      const m = Math.hypot(fx, fy) || 1;
      nodes[i].x = clamp(nodes[i].x + (fx / m) * step, PAD, W - PAD);
      nodes[i].y = clamp(nodes[i].y + (fy / m) * step, PAD, H - PAD);
    }
  }
  for (const nd of nodes) { nd.x = Math.round(nd.x); nd.y = Math.round(nd.y); }
}

// ─────────────────────────────────────────────────────────────────────────────
// ASSEMBLE
// ─────────────────────────────────────────────────────────────────────────────

const wkCount = n => workEvents.reduce((c, e) => c + (e._wago === n ? 1 : 0), 0);
const thisWk = wkCount(0);
const trailing = mean([wkCount(1), wkCount(2), wkCount(3), wkCount(4)]);
const momentum = trailing ? Math.round(100 * (thisWk - trailing) / trailing) : 0;

const graph = knowledgeGraph(84);

const focusEvts = workEvents.filter(e => e._wago === 0);
const focusTally = {};
for (const e of focusEvts) focusTally[e.project] = (focusTally[e.project] || 0) + 1;
const focusId = Object.entries(focusTally).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
const focus = focusId ? {
  project: focusId, meta: PROJECT_META[focusId] || null, events7d: focusTally[focusId],
  lastTitle: [...focusEvts].reverse().find(e => e.project === focusId)?.title || null,
  recent: [...focusEvts].filter(e => e.project === focusId).slice(-5).reverse().map(e => ({ ts: e.ts, title: e.title, source: e.source })),
} : null;

const windows = {};
for (const [label, days] of Object.entries(WINDOWS)) {
  const weeks = Math.round(days / 7);
  const winMs = NOW_MS - days * 86400000;
  const prevMs = NOW_MS - 2 * days * 86400000;
  const inWin = workEvents.filter(e => e._t >= winMs);
  const inPrev = workEvents.filter(e => e._t >= prevMs && e._t < winMs);
  const daily = dailySeries(inWin, days);
  const counts = daily.map(d => d.total);
  const spanDays = Math.round((NOW_MS - winMs) / 86400000) + 1;
  const activeDays = uniq(inWin.map(e => e._day)).length;

  const hourHist = new Array(24).fill(0);
  const dowHist = new Array(7).fill(0);
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (const e of inWin) { hourHist[e._hour]++; dowHist[DOW.indexOf(e._dow)]++; }
  const daysSorted = uniq(inWin.map(e => e._day)).sort();
  let longestGap = 0;
  for (let i = 1; i < daysSorted.length; i++)
    longestGap = Math.max(longestGap, Math.round((new Date(daysSorted[i]) - new Date(daysSorted[i - 1])) / 86400000) - 1);

  // only compare to prior window when we actually scanned enough history for it
  const prevReliable = inPrev.length >= 15 && days <= 182;

  windows[label] = {
    days, weeks,
    kpi: {
      output: inWin.length,
      outputPrev: prevReliable ? inPrev.length : null,
      outputDelta: prevReliable ? Math.round(100 * (inWin.length - inPrev.length) / inPrev.length) : null,
      activeDays, perActiveDay: +(inWin.length / (activeDays || 1)).toFixed(1),
      perWeek: +(inWin.length / weeks).toFixed(1),
    },
    history: daily,
    ridge: cadenceRidge(inWin, clamp(weeks, 4, 16)),
    cadenceStats: {
      activeDaysPerWeek: +Math.min(7, activeDays / weeks).toFixed(1),
      showUpRate: Math.min(100, Math.round(100 * activeDays / spanDays)), // % of days with ≥1 event
      peakHour: hourHist.indexOf(Math.max(...hourHist)),
      peakDow: DOW[dowHist.indexOf(Math.max(...dowHist))],
      longestGapDays: longestGap,
      volumeEvenness: Math.round(100 * (1 - clamp(stdev(counts) / (mean(counts) || 1), 0, 1))),
    },
    flow: projectFlow(inWin),
    domainBalance: domainBalance(inWin, inPrev),
    roster: roster(days),
  };
}

const log = [...workEvents].slice(-280).reverse().map(e => ({
  ts: e.ts, source: e.source, project: e.project,
  codename: codename(e.project), name: pname(e.project),
  title: e.title, blocker: !!e.blocker,
}));

const data = {
  generatedAt: iso(NOW),
  tz: TZ,
  vault: path.basename(VAULT),
  scan: {
    files: allMd.length, events: events.length, workEvents: workEvents.length,
    notesTouched: notesTouched.length, granola2026: granolaCount2026, checkinsLogged: checkinDates.size,
  },
  projects: PROJECT_META,
  domains: DOMAINS.map(d => ({ id: d.id, emoji: d.emoji })),
  streak: streak(),
  momentum: { pct: momentum, thisWeek: thisWk, trailingAvg: +trailing.toFixed(1),
    weeks: [wkCount(5), wkCount(4), wkCount(3), wkCount(2), wkCount(1), wkCount(0)] },
  focus,
  graph,
  windows,
  log,
  external: null,
};

// ── --inline ONLY: don't rebuild the JSON, just bake the (possibly merged) file into HTML
if (process.argv.includes('--inline')) {
  let payload;
  try { payload = JSON.parse(fs.readFileSync(OUT, 'utf8')); }
  catch { payload = data; process.stderr.write('⚠ no dashboard-data.json on disk — inlining fresh vault data\n'); }
  const tpl = fs.readFileSync(path.join(HERE, 'dashboard.html'), 'utf8');
  const inlined = tpl.replace(
    /\/\* *DATA_PLACEHOLDER *\*\/[\s\S]*?\/\* *END_DATA *\*\//,
    `/* DATA_PLACEHOLDER */\nwindow.__DESK__ = ${JSON.stringify(payload)};\n/* END_DATA */`);
  fs.writeFileSync(path.join(HERE, 'index.html'), inlined);
  process.stderr.write(`✓ wrote index.html (external: ${payload.external ? 'merged' : 'none'})\n`);
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// REDACTION (--redact) — keep every number, generalise every free-text label.
// Used for the public snapshot so third parties named in note and meeting titles
// aren't published. Charts, counts, cadence, streak and roster stats are untouched.
// ─────────────────────────────────────────────────────────────────────────────

const SOURCE_VERB = {
  meeting: 'Meeting', note: 'Note updated', checkin: 'Logged activity',
  post: 'Post published', email: 'Outreach sent',
};

function redactAll(D) {
  const label = (source, project) => `${SOURCE_VERB[source] || 'Activity'} · ${pname(project)}`;

  D.log = D.log.map(e => ({ ...e, title: label(e.source, e.project) }));

  const seq = {};
  const baseMap = new Map();
  for (const n of D.graph.nodes) {
    seq[n.project] = (seq[n.project] || 0) + 1;
    const nb = `${pname(n.project)} · note ${seq[n.project]}`;
    baseMap.set(n.base, nb);
    n.base = nb;
  }
  if (D.graph.stats.mostConnected)
    D.graph.stats.mostConnected = baseMap.get(D.graph.stats.mostConnected) || 'note';

  if (D.focus) {
    D.focus.lastTitle = label('note', D.focus.project);
    D.focus.recent = (D.focus.recent || []).map(r => ({ ...r, title: label(r.source, D.focus.project) }));
  }
  for (const W of Object.values(D.windows))
    for (const r of W.roster)
      if (r.lastTitle) r.lastTitle = label(r.lastSource || 'note', r.id);

  D.redacted = true;
  return D;
}

if (REDACT) { redactAll(data); process.stderr.write('✓ redacted — free-text labels generalised\n'); }

// sanity asserts
const A = [];
if (granolaCount2026 < 400) A.push(`granola2026 low: ${granolaCount2026}`);
if (data.streak.current < 1) A.push('streak < 1');
if (workEvents.some(e => !e.project)) A.push('event without project');
for (const w of Object.values(windows))
  if (w.history.some(d => d.total > 55)) A.push(`history day > 55 (${w.days}d win)`);
if (A.length) process.stderr.write('⚠ ' + A.join(' | ') + '\n');
else process.stderr.write('✓ sanity checks passed\n');

fs.writeFileSync(OUT, JSON.stringify(data));
process.stderr.write(`✓ wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)\n`);
