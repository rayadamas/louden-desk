// ─────────────────────────────────────────────────────────────────────────────
// taxonomy.example.mjs — the shape of a Louden Desk config.
//
// Copy this to taxonomy.config.mjs and describe your own vault. That file is
// git-ignored, because a real one names real people and real folders.
//
//   cp taxonomy.example.mjs taxonomy.config.mjs
//   node build-dashboard.mjs --vault=/path/to/your/vault
//
// Everything downstream — panels, colours, codenames, the roster — follows from
// what you write here. Nothing else needs editing.
// ─────────────────────────────────────────────────────────────────────────────

export const TZ = 'America/Chicago';

// Top-level folders in the vault. These become the Domain Balance panel.
export const DOMAINS = [
  { id: 'work',     emoji: '📈', dir: 'Work' },
  { id: 'tech',     emoji: '💾', dir: 'Tech' },
  { id: 'personal', emoji: '🏠', dir: 'Personal' },
  { id: 'learning', emoji: '🧠', dir: 'Learning' },
];

// The projects the dashboard tracks. Order matters — first match wins.
//
//   title  regex against a meeting title or note filename   (highest confidence)
//   path   path fragments; any match claims the event
//   kw     regex against title + first 2k of body           (lowest confidence)
//   email  recipient-domain fragments, for mail-derived events
//
// Resolution order across all projects is: title → path → email → NAMES → kw.
// Anything unmatched falls back to a bucket named after its top-level domain.
export const PROJECTS = [
  { id: 'day-job', name: 'Day Job', codename: 'MERIDIAN', tagline: 'the thing that pays',
    match: { title: /^DJ_|^standup/i, path: ['Work/Day Job'],
             kw: /\b(sprint|standup|quarterly review)\b/i } },

  { id: 'job-search', name: 'Job Search', codename: 'ATLAS', tagline: 'interviews · pipeline',
    match: { title: /interview|recruiter|screen|\brole\b/i,
             path: ['Work/Applications', 'Work/Interviews'],
             kw: /\b(recruiter|interview|hiring manager|offer|take-home|onsite)\b/i,
             email: ['greenhouse', 'lever.co', 'ashbyhq'] } },

  { id: 'side-project', name: 'Side Project', codename: 'QUINCY', tagline: 'the nights-and-weekends one',
    match: { path: ['Work/Side Project'], kw: /\b(side project|launch|beta)\b/i } },

  { id: 'writing', name: 'Writing', codename: 'BEACON', tagline: 'posts · newsletter',
    match: { title: /draft|post idea/i, path: ['Work/Writing'],
             kw: /\b(newsletter|blog post|published)\b/i } },

  { id: 'learning', name: 'Learning', codename: 'SCHOLAR', tagline: 'courses · certs',
    match: { path: ['Learning', 'Tech/Courses'],
             kw: /\b(course|certification|study plan)\b/i } },
];

// Recurring people → project. Checked after title/path/email, before body keywords.
// This is where most of the accuracy comes from once the obvious rules are in.
export const NAMES = [
  { re: /\b(alex ríos|priya n|sam okafor)\b/i, project: 'day-job' },
  { re: /\b(recruiter|talent partner)\b/i,     project: 'job-search' },
];

// Meeting-note filename prefixes like "alex_10142026.md" → project.
export const NAME_PREFIX = {
  alex: 'day-job',
  sam: 'day-job',
};

// Titles or paths that are never work. Excluded from every panel.
export const PERSONAL = /\bbirthday\b|\bdream\b|dentist|vacation|grocery/i;

// ── Daily notes ──────────────────────────────────────────────────────────────
// Expected layout: <CHECKIN_DIR>/YYYY/MM Month/YYYY-DD-MM-Ddd.md, with the day
// broken into "- HH:00 ... " time blocks and bullets underneath them.
export const CHECKIN_DIR = 'Personal/Daily';

// A bullet only counts as a work event if it matches one of these. A rule with
// project:null routes through the normal classifier instead, and is dropped if
// that classifier can't place it — which keeps generic verbs from adding noise.
export const CHECKIN_WORK = [
  { re: /#?DayJob\b|standup|sprint/i, project: 'day-job' },
  { re: /recruiter|\binterview\b|applied to|cover letter|\bCV\b/i, project: 'job-search' },
  { re: /published|drafted .{0,12}post|newsletter/i, project: 'writing' },
  { re: /\b(sent|follow[- ]?up|emailed|call(ed)? with|met with)\b/i, project: null },
];

// Bullets matching this are never work — time-block labels, filler.
export const CHECKIN_LINE_SKIP = /^lunch|^\s*lunch ?\/|^break\b/i;

// Headings whose bullets are never work — dreams, routine, meals, gratitude.
export const CHECKIN_SKIP_SECTION = /dream|bed|wakeup|bathroom|workout|reflection|gratitude/i;

// Marks an event as a blocker. Surfaces as a ⚠ on the roster card when the
// project is also going stale.
export const BLOCKER_RE = /\bblock(ed|er)?\b|stuck|waiting on|no response|stalled|on hold/i;

// One folder touched more than this many times in a day reads as a bulk edit,
// not a work session, and gets capped. Stops a vault reorg from spiking the chart.
export const BULK_DAY_CAP = 6;
