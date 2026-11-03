'use strict';
/**
 * EASY EARN — SQLite layer.
 *
 * Tries better-sqlite3 first (synchronous, transactional, well-tested).
 * Falls back to Node 22+ built-in node:sqlite DatabaseSync if the native
 * module is unavailable, so the server still runs without a compiler.
 * Both drivers expose prepare().run/get/all and exec(), which this file
 * normalises. All money/coin movements go through transactions in
 * src/utils.js, never through ad-hoc UPDATEs of a balance column —
 * there is NO stored balance column, so a balance can never drift from
 * its ledger. Balances are always derived from the ledger.
 */
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'shah-earn.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let db;
let driver = 'node:sqlite';
try {
  const Better = require('better-sqlite3');
  db = new Better(DB_PATH);
  driver = 'better-sqlite3';
} catch (e) {
  // eslint-disable-next-line global-require
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(DB_PATH);
  driver = 'node:sqlite';
}
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

// Normalised statement wrapper: { run, get, all } with positional params.
function prepare(sql) {
  const stmt = db.prepare(sql);
  return {
    run: (...args) => stmt.run(...args),
    get: (...args) => stmt.get(...args),
    all: (...args) => stmt.all(...args),
  };
}
function exec(sql) { db.exec(sql); }
function transaction(fn) {
  if (typeof db.transaction === 'function') return db.transaction(fn)();
  // node:sqlite DatabaseSync also exposes transaction(); this branch is
  // only a safety net.
  exec('BEGIN'); try { const r = fn(); exec('COMMIT'); return r; } catch (e) { exec('ROLLBACK'); throw e; }
}

exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  referral_code TEXT NOT NULL UNIQUE,
  referred_by INTEGER REFERENCES users(id),
  device_id TEXT,
  ip TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  language TEXT NOT NULL DEFAULT 'en',
  fraud_flag INTEGER NOT NULL DEFAULT 0,
  is_banned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('earned','spent','withdrawal_pending','withdrawal_paid','withdrawal_rejected_refund')),
  amount_coins INTEGER NOT NULL,
  amount_pkr REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'completed',
  reference TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_reference ON transactions(reference) WHERE reference IS NOT NULL;
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  title_ur TEXT,
  type TEXT NOT NULL CHECK (type IN ('survey','task','offerwall')),
  partner TEXT,
  partner_url TEXT,
  reward_coins INTEGER NOT NULL DEFAULT 0,
  verification_mode TEXT NOT NULL DEFAULT 'auto' CHECK (verification_mode IN ('auto','manual')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','submitted_pending')),
  completed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, task_id)
);
CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  streak INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, date)
);
CREATE TABLE IF NOT EXISTS spins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  result_coins INTEGER NOT NULL DEFAULT 0,
  result_label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS game_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  game TEXT NOT NULL,
  score INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  coins_awarded INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_id INTEGER NOT NULL REFERENCES users(id),
  referred_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  credited INTEGER NOT NULL DEFAULT 0,
  credited_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  method TEXT NOT NULL CHECK (method IN ('JazzCash','Easypaisa','bank')),
  account_number TEXT NOT NULL,
  account_name TEXT NOT NULL,
  amount_pkr REAL NOT NULL,
  coins INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','rejected')),
  admin_note TEXT,
  payout_reference TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ticket_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ad_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  ad_event_id TEXT NOT NULL UNIQUE,
  network TEXT,
  coins_awarded INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS offerwall_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  task_id INTEGER REFERENCES tasks(id),
  coins INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS fraud_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  type TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  device_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS admin_revenue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  amount_pkr REAL NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---- Config defaults (only inserted when missing) ----
const DEFAULT_CONFIG = {
  coin_to_pkr_rate: '100',        // 100 coins = 1 PKR
  min_withdrawal_pkr: '500',
  daily_checkin_coins: '20',
  spin_free_per_day: '3',
  spin_weights: JSON.stringify([
    { label: '0 coins', coins: 0, weight: 30 },
    { label: '5 coins', coins: 5, weight: 30 },
    { label: '10 coins', coins: 10, weight: 20 },
    { label: '20 coins', coins: 20, weight: 12 },
    { label: '50 coins', coins: 50, weight: 6 },
    { label: '100 coins', coins: 100, weight: 2 },
  ]),
  game_daily_cap: '200',
  ad_daily_cap: '100',
  ad_reward_coins: '10',
  referral_reward_coins: '100',
};
for (const [k, v] of Object.entries(DEFAULT_CONFIG)) {
  prepare('INSERT OR IGNORE INTO config(key, value) VALUES (?, ?)').run(k, v);
}

// ---- Seed: admin + sample tasks (only when the tables are empty) ----
function seed() {
  const admin = prepare('SELECT id FROM users WHERE email = ?').get('admin@shahearn.local');
  if (!admin) {
    prepare(`INSERT INTO users (name, email, password_hash, referral_code, role)
             VALUES (?, ?, ?, ?, 'admin')`)
      .run('EASY EARN Admin', 'admin@shahearn.local', bcrypt.hashSync('Admin123!', 10), 'SHAHADMIN');
    console.log('[seed] admin created: admin@shahearn.local / Admin123! — CHANGE THIS ON FIRST LOGIN');
  }
  const count = prepare('SELECT COUNT(*) c FROM tasks').get().c;
  if (count === 0) {
    const ins = prepare(`INSERT INTO tasks (title, title_ur, type, partner, partner_url, reward_coins, verification_mode)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`);
    // Manual-verification sample: completing it submits for review and
    // credits NOTHING until an admin verifies it. Never auto-credit a
    // claim the server has not verified.
    ins.run('Follow EASY EARN official page', 'EASY EARN کا آفیشل پیج فالو کریں', 'task', 'official', null, 50, 'manual');
    // Backend-verified sample: the server itself records the completion.
    ins.run('Read the Privacy Policy and Terms in the app', 'ایپ میں پرائیویسی پالیسی اور شرائط پڑھیں', 'task', 'internal', null, 10, 'auto');
    // Offerwall sample: credited ONLY via a signed postback, never via
    // the client-side complete endpoint (see server.js).
    ins.run('Complete a partner survey (offerwall)', 'پارٹنر سروے مکمل کریں', 'offerwall', 'offerwall-partner', process.env.OFFERWALL_URL || null, 0, 'auto');
    console.log('[seed] sample tasks created (manual + backend-verified + offerwall)');
  }
}
seed();

module.exports = { db, driver, prepare, exec, transaction, DEFAULT_CONFIG };
