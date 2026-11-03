# EASY EARN — Backend

Node.js 24 + Express + SQLite. Real ledger, real JWT auth, no fake money.

## Run

```bash
cd backend
cp .env.example .env   # then edit JWT_SECRET and the other values
npm install
npm start              # listens on http://0.0.0.0:3000 (PORT env override)
```

The server creates `./data/shah-earn.sqlite` on first start and seeds:

- Admin: `admin@shahearn.local` / `Admin123!` — **change this password on first login** (there is no forced-change flow yet; do it before exposing the admin account).
- Sample tasks only: a manual-verification task (credits nothing until verified), a backend-verified task, and an offerwall task (credited only by signed postback).

If `better-sqlite3` cannot be built on your machine, `npm install` will fail for that package; remove it from `package.json` dependencies and reinstall — `src/db.js` automatically falls back to Node's built-in `node:sqlite` (`DatabaseSync`, Node 22+). No code changes are needed for the fallback.

## How money works (read this before promising anything to users)

- There is **no stored balance column**. `GET /api/wallet` derives the balance from the `transactions` ledger:
  - `available_coins` = sum of signed ledger amounts (earned +, spent −, pending withdrawals −, paid withdrawals −, rejected refunds +).
  - `pending_coins` = coins locked in pending/approved withdrawals, shown separately.
- Currency: PKR. Default rate: **100 coins = 1 PKR** (`coin_to_pkr_rate` in config). Default minimum withdrawal: **500 PKR**.
- Earnings are **not guaranteed** and depend on real partner availability. Never advertise a fixed income.

## Payout-source configuration (admin reference, manual payout only)

Payout-source details belong **only in the deployment server's environment** — set `PAYOUT_ACCOUNT_HOLDER`, `PAYOUT_JAZZCASH_ACCOUNT`, `PAYOUT_EASYPAISA_ACCOUNT`, and `PAYOUT_BANK_ACCOUNT` as environment variables on the server itself. They are **not** in code, not in `.env.example` (placeholders only), not in logs, and not in any user-facing or public response.

- They are **for admin reference for manual payout only**. They are **not** merchant API credentials.
- They **do not trigger any automatic payment, API transfer, or payout call** — no such code path exists in this backend.
- An admin can view them masked only via `GET /api/admin/payout-source` (JWT + `role=admin` required). Account numbers show only the last 2 digits; the holder name is also masked. Regular users and `GET /api/config/public` never receive them.
- The withdrawal flow is unchanged and strict (see below): a user requests a withdrawal to **their own** JazzCash/Easypaisa/bank account, it stays pending, an admin must explicitly approve it, and it may only be marked paid after the admin enters a `payout_reference` confirming an external payout they made themselves. Rejection refunds the locked coins.

## Withdrawals — the payment gate

1. User requests a withdrawal → coins are **locked** as `withdrawal_pending`, status `pending`. This is **not** a payment.
2. Admin approves → status `approved`. Still **not** paid.
3. Admin performs a **real** JazzCash / Easypaisa / bank payout outside this system, then calls `POST /api/admin/withdrawals/:id/mark-paid` with the real `payout_reference` from that transaction → status `paid`, ledger entry becomes `withdrawal_paid`.
4. Admin rejects → status `rejected` and the locked coins are refunded via a `withdrawal_rejected_refund` ledger row.

**Until a payment provider is integrated, step 3 must never be used with a made-up reference.** `JAZZCASH_*` / `EASYPAISA_*` in `.env.example` are placeholders. To integrate for real: implement the provider's payout API call, store its transaction ID as `payout_reference`, and only then mark paid. Bank transfer works the same way (manual payout + reference) unless a bank API is connected.

## Ads (AdMob)

- `POST /api/ads/reward` awards a **fixed server-side amount** (`ad_reward_coins`, default 10), capped per PKT day (`ad_daily_cap`, default 100), and is **idempotent by `ad_event_id`** — the same event can never credit twice. The client never chooses the reward.
- **SSV hook:** when `ADMOB_SSV_KEY` is unset, rewards run in audit-logged capped mode (development only). When it is set, unsigned claims are rejected in `server.js` (`verifyAdMobSSV`) until Google SSV public-key verification is wired in. Real AdMob SSV uses Google's public keys, not a shared secret — do not accept a self-asserted signature as proof. Set real AdMob unit IDs in env; they are exposed (without secrets) at `GET /api/config/public`.

