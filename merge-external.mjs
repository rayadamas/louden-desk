#!/usr/bin/env node
/**
 * merge-external.mjs — fold Buffer / Gmail signals into the dashboard.
 *
 *   node merge-external.mjs            # rebuild external-data.json from RAW below,
 *                                      # then merge it into dashboard-data.json
 *
 * RAW is hand-updated by Claude when it re-pulls Buffer + Gmail via MCP. Everything
 * else in the dashboard comes straight from the vault (build-dashboard.mjs) and does
 * not need this step. If external-data.json is absent the dashboard still renders —
 * the content + outreach bands just read 0.
 */

import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const TZ = 'America/Chicago';

// ── RAW: pulled 2026-09-07 via MCP (Buffer aggregate metrics + Gmail sent estimates) ──
const RAW = {
  pulledAt: '2026-09-07T17:00:00-05:00',
  buffer: {
    channels: 'LinkedIn (Diamond Louden + Quincy Labs) · X (@0xBey)',
    // exact daily post counts for the recent stretch (Buffer list_posts, status=sent)
    dailyPosts: {
      '2026-08-25': 17, '2026-08-26': 9, '2026-08-27': 11, '2026-08-28': 9, '2026-08-29': 7,
      '2026-08-30': 4, '2026-08-31': 4, '2026-09-01': 5, '2026-09-02': 9, '2026-09-03': 5,
      '2026-09-04': 10, '2026-09-05': 4, '2026-09-06': 3, '2026-09-07': 3,
    },
    // older stretches as period rates (aggregate postCount / span)
    periods: [
      { start: '2026-08-10', end: '2026-08-24', posts: 76, impressions: 120560 },
      { start: '2026-06-09', end: '2026-08-09', posts: 46, impressions: 34509 },
      { start: '2026-03-11', end: '2026-06-08', posts: 37, impressions: 5247 },
      { start: '2025-09-08', end: '2026-03-10', posts: 83, impressions: 4089 },
    ],
    window12w: { posts: 225, impressions: 177656, reactions: 437, comments: 97, engagementRate: 0.3 },
  },
  gmail: {
    note: 'sent-thread estimates (coarse — Gmail resultCountEstimate)',
    periods: [
      { start: '2026-08-24', end: '2026-09-07', sent: 19 },
      { start: '2026-08-10', end: '2026-08-23', sent: 21 },
      { start: '2026-06-09', end: '2026-08-09', sent: 95 },
      { start: '2026-03-11', end: '2026-06-08', sent: 14 },
    ],
  },
};

// ── expand to a daily {date, post, email} series over the last 180 days ──
const NOW = new Date();
const dfmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const day = ms => dfmt.format(new Date(ms));

const daily = {};
for (let i = 0; i < 200; i++) daily[day(NOW.getTime() - i * 86400000)] = { post: 0, email: 0 };

// exact posts
for (const [d, n] of Object.entries(RAW.buffer.dailyPosts)) if (daily[d]) daily[d].post = n;

// distribute a period count across its days, deterministically, whole units
function spread(field, start, end, total) {
  const days = [];
  for (let t = Date.parse(start + 'T12:00'); t <= Date.parse(end + 'T12:00'); t += 86400000) {
    const k = day(t); if (k in daily && !(field === 'post' && RAW.buffer.dailyPosts[k])) days.push(k);
  }
  if (!days.length) return;
  const per = total / days.length;
  let carry = 0;
  for (const k of days) { carry += per; const give = Math.floor(carry); daily[k][field] += give; carry -= give; }
}
for (const p of RAW.buffer.periods) spread('post', p.start, p.end, p.posts);
for (const p of RAW.gmail.periods) spread('email', p.start, p.end, p.sent);

const external = {
  generatedAt: RAW.pulledAt,
  tz: TZ,
  buffer: RAW.buffer.window12w,
  bufferChannels: RAW.buffer.channels,
  gmailNote: RAW.gmail.note,
  impressionsTrail: RAW.buffer.periods.map(p => ({ start: p.start, end: p.end, impressions: p.impressions, posts: p.posts })),
  daily: Object.entries(daily).sort().map(([date, v]) => ({ date, ...v })),
};

