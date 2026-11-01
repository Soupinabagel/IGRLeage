const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const RULES = { upvotes: 10, downvotes: 3 };
// With fewer than 3 reels a voter might see only one reel, and could not spend both upvotes and downvotes.
const MIN_REELS = 3;

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS leagues (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY,
  league_id INTEGER NOT NULL REFERENCES leagues(id),
  name TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  UNIQUE (league_id, name)
);
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY,
  league_id INTEGER NOT NULL REFERENCES leagues(id),
  num INTEGER NOT NULL,
  theme TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitting'
);
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  player_id INTEGER NOT NULL REFERENCES players(id),
  url TEXT NOT NULL,
  UNIQUE (round_id, player_id)
);
CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  voter_id INTEGER NOT NULL REFERENCES players(id),
  submission_id INTEGER NOT NULL REFERENCES submissions(id),
  points INTEGER NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  UNIQUE (voter_id, submission_id)
);
`);

const app = express();
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg, status = 400) => { throw new HttpError(status, msg); };

const newToken = () => crypto.randomBytes(24).toString('hex');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!db.prepare('SELECT 1 FROM leagues WHERE code = ?').get(c)) return c;
  }
}

function cleanName(v, label = 'Name', max = 30) {
  const s = String(v || '').trim().replace(/\s+/g, ' ');
  if (!s) bad(`${label} is required.`);
  if (s.length > max) bad(`${label} must be ${max} characters or fewer.`);
  return s;
}

function normalizeReel(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { return null; }
  if (!/^(www\.)?instagram\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/(?:[^/]+\/)?(reel|reels|p|tv)\/([A-Za-z0-9_-]+)/);
  if (!m) return null;
  const kind = m[1] === 'reels' ? 'reel' : m[1];
  return `https://www.instagram.com/${kind}/${m[2]}/`;
}

function auth(req, _res, next) {
  const token = req.get('x-token');
  const player = token && db.prepare('SELECT * FROM players WHERE token = ?').get(token);
  if (!player) return next(new HttpError(401, 'Please sign in again.'));
  req.player = player;
  next();
}
const adminOnly = (req, _res, next) =>
  req.player.is_admin ? next() : next(new HttpError(403, 'Only the league admin can do that.'));

function getRound(req) {
  const round = db.prepare('SELECT * FROM rounds WHERE id = ? AND league_id = ?')
    .get(Number(req.params.id), req.player.league_id);
  if (!round) bad('Round not found.', 404);
  return round;
}

// Moves a round forward when every player has finished the current phase. Returns the round's status.
function autoAdvance(roundId) {
  const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(roundId);
  const players = db.prepare('SELECT COUNT(*) AS c FROM players WHERE league_id = ?').get(round.league_id).c;
  if (round.status === 'submitting') {
    const subs = db.prepare('SELECT COUNT(*) AS c FROM submissions WHERE round_id = ?').get(roundId).c;
    if (subs >= players && subs >= MIN_REELS) {
      db.prepare("UPDATE rounds SET status = 'voting' WHERE id = ?").run(roundId);
      return 'voting';
    }
  } else if (round.status === 'voting') {
    const voters = db.prepare('SELECT COUNT(DISTINCT voter_id) AS c FROM votes WHERE round_id = ?').get(roundId).c;
    if (voters >= players) {
      db.prepare("UPDATE rounds SET status = 'results' WHERE id = ?").run(roundId);
      return 'results';
    }
  }
  return round.status;
}

const wrap = fn => (req, res, next) => { try { fn(req, res); } catch (e) { next(e); } };

// ---------- state ----------
function buildState(player) {
  const league = db.prepare('SELECT * FROM leagues WHERE id = ?').get(player.league_id);
  const players = db.prepare('SELECT id, name, is_admin FROM players WHERE league_id = ? ORDER BY id').all(league.id);
  const names = Object.fromEntries(players.map(p => [p.id, p.name]));
  const scores = Object.fromEntries(players.map(p => [p.id, { id: p.id, name: p.name, points: 0, rounds: 0 }]));
  const rounds = db.prepare('SELECT * FROM rounds WHERE league_id = ? ORDER BY num').all(league.id);

  const out = rounds.map(r => {
    const subs = db.prepare('SELECT * FROM submissions WHERE round_id = ? ORDER BY id').all(r.id);
    const base = { id: r.id, num: r.num, theme: r.theme, status: r.status, submitted: subs.map(s => s.player_id) };

    if (r.status === 'submitting') {
      const mine = subs.find(s => s.player_id === player.id);
      base.myUrl = mine ? mine.url : null;
      return base;
    }

    const votes = db.prepare('SELECT * FROM votes WHERE round_id = ?').all(r.id);
    base.voted = [...new Set(votes.map(v => v.voter_id))];

    if (r.status === 'voting') {
      base.entries = subs
        .map(s => ({ id: s.id, url: s.url, mine: s.player_id === player.id }))
        .sort((a, b) => ((a.id * 2654435761 + player.id * 40503) % 1009) - ((b.id * 2654435761 + player.id * 40503) % 1009));
      base.myVotes = votes
        .filter(v => v.voter_id === player.id)
        .map(v => ({ submissionId: v.submission_id, points: v.points, comment: v.comment }));
      return base;
    }

    base.entries = subs.map(s => {
      const vs = votes.filter(v => v.submission_id === s.id);
      const total = vs.reduce((a, v) => a + v.points, 0);
      scores[s.player_id].points += total;
      scores[s.player_id].rounds += 1;
      return {
        id: s.id, url: s.url, author: names[s.player_id], points: total,
        votes: vs.map(v => ({ from: names[v.voter_id], points: v.points, comment: v.comment })),
      };
    }).sort((a, b) => b.points - a.points);
    return base;
  });

  return {
    league: { name: league.name, code: league.code },
    me: { id: player.id, name: player.name, isAdmin: !!player.is_admin },
    players: players.map(p => ({ id: p.id, name: p.name })),
    rounds: out,
    leaderboard: Object.values(scores).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name)),
    rules: RULES,
  };
}