## Offerwall / surveys

Partner postbacks go to `POST /api/offerwall/postback` (no JWT — the partner server calls it). It requires `OFFERWALL_SECRET` and verifies:

```
signature = HMAC-SHA256_hex( OFFERWALL_SECRET, "<transaction_id>|<user_id>|<coins>" )
```

sent as `signature` in the body or `x-offerwall-signature` header. Credits are idempotent by `transaction_id`. Without the secret, the endpoint returns 503 and credits nothing. The app-side `POST /api/tasks/:id/complete` **refuses** offerwall tasks.

Example (with `OFFERWALL_SECRET=test-secret`):

```bash
SIG=$(python3 -c "import hmac,hashlib; print(hmac.new(b'test-secret', b'tx123|2|50', hashlib.sha256).hexdigest())")
curl -X POST http://localhost:3000/api/offerwall/postback \
  -H 'Content-Type: application/json' \
  -d "{\"transaction_id\":\"tx123\",\"user_id\":2,\"coins\":50,\"signature\":\"$SIG\"}"
```

## Games, spins, check-ins, referrals

- Check-in: once per **PKT day** (`Asia/Karachi`), streak counted from the previous PKT day, idempotent on repeat calls. Credits `daily_checkin_coins` from config.
- Spin: server-side weighted RNG from `spin_weights` config, `spin_free_per_day` free spins per PKT day. Prizes are server-chosen, never client-chosen.
- Games: `POST /api/games/submit` validates game, score and duration server-side (e.g. tap: max 20 taps/sec), rejects absurd scores, logs a `fraud_events` row, and caps daily game coins (`game_daily_cap`).
- Referral: a referrer is credited **once**, when the referred user completes their **first** check-in (`referral_reward_coins`, default 100), logged as `referral:<user_id>`.
- Fraud: duplicate device (≥3 accounts) or IP (≥5 accounts) at registration **flags** the account (`fraud_flag = 1`) and logs a `fraud_events` row — it does not silently auto-ban. Admins review flags at `GET /api/admin/fraud` and can flag/ban explicitly.

## Admin

All `/api/admin/*` routes require a JWT for a user with `role=admin` (see `src/middleware.js`).

- `GET /api/admin/stats` — users, earned coins, pending/paid withdrawals, revenue, expenses. **Revenue is only admin-entered rows** (`POST /api/admin/revenue` with real, verified ad revenue); if none exist it is `0`. It is never invented.
- Users: list, flag, ban. Tasks: create/update/soft-delete. Config: update whitelisted keys only.
- Withdrawals: list, approve, mark-paid (requires `payout_reference`), reject (refunds).
- Payout source: `GET /api/admin/payout-source` — masked admin reference only (see above); `.gitignore` covers `.env` and the SQLite data file.
- Transactions, ad events, fraud events, tickets, broadcast/user notifications.

## Push notifications

`GET /api/notifications` and `POST /api/notifications/:id/read` are in-app notifications. Real FCM push requires a configured FCM project (`FCM_SERVER_KEY` / `FCM_PROJECT_ID` placeholders in `.env.example`) and is not wired in this backend — do not claim push delivery works until that integration is added. Admin broadcasts via `POST /api/admin/notify` create in-app notifications for all (non-banned) users or one user.

## Static admin panel

`server.js` serves `backend/public/` with `express.static` **if that directory exists**. This backend does not create it; the admin panel is added separately.

## API summary

Auth: `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me` (JWT, 7 days).
User (JWT): `GET /api/wallet`, `GET /api/transactions`, `POST /api/checkin`, `POST /api/ads/reward`, `GET /api/tasks`, `POST /api/tasks/:id/complete`, `POST /api/games/submit`, `POST /api/spin`, `GET /api/referrals`, `POST|GET /api/withdrawals`, `POST|GET /api/support`, `GET /api/support/:id`, `POST /api/support/:id/reply`, `GET /api/notifications`, `POST /api/notifications/:id/read`, `GET /api/config/public`.
Server-to-server: `POST /api/offerwall/postback` (HMAC, no JWT).

## What is NOT real yet (do not claim otherwise)

- No live AdMob, offerwall partner, JazzCash, Easypaisa, bank, or FCM account is connected by default. Each needs its own account, credentials in `.env`, and (for ads/offerwall) the verification step above.
- No APK, Android app, privacy policy, or terms pages are in this backend folder — those belong to the Android/docs work, not this backend.
