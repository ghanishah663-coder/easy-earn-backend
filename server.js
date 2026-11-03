'use strict';
/**
 * EASY EARN backend — Node.js + Express + SQLite.
 *
 * HONESTY RULES (enforced in code, not just docs):
 * - No stored balance column: balances are derived from the ledger.
 * - No fake balances, no guaranteed earnings, no fake payment confirmations.
 * - A withdrawal only locks coins as `pending`. It becomes `paid` ONLY
 *   when an admin confirms a REAL external JazzCash/Easypaisa/bank payout
 *   and supplies a payout_reference. There is no provider API call here
 *   until JazzCash / Easypaisa credentials are configured (see README).
 * - Ad rewards are a fixed server-side amount, capped per day, idempotent
 *   by ad_event_id — the client never decides how many coins it earned.
 * - Offerwall rewards are credited ONLY by a signed server-to-server
 *   postback (HMAC-SHA256). The client complete endpoint refuses offerwall
 *   tasks outright.
 * - Earnings are variable and depend on real partner availability; the
 *   app must never promise a fixed income.
 */
try { require('dotenv').config(); } catch { /* dotenv is optional; env vars can be exported directly */ }
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { prepare, transaction } = require('./db');
const { pktDate, prevPktDate, getConfig, publicConfig, coinsToPkr, getBalance, credit, notify, fraud, makeReferralCode, publicUser, validEmail, getMaskedPayoutSource } = require('./utils');
const { auth, adminOnly } = require('/.middleware');

if (!process.env.JWT_SECRET) console.warn('[warn] JWT_SECRET is not set — using a dev fallback. Set JWT_SECRET before production use.');
if (!process.env.ADMOB_SSV_KEY) console.warn('[warn] ADMOB_SSV_KEY is not set — ad rewards run in audit-logged capped mode only. Set it before production AdMob use.');

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.set('trust proxy', 1);

// Static admin panel (added separately). Do NOT create public/admin here;
// this only serves it if another step drops files into backend/public/.
const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) app.use(express.static(publicDir));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
const signToken = (u) => jwt.sign({ id: u.id, role: u.role }, process.env.JWT_SECRET || 'dev-only-change-me', { expiresIn: '7d' });
const bad = (res, code, msg, status = 400) => res.status(status).json({ error: code, message: msg });

app.get('/api/health', (req, res) => res.json({ app: 'EASY EARN', status: 'ok', currency: 'PKR', driver: require('.//db').driver }));
app.get('/', (req, res) => res.json({ app: 'EASY EARN', status: 'ok', note: 'Earnings are not guaranteed and depend on real partner availability. Withdrawals are paid only after a confirmed external payout.' }));
app.get('/api/config/public', (req, res) => res.json(publicConfig()));

