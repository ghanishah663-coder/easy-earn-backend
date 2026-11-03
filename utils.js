'use strict';
const crypto = require('crypto');
const { prepare, transaction } = require('./db');

// Pakistan date (Asia/Karachi) as YYYY-MM-DD — check-ins, spins, ads and
// games are all capped per PKT day, and the API says so in its responses.
function pktDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function prevPktDate() {
  const d = new Date(Date.now() - 24 * 3600 * 1000);
  return pktDate(d);
}
function getConfig() {
  const rows = prepare('SELECT key, value FROM config').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  const num = (k, d) => { const v = Number(out[k]); return Number.isFinite(v) ? v : d; };
  let weights;
  try { weights = JSON.parse(out.spin_weights || '[]'); } catch { weights = []; }
  if (!Array.isArray(weights) || !weights.length) weights = [{ label: '0 coins', coins: 0, weight: 1 }];
  return {
    coin_to_pkr_rate: num('coin_to_pkr_rate', 100),
    min_withdrawal_pkr: num('min_withdrawal_pkr', 500),
    daily_checkin_coins: num('daily_checkin_coins', 20),
    spin_free_per_day: num('spin_free_per_day', 3),
    spin_weights: weights,
    game_daily_cap: num('game_daily_cap', 200),
    ad_daily_cap: num('ad_daily_cap', 100),
    ad_reward_coins: num('ad_reward_coins', 10),
    referral_reward_coins: num('referral_reward_coins', 100),
  };
}
function publicConfig() {
  const c = getConfig();
  return {
    ...c,
    ad_app_id: process.env.ADMOB_APP_ID || null,
    ad_rewarded_unit_id: process.env.ADMOB_REWARDED_AD_UNIT_ID || null,
    ad_banner_unit_id: process.env.ADMOB_BANNER_AD_UNIT_ID || null,
    offerwall_url: process.env.OFFERWALL_URL || null,
    currency: 'PKR',
    // No secrets are ever returned here.
  };
}
function coinsToPkr(coins, cfg = getConfig()) { return coins / cfg.coin_to_pkr_rate; }

/**
 * Balance derivation — the single source of truth.
 * available = SUM of signed ledger amounts (earned +, spent -, pending
 * withdrawals -, paid withdrawals -, rejected refunds + to cancel the
 * original pending entry). pending = locked coins in pending/approved
 * withdrawals. There is no stored balance to go stale or be faked.
 */
function getBalance(userId) {
  const row = prepare(`SELECT COALESCE(SUM(amount_coins),0) available,
    COALESCE(SUM(CASE WHEN type='earned' THEN amount_coins ELSE 0 END),0) earned,
    COALESCE(SUM(CASE WHEN type='withdrawal_pending' AND status IN ('pending','approved') THEN -amount_coins ELSE 0 END),0) pending_coins
    FROM transactions WHERE user_id = ?`).get(userId);
  const cfg = getConfig();
  return {
    available_coins: row.available,
    available_pkr: row.available / cfg.coin_to_pkr_rate,
    pending_coins: row.pending_coins,
    pending_pkr: row.pending_coins / cfg.coin_to_pkr_rate,
    total_earned_coins: row.earned,
    coin_to_pkr_rate: cfg.coin_to_pkr_rate,
  };
}
// Atomic credit: inserts the ledger row inside a transaction.
function credit(userId, coins, reference, type = 'earned') {
  if (!Number.isInteger(coins) || coins <= 0) throw new Error('credit amount must be a positive integer');
  return transaction(() => {
    const cfg = getConfig();
    const r = prepare(`INSERT INTO transactions (user_id, type, amount_coins, amount_pkr, status, reference)
                       VALUES (?, ?, ?, ?, 'completed', ?)`).run(userId, type, coins, coinsToPkr(coins, cfg), reference);
    return r.lastInsertRowid;
  });
}
function notify(userId, title, body) {
  prepare('INSERT INTO notifications (user_id, title, body) VALUES (?, ?, ?)').run(userId, title, body);
}
function fraud(userId, type, detail, req) {
  prepare('INSERT INTO fraud_events (user_id, type, detail, ip, device_id) VALUES (?, ?, ?, ?, ?)')
    .run(userId || null, type, detail || null, req?.ip || null, req?.body?.device_id || req?.headers?.['x-device-id'] || null);
}
function makeReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
  return 'EASY' + code;
}
function publicUser(u) {
  if (!u) return null;
  const { password_hash, ...rest } = u;
  return rest;
}
function validEmail(e) { return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

// ---- Admin payout-source reference (manual payout only) ----
// Read ONLY from environment variables. These are NOT merchant API
// credentials and MUST NOT trigger any automatic payment, API transfer,
// or payout call — there is no payout code path anywhere in this backend.
// The values are never logged and never returned unmasked. This helper is
// used only by the admin-only GET /api/admin/payout-source endpoint.
function maskAccount(v) {
  if (!v) return null;
  const s = String(v).replace(/\s+/g, '');
  if (s.length <= 2) return '**';
  return '*'.repeat(Math.max(4, s.length - 2)) + s.slice(-2);
}
function maskName(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (s.length <= 2) return '**';
  return s[0] + '*'.repeat(Math.max(2, s.length - 2)) + s.slice(-1);
}
function getMaskedPayoutSource() {
  const holder = process.env.PAYOUT_ACCOUNT_HOLDER || null;
  const jazzcash = process.env.PAYOUT_JAZZCASH_ACCOUNT || null;
  const easypaisa = process.env.PAYOUT_EASYPAISA_ACCOUNT || null;
  const bank = process.env.PAYOUT_BANK_ACCOUNT || null;
  return {
    manual_payout_only: true,
    automatic_payment_enabled: false,
    note: 'Admin reference for manual payouts only. This is not a merchant credential and does not trigger any automatic payment. A withdrawal is paid only when an admin confirms an external payout they made themselves, with a payout_reference.',
    configured: { account_holder: !!holder, jazzcash: !!jazzcash, easypaisa: !!easypaisa, bank: !!bank },
    payout_account_holder_masked: maskName(holder),
    payout_jazzcash_account_masked: maskAccount(jazzcash),
    payout_easypaisa_account_masked: maskAccount(easypaisa),
    payout_bank_account_masked: maskAccount(bank),
  };
}
module.exports = { pktDate, prevPktDate, getConfig, publicConfig, coinsToPkr, getBalance, credit, notify, fraud, makeReferralCode, publicUser, validEmail, getMaskedPayoutSource };