fs.writeFileSync(path.join(HERE, 'external-data.json'), JSON.stringify(external, null, 0));
process.stderr.write(`✓ external-data.json — ${external.daily.length} days, ${external.daily.reduce((s, d) => s + d.post, 0)} posts, ${external.daily.reduce((s, d) => s + d.email, 0)} sent\n`);

// merge into dashboard-data.json if present
const ddPath = path.join(HERE, 'dashboard-data.json');
if (fs.existsSync(ddPath)) {
  const D = JSON.parse(fs.readFileSync(ddPath, 'utf8'));
  const byDay = Object.fromEntries(external.daily.map(r => [r.date, r]));
  const nowMs = Date.now();
  const wago = date => Math.floor((nowMs - Date.parse(date + 'T12:00')) / 604800000);

  // 1. history rows: fill the post + email bands
  for (const W of Object.values(D.windows)) {
    for (const row of W.history) {
      const e = byDay[row.date]; if (!e) continue;
      row.post = e.post; row.email = e.email;
      row.total = row.meeting + row.note + row.checkin + row.post + row.email;
    }
  }

  // 2. KPI output + per-week / per-day, per window
  for (const [label, W] of Object.entries(D.windows)) {
    const ext = W.history.reduce((s, r) => s + r.post + r.email, 0);
    W.kpi.output += ext;
    W.kpi.perWeek = +(W.kpi.output / W.weeks).toFixed(1);
    W.kpi.perActiveDay = +(W.kpi.output / (W.kpi.activeDays || 1)).toFixed(1);
    if (W.kpi.outputPrev != null) {
      // approximate prior-window external from the daily series shifted back
      let prevExt = 0;
      for (const r of external.daily) {
        const a = wago(r.date);
        if (a >= W.weeks && a < W.weeks * 2) prevExt += r.post + r.email;
      }
      W.kpi.outputPrev += prevExt;
      W.kpi.outputDelta = Math.round(100 * (W.kpi.output - W.kpi.outputPrev) / W.kpi.outputPrev);
    }
  }

  // 3. momentum — recompute weekly totals with external folded in
  const wk = external.daily.reduce((m, r) => { const a = wago(r.date); m[a] = (m[a] || 0) + r.post + r.email; return m; }, {});
  D.momentum.weeks = D.momentum.weeks.map((v, i) => v + (wk[5 - i] || 0)); // weeks array is [5w..0w] ago
  const tw = D.momentum.weeks[5], tr = (D.momentum.weeks.slice(1, 5).reduce((s, x) => s + x, 0)) / 4;
  D.momentum.thisWeek = tw;
  D.momentum.trailingAvg = +tr.toFixed(1);
  D.momentum.pct = tr ? Math.round(100 * (tw - tr) / tr) : 0;

  // 4. roster — fold content posts into BEACON, outreach into ATLAS
  for (const [label, W] of Object.entries(D.windows)) {
    const winMs = nowMs - W.days * 86400000;
    const postsIn = external.daily.filter(r => Date.parse(r.date + 'T12:00') >= winMs).reduce((s, r) => s + r.post, 0);
    const mailIn = external.daily.filter(r => Date.parse(r.date + 'T12:00') >= winMs).reduce((s, r) => s + r.email, 0);
    const spark = w => { const a = new Array(12).fill(0); for (const r of external.daily) { const g = wago(r.date); if (g < 12) a[11 - g] += r[w]; } return a; };
    for (const row of W.roster) {
      if (row.id === 'content') {
        row.events += postsIn; row.status = 'active'; row.ageDays = 0; row.blocker = false;
        row.spark = row.spark.map((v, i) => v + (spark('post')[i] || 0));
        row.lastTitle = `${external.buffer.posts} posts · ${external.buffer.impressions.toLocaleString()} impressions (12w)`;
      }
      if (row.id === 'job-search') {
        row.events += mailIn;
        row.spark = row.spark.map((v, i) => v + (spark('email')[i] || 0));
      }
    }
    W.roster.sort((a, b) => b.events - a.events);
  }

  D.external = external;
  fs.writeFileSync(ddPath, JSON.stringify(D));
  process.stderr.write('✓ merged into dashboard-data.json (output, momentum, roster updated)\n');
}