// ---------------- Auth ----------------
app.post('/api/auth/register', authLimiter, (req, res) => {
  const { name, email, password, referral_code, device_id, language } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) return bad(res, 'name_required', 'Name is required.');
  if (!validEmail(email)) return bad(res, 'invalid_email', 'A valid email is required.');
  if (!password || password.length < 8) return bad(res, 'password_too_short', 'Password must be at least 8 characters.', 400);
  const emailNorm = email.trim().toLowerCase();
  if (prepare('SELECT id FROM users WHERE email = ?').get(emailNorm)) return bad(res, 'email_exists', 'Email already registered.', 409);
  let referredBy = null;
  if (referral_code) {
    const ref = prepare('SELECT id FROM users WHERE referral_code = ?').get(String(referral_code).trim().toUpperCase());
    if (!ref) return bad(res, 'invalid_referral_code', 'Referral code not found.');
    referredBy = ref.id;
  }
  let code = makeReferralCode();
  while (prepare('SELECT id FROM users WHERE referral_code = ?').get(code)) code = makeReferralCode();
  const ip = req.ip;
  const userId = transaction(() => {
    const r = prepare(`INSERT INTO users (name, email, password_hash, referral_code, referred_by, device_id, ip, language)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(name.trim(), emailNorm, bcrypt.hashSync(password, 10), code, referredBy, device_id || null, ip, language || 'en');
    if (referredBy) prepare('INSERT INTO referrals (referrer_id, referred_id) VALUES (?, ?)').run(referredBy, r.lastInsertRowid);
    return r.lastInsertRowid;
  });
  // Abuse detection: FLAG, do not silently auto-ban. A flagged account is
  // visible in /api/admin/fraud for a human admin to review.
  const sameDevice = device_id ? prepare('SELECT COUNT(*) c FROM users WHERE device_id = ?').get(device_id).c : 0;
  const sameIp = prepare('SELECT COUNT(*) c FROM users WHERE ip = ?').get(ip).c;
  if ((device_id && sameDevice >= 3) || sameIp >= 5) {
    prepare('UPDATE users SET fraud_flag = 1 WHERE id = ?').run(userId);
    fraud(userId, 'duplicate_device_or_ip', `device_count=${sameDevice} ip_count=${sameIp}`, req);
  }
  const user = prepare('SELECT * FROM users WHERE id = ?').get(userId);
  res.status(201).json({ user: publicUser(user), token: signToken(user) });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const { email, password } = req.body || {};
  if (!validEmail(email) || !password) return bad(res, 'invalid_credentials', 'Email and password are required.', 401);
  const user = prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return bad(res, 'invalid_credentials', 'Invalid email or password.', 401);
  if (user.is_banned) return bad(res, 'account_banned', 'This account is banned. Contact support.', 403);
  res.json({ user: publicUser(user), token: signToken(user) });
});
app.get('/api/auth/me', auth, (req, res) => res.json({ user: publicUser(req.user), wallet: getBalance(req.user.id) }));

// ---------------- Wallet / transactions ----------------
app.get('/api/wallet', auth, (req, res) => res.json(getBalance(req.user.id)));
app.get('/api/transactions', auth, (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json(prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(req.user.id, limit));
});

// ---------------- Daily check-in ----------------
app.post('/api/checkin', auth, (req, res) => {
  const date = pktDate();
  const existing = prepare('SELECT * FROM checkins WHERE user_id = ? AND date = ?').get(req.user.id, date);
  if (existing) return res.json({ already_checked_in: true, streak: existing.streak, wallet: getBalance(req.user.id) }); // idempotent
  const cfg = getConfig();
  const yesterday = prepare('SELECT * FROM checkins WHERE user_id = ? AND date = ?').get(req.user.id, prevPktDate());
  const streak = yesterday ? yesterday.streak + 1 : 1;
  prepare('INSERT INTO checkins (user_id, date, streak) VALUES (?, ?, ?)').run(req.user.id, date, streak);
  // References are per-user: a global `checkin:<date>` reference would
  // collide for the second user checking in on the same day.
  credit(req.user.id, cfg.daily_checkin_coins, `checkin:${req.user.id}:${date}`);
  // Referral: one-time credit to the referrer on the referred user's FIRST
  // check-in only. Transparent and logged with a unique reference.
  if (req.user.referred_by) {
    const ref = prepare('SELECT * FROM referrals WHERE referred_id = ?').get(req.user.id);
    const firstCheckinCount = prepare('SELECT COUNT(*) c FROM checkins WHERE user_id = ?').get(req.user.id).c;
    if (ref && !ref.credited && firstCheckinCount === 1) {
      try {
        credit(ref.referrer_id, cfg.referral_reward_coins, `referral:${req.user.id}`);
        prepare('UPDATE referrals SET credited = 1, credited_at = datetime(\'now\') WHERE id = ?').run(ref.id);
        notify(ref.referrer_id, 'Referral reward', `Your referral completed their first check-in. ${cfg.referral_reward_coins} coins credited.`);
      } catch (e) { /* unique-reference guard: never credit twice */ }
    }
  }
  res.json({ already_checked_in: false, streak, coins: cfg.daily_checkin_coins, wallet: getBalance(req.user.id) });
});

// ---------------- Ads (rewarded) ----------------
/**
 * AdMob SSV verification hook.
 * Real AdMob SSV: Google signs the reward callback with its own keys;
 * production verification must fetch Google's SSV public keys and verify
 * the signature (see AdMob SSV docs) — it is NOT a shared-secret HMAC.
 * - If ADMOB_SSV_KEY is unset: this backend accepts only a unique
 *   ad_event_id, awards a fixed server-side amount (never a client-claimed
 *   amount), enforces the daily cap, and audit-logs the event. This mode
 *   is acceptable for development only.
 * - If ADMOB_SSV_KEY is set: unsigned claims are rejected here until the
 *   Google public-key verification step is wired in. Do not bypass this
 *   gate by unsetting the key in production.
 */
function verifyAdMobSSV(req) {
  if (!process.env.ADMOB_SSV_KEY) return { ok: true };
  if (!req.body.ssv_signature || !req.body.ssv_data) {
    return { ok: false, error: 'ssv_signature_required', message: 'AdMob SSV signature is required when ADMOB_SSV_KEY is set. Wire Google SSV public-key verification before enabling real rewards.' };
  }
  // TODO (production gate): verify ssv_signature against Google's SSV
  // public keys for ssv_data. Until that step is implemented, reject —
  // never treat a self-asserted signature as proof of a watched ad.
  return { ok: false, error: 'ssv_not_verified', message: 'SSV public-key verification is not yet implemented. Ad reward refused rather than credited on an unverified claim.' };
}
app.post('/api/ads/reward', auth, (req, res) => {
  const { ad_event_id, network } = req.body || {};
  if (!ad_event_id || typeof ad_event_id !== 'string') return bad(res, 'ad_event_id_required', 'ad_event_id is required.');
  const existing = prepare('SELECT * FROM ad_events WHERE ad_event_id = ?').get(ad_event_id);
  if (existing) return res.json({ duplicate: true, coins_awarded: existing.coins_awarded, wallet: getBalance(req.user.id) }); // idempotent, never credit twice
  const ssv = verifyAdMobSSV(req);
  if (!ssv.ok) return bad(res, ssv.error, ssv.message, 400);
  const cfg = getConfig();
  const date = pktDate();
  const today = prepare('SELECT COALESCE(SUM(coins_awarded),0) s FROM ad_events WHERE user_id = ? AND date = ?').get(req.user.id, date).s;
  if (today >= cfg.ad_daily_cap) return bad(res, 'ad_daily_cap', 'Daily ad reward cap reached.', 429);
  const coins = Math.min(cfg.ad_reward_coins, cfg.ad_daily_cap - today);
  prepare('INSERT INTO ad_events (user_id, ad_event_id, network, coins_awarded, date) VALUES (?, ?, ?, ?, ?)').run(req.user.id, ad_event_id, network || null, coins, date);
  if (coins > 0) credit(req.user.id, coins, `ad:${ad_event_id}`);
  res.json({ coins_awarded: coins, wallet: getBalance(req.user.id) });
});

// ---------------- Tasks ----------------
app.get('/api/tasks', auth, (req, res) => {
  res.json(prepare('SELECT * FROM tasks WHERE active = 1 ORDER BY id').all());
});
app.post('/api/tasks/:id/complete', auth, (req, res) => {
  const task = prepare('SELECT * FROM tasks WHERE id = ? AND active = 1').get(req.params.id);
  if (!task) return bad(res, 'task_not_found', 'Task not found.', 404);
  const existing = prepare('SELECT * FROM user_tasks WHERE user_id = ? AND task_id = ?').get(req.user.id, task.id);
  if (existing) return res.json({ status: existing.status, already_done: true, wallet: getBalance(req.user.id) });
  if (task.type === 'offerwall') {
    return bad(res, 'offerwall_only_via_postback', 'Offerwall tasks are credited only via a signed partner postback, never from the app.');
  }
  if (task.verification_mode === 'manual') {
    prepare('INSERT INTO user_tasks (user_id, task_id, status) VALUES (?, ?, \'submitted_pending\')').run(req.user.id, task.id);
    return res.json({ status: 'submitted_pending', message: 'Submitted for manual verification. No coins are credited until an admin verifies it.' });
  }
  prepare('INSERT INTO user_tasks (user_id, task_id, status) VALUES (?, ?, \'completed\')').run(req.user.id, task.id);
  if (task.reward_coins > 0) credit(req.user.id, task.reward_coins, `task:${req.user.id}:${task.id}`);
  res.json({ status: 'completed', coins: task.reward_coins, wallet: getBalance(req.user.id) });
});

// ---------------- Offerwall postback (server-to-server, no JWT) ----------------
app.post('/api/offerwall/postback', (req, res) => {
  const secret = process.env.OFFERWALL_SECRET;
  if (!secret) return bad(res, 'offerwall_not_configured', 'OFFERWALL_SECRET is not set. Offerwall credit is disabled until a partner secret is configured.', 503);
  const { transaction_id, user_id, coins, task_id } = req.body || {};
  const signature = req.body.signature || req.headers['x-offerwall-signature'];
  if (!transaction_id || !user_id || !Number.isInteger(coins) || coins <= 0 || coins > 10000) return bad(res, 'invalid_postback', 'transaction_id, user_id and a positive integer coins (max 10000) are required.');
  // Canonical string, documented in README: "<transaction_id>|<user_id>|<coins>"
  const expected = crypto.createHmac('sha256', secret).update(`${transaction_id}|${user_id}|${coins}`).digest('hex');
  if (!signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(String(signature)), Buffer.from(expected))) {
    fraud(Number(user_id) || null, 'offerwall_bad_signature', `transaction_id=${transaction_id}`, req);
    return bad(res, 'bad_signature', 'Postback signature verification failed.', 401);
  }
  const user = prepare('SELECT id FROM users WHERE id = ?').get(user_id);
  if (!user) return bad(res, 'user_not_found', 'User not found.', 404);
  if (task_id) {
    const task = prepare('SELECT * FROM tasks WHERE id = ?').get(task_id);
    if (!task || task.type !== 'offerwall') return bad(res, 'invalid_task', 'task_id must be an offerwall task.');
  }
  const existing = prepare('SELECT * FROM offerwall_events WHERE transaction_id = ?').get(transaction_id);
  if (existing) return res.json({ ok: true, duplicate: true });
  transaction(() => {
    prepare('INSERT INTO offerwall_events (transaction_id, user_id, task_id, coins) VALUES (?, ?, ?, ?)').run(transaction_id, user_id, task_id || null, coins);
    prepare(`INSERT INTO transactions (user_id, type, amount_coins, amount_pkr, status, reference)
             VALUES (?, 'earned', ?, ?, 'completed', ?)`).run(user_id, coins, coinsToPkr(coins), `offerwall:${transaction_id}`);
    if (task_id) prepare('INSERT OR IGNORE INTO user_tasks (user_id, task_id, status) VALUES (?, ?, \'completed\')').run(user_id, task_id);
  });
  notify(user_id, 'Offerwall reward', `${coins} coins credited from a partner offer.`);
  res.json({ ok: true, coins });
});

// ---------------- Games ----------------
const GAME_RULES = {
  tap: { maxScore: (d) => Math.floor(d / 50), coins: (s) => Math.floor(s / 10) },       // >20 taps/sec is physically absurd
  memory: { maxScore: () => 2000, coins: (s) => Math.floor(s / 20) },
  quiz: { maxScore: () => 100, coins: (s) => s * 2 },
};
app.post('/api/games/submit', auth, (req, res) => {
  const { game, score, duration_ms } = req.body || {};
  const rule = GAME_RULES[game];
  if (!rule) return bad(res, 'invalid_game', 'game must be one of: tap, memory, quiz.');
  if (!Number.isInteger(score) || score < 0 || !Number.isInteger(duration_ms) || duration_ms < 1000 || duration_ms > 600000) {
    return bad(res, 'invalid_score', 'score must be a non-negative integer and duration_ms between 1000 and 600000.');
  }
  if (score > rule.maxScore(duration_ms)) {
    fraud(req.user.id, 'game_absurd_score', `game=${game} score=${score} duration_ms=${duration_ms}`, req);
    return bad(res, 'absurd_score', 'Score is not plausible for the reported duration. Submission rejected and flagged for review.');
  }
  const cfg = getConfig();
  const date = pktDate();
  const today = prepare('SELECT COALESCE(SUM(coins_awarded),0) s FROM game_scores WHERE user_id = ? AND date = ?').get(req.user.id, date).s;
  const coins = Math.max(0, Math.min(rule.coins(score), cfg.game_daily_cap - today));
  prepare('INSERT INTO game_scores (user_id, game, score, duration_ms, coins_awarded, date) VALUES (?, ?, ?, ?, ?, ?)').run(req.user.id, game, score, duration_ms, coins, date);
  if (coins > 0) credit(req.user.id, coins, `game:${req.user.id}:${game}:${Date.now()}`);
  res.json({ coins_awarded: coins, daily_cap: cfg.game_daily_cap, wallet: getBalance(req.user.id) });
});

// ---------------- Spin ----------------
app.post('/api/spin', auth, (req, res) => {
  const cfg = getConfig();
  const date = pktDate();
  const used = prepare('SELECT COUNT(*) c FROM spins WHERE user_id = ? AND date = ?').get(req.user.id, date).c;
  if (used >= cfg.spin_free_per_day) return bad(res, 'spin_limit', 'Free spins for today are used up.', 429);
  // Server-side weighted RNG — the client never picks its own prize.
  const total = cfg.spin_weights.reduce((a, w) => a + (Number(w.weight) || 0), 0);
  let roll = crypto.randomInt(total);
  let prize = cfg.spin_weights[cfg.spin_weights.length - 1];
  for (const w of cfg.spin_weights) { if (roll < w.weight) { prize = w; break; } roll -= w.weight; }
  const coins = Number(prize.coins) || 0;
  prepare('INSERT INTO spins (user_id, date, result_coins, result_label) VALUES (?, ?, ?, ?)').run(req.user.id, date, coins, prize.label || `${coins} coins`);
  if (coins > 0) credit(req.user.id, coins, `spin:${req.user.id}:${date}:${Date.now()}`);
  res.json({ prize: prize.label || `${coins} coins`, coins, spins_remaining: cfg.spin_free_per_day - used - 1, wallet: getBalance(req.user.id) });
});

// ---------------- Referrals ----------------
app.get('/api/referrals', auth, (req, res) => {
  const referred = prepare(`SELECT u.id, u.name, u.created_at, r.credited, r.credited_at
    FROM referrals r JOIN users u ON u.id = r.referred_id WHERE r.referrer_id = ? ORDER BY r.id`).all(req.user.id);
  const earned = prepare(`SELECT COALESCE(SUM(amount_coins),0) s FROM transactions WHERE user_id = ? AND reference LIKE 'referral:%'`).get(req.user.id).s;
  res.json({ referral_code: req.user.referral_code, count: referred.length, referral_earnings_coins: earned, referred });
});

// ---------------- Withdrawals ----------------
app.post('/api/withdrawals', auth, (req, res) => {
  const { method, account_number, account_name, amount_pkr } = req.body || {};
  if (!['JazzCash', 'Easypaisa', 'bank'].includes(method)) return bad(res, 'invalid_method', 'method must be JazzCash, Easypaisa or bank.');
  if (!account_number || String(account_number).trim().length < 6 || !account_name || !String(account_name).trim()) return bad(res, 'account_required', 'account_number and account_name are required.');
  const cfg = getConfig();
  const pkr = Number(amount_pkr);
  if (!Number.isFinite(pkr) || pkr < cfg.min_withdrawal_pkr || !Number.isInteger(pkr)) return bad(res, 'below_minimum', `Minimum withdrawal is ${cfg.min_withdrawal_pkr} PKR (whole PKR only).`);
  const coins = Math.round(pkr * cfg.coin_to_pkr_rate);
  const wallet = getBalance(req.user.id);
  if (wallet.available_coins < coins) return bad(res, 'insufficient_balance', 'Not enough available coins for this withdrawal.');
  const id = transaction(() => {
    const w = prepare(`INSERT INTO withdrawals (user_id, method, account_number, account_name, amount_pkr, coins)
                       VALUES (?, ?, ?, ?, ?, ?)`).run(req.user.id, method, String(account_number).trim(), String(account_name).trim(), pkr, coins);
    prepare(`INSERT INTO transactions (user_id, type, amount_coins, amount_pkr, status, reference)
             VALUES (?, 'withdrawal_pending', ?, ?, 'pending', ?)`).run(req.user.id, -coins, -pkr, `withdrawal:${w.lastInsertRowid}`);
    return w.lastInsertRowid;
  });
  notify(req.user.id, 'Withdrawal requested', `Your ${pkr} PKR withdrawal is pending. Coins are locked until an admin confirms a real payout — this is not a payment confirmation.`);
  res.status(201).json({ withdrawal: prepare('SELECT * FROM withdrawals WHERE id = ?').get(id), wallet: getBalance(req.user.id) });
});
app.get('/api/withdrawals', auth, (req, res) => {
  res.json(prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC').all(req.user.id));
});

// ---------------- Support ----------------
app.post('/api/support', auth, (req, res) => {
  const { subject, message } = req.body || {};
  if (!subject || !message) return bad(res, 'fields_required', 'subject and message are required.');
  const r = prepare('INSERT INTO support_tickets (user_id, subject, message) VALUES (?, ?, ?)').run(req.user.id, subject, message);
  res.status(201).json(prepare('SELECT * FROM support_tickets WHERE id = ?').get(r.lastInsertRowid));
});
app.get('/api/support', auth, (req, res) => {
  res.json(prepare('SELECT * FROM support_tickets WHERE user_id = ? ORDER BY id DESC').all(req.user.id));
});
app.get('/api/support/:id', auth, (req, res) => {
  const t = prepare('SELECT * FROM support_tickets WHERE id = ?').get(req.params.id);
  if (!t || (t.user_id !== req.user.id && req.user.role !== 'admin')) return bad(res, 'ticket_not_found', 'Ticket not found.', 404);
  res.json({ ticket: t, replies: prepare('SELECT * FROM ticket_replies WHERE ticket_id = ? ORDER BY id').all(t.id) });
});
function replyToTicket(req, res) {
  const t = prepare('SELECT * FROM support_tickets WHERE id = ?').get(req.params.id);
  if (!t || (t.user_id !== req.user.id && req.user.role !== 'admin')) return bad(res, 'ticket_not_found', 'Ticket not found.', 404);
  const { message } = req.body || {};
  if (!message) return bad(res, 'message_required', 'message is required.');
  const r = prepare('INSERT INTO ticket_replies (ticket_id, user_id, role, message) VALUES (?, ?, ?, ?)').run(t.id, req.user.id, req.user.role, message);
  if (req.user.role === 'admin' && t.status === 'open') prepare('UPDATE support_tickets SET status = \'answered\' WHERE id = ?').run(t.id);
  res.status(201).json(prepare('SELECT * FROM ticket_replies WHERE id = ?').get(r.lastInsertRowid));
}
app.post('/api/support/:id/reply', auth, replyToTicket);

// ---------------- Notifications ----------------
app.get('/api/notifications', auth, (req, res) => {
  res.json(prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id));
});
app.post('/api/notifications/:id/read', auth, (req, res) => {
  const n = prepare('SELECT * FROM notifications WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!n) return bad(res, 'notification_not_found', 'Notification not found.', 404);
  prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(n.id);
  res.json({ ok: true });
});

// ---------------- Admin ----------------
app.use('/api/admin', auth, adminOnly);
// Admin-only payout-source reference, MASKED. Never exposed to regular
// users or in /api/config/public. Manual payout only: reading this does
// not send, trigger, or authorise any payment.
app.get('/api/admin/payout-source', (req, res) => res.json(getMaskedPayoutSource()));
app.get('/api/admin/stats', (req, res) => {
  const q = (sql) => prepare(sql).get();
  res.json({
    users: q('SELECT COUNT(*) c FROM users').c,
    banned_users: q('SELECT COUNT(*) c FROM users WHERE is_banned = 1').c,
    fraud_flagged_users: q('SELECT COUNT(*) c FROM users WHERE fraud_flag = 1').c,
    total_earned_coins: q(`SELECT COALESCE(SUM(amount_coins),0) s FROM transactions WHERE type='earned'`).s,
    total_pending_withdrawals_pkr: q(`SELECT COALESCE(SUM(amount_pkr),0) s FROM withdrawals WHERE status IN ('pending','approved')`).s,
    total_paid_withdrawals_pkr: q(`SELECT COALESCE(SUM(amount_pkr),0) s FROM withdrawals WHERE status='paid'`).s,
    // Revenue is ONLY admin-entered ad revenue rows. If none exist it is 0 — never invented.
    total_revenue_pkr: q('SELECT COALESCE(SUM(amount_pkr),0) s FROM admin_revenue').s,
    total_expenses_pkr: q(`SELECT COALESCE(SUM(amount_pkr),0) s FROM withdrawals WHERE status='paid'`).s,
    transactions: q('SELECT COUNT(*) c FROM transactions').c,
    open_tickets: q(`SELECT COUNT(*) c FROM support_tickets WHERE status='open'`).c,
  });
});
app.get('/api/admin/users', (req, res) => {
  const users = prepare('SELECT id, name, email, referral_code, referred_by, device_id, ip, role, language, fraud_flag, is_banned, created_at FROM users ORDER BY id DESC LIMIT 200').all();
  res.json(users.map((u) => ({ ...u, wallet: getBalance(u.id) })));
});
app.post('/api/admin/users/:id/flag', (req, res) => {
  prepare('UPDATE users SET fraud_flag = 1 WHERE id = ?').run(req.params.id);
  fraud(Number(req.params.id), 'admin_flag', req.body?.reason || 'flagged by admin', req);
  res.json({ ok: true });
});
app.post('/api/admin/users/:id/ban', (req, res) => {
  prepare('UPDATE users SET is_banned = 1 WHERE id = ?').run(req.params.id);
  fraud(Number(req.params.id), 'admin_ban', req.body?.reason || 'banned by admin', req);
  res.json({ ok: true });
});
app.post('/api/admin/tasks', (req, res) => {
  const { title, title_ur, type, partner, partner_url, reward_coins, verification_mode } = req.body || {};
  if (!title || !['survey', 'task', 'offerwall'].includes(type)) return bad(res, 'invalid_task', 'title and a valid type (survey/task/offerwall) are required.');
  const r = prepare(`INSERT INTO tasks (title, title_ur, type, partner, partner_url, reward_coins, verification_mode)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`).run(title, title_ur || null, type, partner || null, partner_url || null, Number(reward_coins) || 0, verification_mode || 'auto');
  res.status(201).json(prepare('SELECT * FROM tasks WHERE id = ?').get(r.lastInsertRowid));
});
app.put('/api/admin/tasks/:id', (req, res) => {
  const t = prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) return bad(res, 'task_not_found', 'Task not found.', 404);
  const b = req.body || {};
  prepare(`UPDATE tasks SET title = COALESCE(?, title), title_ur = COALESCE(?, title_ur), type = COALESCE(?, type),
           partner = COALESCE(?, partner), partner_url = COALESCE(?, partner_url), reward_coins = COALESCE(?, reward_coins),
           verification_mode = COALESCE(?, verification_mode), active = COALESCE(?, active) WHERE id = ?`)
    .run(b.title ?? null, b.title_ur ?? null, b.type ?? null, b.partner ?? null, b.partner_url ?? null, b.reward_coins ?? null, b.verification_mode ?? null, b.active ?? null, t.id);
  res.json(prepare('SELECT * FROM tasks WHERE id = ?').get(t.id));
});
app.delete('/api/admin/tasks/:id', (req, res) => {
  // Soft-remove: keeps user_tasks history intact.
  prepare('UPDATE tasks SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true, active: 0 });
});
app.post('/api/admin/config', (req, res) => {
  const allowed = ['coin_to_pkr_rate', 'min_withdrawal_pkr', 'daily_checkin_coins', 'spin_free_per_day', 'spin_weights', 'game_daily_cap', 'ad_daily_cap', 'ad_reward_coins', 'referral_reward_coins'];
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!allowed.includes(k)) return bad(res, 'invalid_config_key', `Config key not allowed: ${k}`);
    if (k === 'spin_weights') {
      let w; try { w = typeof v === 'string' ? JSON.parse(v) : v; } catch { return bad(res, 'invalid_weights', 'spin_weights must be valid JSON.'); }
      if (!Array.isArray(w) || !w.length || w.some((x) => !Number.isFinite(Number(x.coins)) || !Number.isFinite(Number(x.weight)) || Number(x.weight) < 0)) return bad(res, 'invalid_weights', 'spin_weights must be an array of {label, coins, weight}.');
      prepare('INSERT INTO config(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(w));
    } else {
      if (!Number.isFinite(Number(v)) || Number(v) < 0) return bad(res, 'invalid_config_value', `${k} must be a non-negative number.`);
      prepare('INSERT INTO config(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
    }
  }
  res.json(publicConfig());
});
app.get('/api/admin/withdrawals', (req, res) => {
  res.json(prepare('SELECT * FROM withdrawals ORDER BY id DESC LIMIT 200').all());
});
app.post('/api/admin/withdrawals/:id/approve', (req, res) => {
  const w = prepare('SELECT * FROM withdrawals WHERE id = ?').get(req.params.id);
  if (!w || w.status !== 'pending') return bad(res, 'invalid_state', 'Only a pending withdrawal can be approved.');
  prepare('UPDATE withdrawals SET status = \'approved\', admin_note = COALESCE(?, admin_note) WHERE id = ?').run(req.body?.admin_note || null, w.id);
  prepare('UPDATE transactions SET status = \'approved\' WHERE reference = ?').run(`withdrawal:${w.id}`);
  notify(w.user_id, 'Withdrawal approved', `Your ${w.amount_pkr} PKR withdrawal was approved. It is still not paid until the external payout is confirmed.`);
  res.json(prepare('SELECT * FROM withdrawals WHERE id = ?').get(w.id));
});
app.post('/api/admin/withdrawals/:id/mark-paid', (req, res) => {
  const w = prepare('SELECT * FROM withdrawals WHERE id = ?').get(req.params.id);
  if (!w || w.status !== 'approved') return bad(res, 'invalid_state', 'Only an approved withdrawal can be marked paid. Approve it first.');
  const payout_reference = req.body?.payout_reference;
  if (!payout_reference || typeof payout_reference !== 'string') return bad(res, 'payout_reference_required', 'payout_reference from the real JazzCash/Easypaisa/bank transaction is required. Do not mark paid without a real payout.');
  prepare('UPDATE withdrawals SET status = \'paid\', payout_reference = ?, admin_note = COALESCE(?, admin_note) WHERE id = ?').run(payout_reference, req.body?.admin_note || null, w.id);
  prepare('UPDATE transactions SET type = \'withdrawal_paid\', status = \'paid\' WHERE reference = ?').run(`withdrawal:${w.id}`);
  notify(w.user_id, 'Withdrawal paid', `Your ${w.amount_pkr} PKR withdrawal was paid. Reference: ${payout_reference}`);
  res.json(prepare('SELECT * FROM withdrawals WHERE id = ?').get(w.id));
});
app.post('/api/admin/withdrawals/:id/reject', (req, res) => {
  const w = prepare('SELECT * FROM withdrawals WHERE id = ?').get(req.params.id);
  if (!w || !['pending', 'approved'].includes(w.status)) return bad(res, 'invalid_state', 'Only a pending or approved withdrawal can be rejected.');
  transaction(() => {
    prepare('UPDATE withdrawals SET status = \'rejected\', admin_note = COALESCE(?, admin_note) WHERE id = ?').run(req.body?.admin_note || null, w.id);
    prepare('UPDATE transactions SET status = \'rejected\' WHERE reference = ?').run(`withdrawal:${w.id}`);
    prepare(`INSERT INTO transactions (user_id, type, amount_coins, amount_pkr, status, reference)
             VALUES (?, 'withdrawal_rejected_refund', ?, ?, 'refunded', ?)`).run(w.user_id, w.coins, w.amount_pkr, `withdrawal:${w.id}:refund`);
  });
  notify(w.user_id, 'Withdrawal rejected', `Your ${w.amount_pkr} PKR withdrawal was rejected and the locked coins were refunded.`);
  res.json(prepare('SELECT * FROM withdrawals WHERE id = ?').get(w.id));
});
app.get('/api/admin/transactions', (req, res) => {
  res.json(prepare('SELECT * FROM transactions ORDER BY id DESC LIMIT 200').all());
});
app.get('/api/admin/ads', (req, res) => {
  res.json({ config: publicConfig(), events: prepare('SELECT * FROM ad_events ORDER BY id DESC LIMIT 200').all(), total_coins_awarded: prepare('SELECT COALESCE(SUM(coins_awarded),0) s FROM ad_events').get().s });
});
app.get('/api/admin/fraud', (req, res) => {
  res.json(prepare('SELECT * FROM fraud_events ORDER BY id DESC LIMIT 200').all());
});
app.get('/api/admin/tickets', (req, res) => {
  res.json(prepare('SELECT * FROM support_tickets ORDER BY id DESC LIMIT 200').all());
});
app.post('/api/admin/tickets/:id/reply', auth, adminOnly, replyToTicket);
app.post('/api/admin/revenue', (req, res) => {
  const { source, amount_pkr, note } = req.body || {};
  if (!source || !Number.isFinite(Number(amount_pkr)) || Number(amount_pkr) <= 0) return bad(res, 'invalid_revenue', 'source and a positive amount_pkr are required. Enter only real, verified ad revenue.');
  const r = prepare('INSERT INTO admin_revenue (source, amount_pkr, note) VALUES (?, ?, ?)').run(source, Number(amount_pkr), note || null);
  res.status(201).json(prepare('SELECT * FROM admin_revenue WHERE id = ?').get(r.lastInsertRowid));
});
app.post('/api/admin/notify', (req, res) => {
  const { user_id, all, title, body } = req.body || {};
  if (!title || !body) return bad(res, 'fields_required', 'title and body are required.');
  if (all === true || user_id === 'all') {
    const users = prepare('SELECT id FROM users WHERE is_banned = 0').all();
    for (const u of users) notify(u.id, title, body);
    res.json({ ok: true, sent_to: users.length });
  } else {
    const u = prepare('SELECT id FROM users WHERE id = ?').get(user_id);
    if (!u) return bad(res, 'user_not_found', 'User not found.', 404);
    notify(u.id, title, body);
    res.json({ ok: true, sent_to: 1 });
  }
});

// 404 + error handler (JSON only)
app.use((req, res) => res.status(404).json({ error: 'not_found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'server_error' }); });

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => console.log(`EASY EARN backend listening on http://0.0.0.0:${PORT} (driver: ${require('.//db').driver})`));
}
module.exports = app;