// ---------- routes ----------
app.post('/api/leagues', wrap((req, res) => {
  const name = cleanName(req.body.name, 'League name', 50);
  const playerName = cleanName(req.body.playerName);
  const create = db.transaction(() => {
    const code = newCode();
    const leagueId = db.prepare('INSERT INTO leagues (code, name) VALUES (?, ?)').run(code, name).lastInsertRowid;
    const token = newToken();
    db.prepare('INSERT INTO players (league_id, name, token, is_admin) VALUES (?, ?, ?, 1)').run(leagueId, playerName, token);
    return { token, code };
  });
  res.json(create());
}));

app.post('/api/join', wrap((req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const league = db.prepare('SELECT * FROM leagues WHERE code = ?').get(code);
  if (!league) bad('No league found with that code.', 404);
  const playerName = cleanName(req.body.playerName);
  if (db.prepare('SELECT 1 FROM players WHERE league_id = ? AND name = ? COLLATE NOCASE').get(league.id, playerName)) {
    bad('Someone in this league already uses that name. Pick another.');
  }
  const token = newToken();
  db.prepare('INSERT INTO players (league_id, name, token) VALUES (?, ?, ?)').run(league.id, playerName, token);
  res.json({ token });
}));

app.get('/api/state', auth, wrap((req, res) => res.json(buildState(req.player))));

app.post('/api/rounds', auth, adminOnly, wrap((req, res) => {
  const theme = cleanName(req.body.theme, 'Theme', 120);
  const open = db.prepare("SELECT 1 FROM rounds WHERE league_id = ? AND status != 'results'").get(req.player.league_id);
  if (open) bad('Finish the current round before starting a new one.');
  const { n } = db.prepare('SELECT COALESCE(MAX(num), 0) + 1 AS n FROM rounds WHERE league_id = ?').get(req.player.league_id);
  db.prepare('INSERT INTO rounds (league_id, num, theme) VALUES (?, ?, ?)').run(req.player.league_id, n, theme);
  res.json({ ok: true });
}));

app.post('/api/rounds/:id/advance', auth, adminOnly, wrap((req, res) => {
  const round = getRound(req);
  if (round.status === 'submitting') {
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM submissions WHERE round_id = ?').get(round.id);
    if (c < MIN_REELS) bad(`At least ${MIN_REELS} reels are needed before voting can start, so everyone can spend both upvotes and downvotes.`);
    db.prepare("UPDATE rounds SET status = 'voting' WHERE id = ?").run(round.id);
  } else if (round.status === 'voting') {
    db.prepare("UPDATE rounds SET status = 'results' WHERE id = ?").run(round.id);
  } else {
    bad('This round is already finished.');
  }
  res.json({ ok: true });
}));

app.post('/api/rounds/:id/submit', auth, wrap((req, res) => {
  const round = getRound(req);
  if (round.status !== 'submitting') bad('Submissions are closed for this round.');
  const url = normalizeReel(req.body.url);
  if (!url) bad('That doesn\u2019t look like an Instagram reel link. Copy it from the reel\u2019s share menu.');
  db.prepare(`INSERT INTO submissions (round_id, player_id, url) VALUES (?, ?, ?)
              ON CONFLICT (round_id, player_id) DO UPDATE SET url = excluded.url`)
    .run(round.id, req.player.id, url);
  res.json({ ok: true, status: autoAdvance(round.id) });
}));

app.post('/api/rounds/:id/vote', auth, wrap((req, res) => {
  const round = getRound(req);
  if (round.status !== 'voting') bad('Voting isn\u2019t open for this round.');
  const votes = Array.isArray(req.body.votes) ? req.body.votes : [];
  const subs = db.prepare('SELECT * FROM submissions WHERE round_id = ?').all(round.id);
  const byId = new Map(subs.map(s => [s.id, s]));
  let ups = 0;
  let downs = 0;
  const seen = new Set();
  const clean = votes.map(v => {
    const sub = byId.get(Number(v.submissionId));
    if (!sub) bad('One of those reels isn\u2019t in this round.');
    if (sub.player_id === req.player.id) bad('You can\u2019t vote for your own reel.');
    if (seen.has(sub.id)) bad('Each reel can only be voted on once.');
    seen.add(sub.id);
    const points = Number(v.points);
    if (!Number.isInteger(points) || points === 0) bad('Votes must be a whole number of upvotes or downvotes.');
    if (points > 0) ups += points; else downs -= points;
    return { submissionId: sub.id, points, comment: String(v.comment || '').trim().slice(0, 280) };
  });
  if (ups !== RULES.upvotes || downs !== RULES.downvotes) {
    bad(`Use all ${RULES.upvotes} upvotes and all ${RULES.downvotes} downvotes before saving. You\u2019ve used ${ups} and ${downs}.`);
  }
  db.transaction(() => {
    db.prepare('DELETE FROM votes WHERE round_id = ? AND voter_id = ?').run(round.id, req.player.id);
    const ins = db.prepare('INSERT INTO votes (round_id, voter_id, submission_id, points, comment) VALUES (?, ?, ?, ?, ?)');
    clean.forEach(v => ins.run(round.id, req.player.id, v.submissionId, v.points, v.comment));
  })();
  res.json({ ok: true, status: autoAdvance(round.id) });
}));

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.')));
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Something went wrong on the server.' : err.message });
});

app.listen(PORT, () => console.log(`Reel League running on http://localhost:${PORT}`));
