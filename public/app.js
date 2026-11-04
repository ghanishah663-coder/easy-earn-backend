/* EASY EARN website — talks only to the real backend API (same origin by default).
   No balances or rewards are ever invented here: every coin comes from a
   server response backed by the backend ledger. */
(function () {
  'use strict';
  var token = localStorage.getItem('easyearn_token') || '';
  var user = null, cfg = null;

  function $(id) { return document.getElementById(id); }
  function show(el, msg, ok) {
    if (!el) return;
    el.className = ok ? 'ok' : 'error';
    el.textContent = msg || '';
    el.classList.remove('hidden');
  }
  function hide(el) { if (el) el.classList.add('hidden'); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  async function api(path, opts) {
    opts = opts || {};
    var res = await fetch(path, {
      method: opts.method || 'GET',
      headers: Object.assign({ 'Content-Type': 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      var err = new Error((data && (data.message || data.error)) || ('Request failed: ' + res.status));
      err.data = data; err.status = res.status; throw err;
    }
    return data;
  }
  function setAuth(t, u) {
    token = t || ''; user = u || null;
    if (t) localStorage.setItem('easyearn_token', t); else localStorage.removeItem('easyearn_token');
    $('authView').classList.toggle('hidden', !!t);
    $('appView').classList.toggle('hidden', !t);
    $('logoutBtn').classList.toggle('hidden', !t);
    $('userBadge').textContent = u ? (u.name + ' · ' + u.email + (u.role === 'admin' ? ' · admin' : '')) : '';
  }
  function showTab(name) {
    document.querySelectorAll('nav.tabs button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === name);
    });
    document.querySelectorAll('.tabpane').forEach(function (s) {
      s.classList.toggle('hidden', s.id !== 'tab-' + name);
    });
    if (name === 'wallet') loadWallet();
    if (name === 'tasks') loadTasks();
    if (name === 'referrals') loadReferrals();
    if (name === 'notifications') loadNotifications();
    if (name === 'support') loadTickets();
  if (name === 'deposit') loadPaymentMethods();
     
  document.querySelectorAll('nav.tabs button').forEach(function (b) {
    b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
  });
  document.querySelectorAll('[data-tab-link]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      if (token) showTab(a.getAttribute('data-tab-link'));
    });
  });

  async function loadConfig() {
    try { cfg = await api('/api/config/public'); } catch (e) { cfg = null; }
    if (cfg) {
      $('cfgRate').textContent = cfg.coin_to_pkr_rate;
      $('cfgMin').textContent = cfg.min_withdrawal_pkr + ' PKR';
    }
  }
  async function loadWallet() {
    try {
      var w = await api('/api/wallet');
      $('wAvailable').textContent = w.available_coins;
      $('wPkr').textContent = Number(w.available_pkr).toFixed(2) + ' PKR';
      $('wPending').textContent = w.pending_coins + ' (' + Number(w.pending_pkr).toFixed(2) + ' PKR)';
      $('wEarned').textContent = w.total_earned_coins;
      var tx = await api('/api/transactions?limit=50');
      $('txBody').innerHTML = tx.map(function (t) {
        return '<tr><td>' + t.id + '</td><td>' + esc(t.type) + '</td><td>' + t.amount_coins + '</td><td>' + Number(t.amount_pkr).toFixed(2) + '</td><td>' + esc(t.status) + '</td><td>' + esc(t.reference) + '</td></tr>';
      }).join('') || '<tr><td colspan="6">No transactions yet.</td></tr>';
      var wds = await api('/api/withdrawals');
      $('wdBody').innerHTML = wds.map(function (w) {
        return '<tr><td>' + w.id + '</td><td>' + esc(w.method) + '</td><td>' + esc(w.account_number) + '</td><td>' + w.amount_pkr + '</td><td>' + esc(w.status) + '</td></tr>';
      }).join('') || '<tr><td colspan="5">No withdrawals yet.</td></tr>';
      hide($('txError'));
    } catch (e) { show($('txError'), e.message); }
  }
  async function loadMe() {
    try {
      var d = await api('/api/auth/me');
      user = d.user;
      $('dashUser').textContent = 'Signed in as ' + d.user.name + ' (' + d.user.email + ') · Referral code: ' + d.user.referral_code + (d.user.fraud_flag ? ' · Account flagged for admin review' : '');
      $('wAvailable').textContent = d.wallet.available_coins;
      $('wPkr').textContent = Number(d.wallet.available_pkr).toFixed(2) + ' PKR';
      $('wPending').textContent = d.wallet.pending_coins;
      $('wEarned').textContent = d.wallet.total_earned_coins;
    } catch (e) { setAuth('', null); }
  }
  async function loadTasks() {
    try {
      var tasks = await api('/api/tasks');
      $('tasksList').innerHTML = tasks.map(function (t) {
        return '<div class="card"><b>' + esc(t.title) + '</b> · ' + esc(t.type) + ' · ' + t.reward_coins + ' coins'
          + (t.type === 'offerwall' ? ' <span class="muted">(partner postback only — this button cannot credit it)</span>' : '')
          + '<p><button type="button" data-task="' + t.id + '">Complete task</button></p></div>';
      }).join('') || '<p class="muted">No active tasks.</p>';
      document.querySelectorAll('[data-task]').forEach(function (b) {
        b.addEventListener('click', async function () {
          try {
            var r = await api('/api/tasks/' + b.getAttribute('data-task') + '/complete', { method: 'POST' });
            show($('globalOk'), 'Task result: ' + (r.status || '') + (r.coins ? ' · +' + r.coins + ' coins' : '') + (r.message ? ' · ' + r.message : ''), true);
            loadWallet(); loadMe();
          } catch (e) { show($('globalError'), e.message); }
        });
      });
      hide($('tasksError'));
    } catch (e) { show($('tasksError'), e.message); }
  }
  async function loadReferrals() {
    try {
      var r = await api('/api/referrals');
      $('refCode').textContent = r.referral_code;
      $('refSummary').textContent = r.count + ' referred users · ' + r.referral_earnings_coins + ' coins earned from referrals.';
      $('refList').innerHTML = r.referred.map(function (x) {
        return '<p>' + esc(x.name) + ' · credited: ' + (x.credited ? 'yes' : 'not yet — credited on their first check-in') + '</p>';
      }).join('') || '<p class="muted">No referrals yet.</p>';
    } catch (e) { /* shown on next refresh */ }
  }
  async function loadNotifications() {
    try {
      var list = await api('/api/notifications');
      $('notifList').innerHTML = list.map(function (n) {
        return '<div class="card"><b>' + esc(n.title) + '</b><p>' + esc(n.body) + '</p><p class="muted">' + (n.is_read ? 'Read' : 'Unread') + ' <button class="secondary" type="button" data-notif="' + n.id + '">Mark read</button></p></div>';
      }).join('') || '<p class="muted">No notifications.</p>';
      document.querySelectorAll('[data-notif]').forEach(function (b) {
        b.addEventListener('click', async function () {
          await api('/api/notifications/' + b.getAttribute('data-notif') + '/read', { method: 'POST' });
          loadNotifications();
        });
      });
    } catch (e) { /* ignore */ }
  }
  async function loadTickets() {
    try {
      var list = await api('/api/support');
      $('ticketList').innerHTML = list.map(function (t) {
        return '<div class="card"><b>#' + t.id + ' ' + esc(t.subject) + '</b> · ' + esc(t.status) + '<p>' + esc(t.message) + '</p><p><button class="secondary" type="button" data-ticket="' + t.id + '">View / reply</button></p></div>';
      }).join('') || '<p class="muted">No tickets yet.</p>';
      document.querySelectorAll('[data-ticket]').forEach(function (b) {
        b.addEventListener('click', async function () {
          var d = await api('/api/support/' + b.getAttribute('data-ticket'));
          $('ticketDetail').innerHTML = '<div class="card"><h3>Ticket #' + d.ticket.id + '</h3>'
            + d.replies.map(function (r) { return '<p><b>' + esc(r.role) + ':</b> ' + esc(r.message) + '</p>'; }).join('')
            + '<form id="ticketReplyForm"><label>Reply</label><textarea id="ticketReplyText" required rows="3"></textarea><p><button type="submit">Send reply</button></p></form></div>';
          $('ticketReplyForm').addEventListener('submit', async function (e) {
            e.preventDefault();
            await api('/api/support/' + d.ticket.id + '/reply', { method: 'POST', body: { message: $('ticketReplyText').value } });
            loadTickets();
          });
        });
      });
      hide($('supportError'));
    } catch (e) { show($('supportError'), e.message); }
  }

  $('loginForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    try {
      var d = await api('/api/auth/login', { method: 'POST', body: { email: $('loginEmail').value, password: $('loginPassword').value } });
      setAuth(d.token, d.user); hide($('loginError')); await loadConfig(); await loadMe();
    } catch (err) { show($('loginError'), err.message); }
  });
  $('registerForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    try {
      var d = await api('/api/auth/register', { method: 'POST', body: {
        name: $('regName').value, email: $('regEmail').value, password: $('regPassword').value,
        referral_code: $('regReferral').value || undefined, language: 'en'
      } });
      setAuth(d.token, d.user); hide($('registerError')); await loadConfig(); await loadMe();
      show($('globalOk'), 'Account created. Welcome to EASY EARN.', true);
    } catch (err) { show($('registerError'), err.message); }
  });
  $('logoutBtn').addEventListener('click', function () { setAuth('', null); });

  $('checkinBtn').addEventListener('click', async function () {
    try {
      var r = await api('/api/checkin', { method: 'POST' });
      $('checkinResult').textContent = r.already_checked_in ? ('Already checked in today · streak ' + r.streak) : ('+' + r.coins + ' coins · streak ' + r.streak);
      await loadMe();
    } catch (e) { $('checkinResult').textContent = e.message; }
  });
  $('spinBtn').addEventListener('click', async function () {
    try {
      $('wheel').textContent = '…';
      var r = await api('/api/spin', { method: 'POST' });
      $('wheel').textContent = r.prize;
      $('spinResult').textContent = '+' + r.coins + ' coins · ' + r.spins_remaining + ' free spins left today';
      await loadMe();
    } catch (e) { $('wheel').textContent = 'SPIN'; $('spinResult').textContent = e.message; }
  });
  $('adBtn').addEventListener('click', async function () {
    try {
      var r = await api('/api/ads/reward', { method: 'POST', body: { ad_event_id: 'web-dev-' + Date.now() + '-' + Math.random().toString(36).slice(2), network: 'dev' } });
      $('adResult').textContent = r.duplicate ? ('Already credited for this event · +' + r.coins_awarded + ' coins') : ('+' + r.coins_awarded + ' coins (dev mode — not a verified AdMob view)');
      await loadMe();
    } catch (e) { $('adResult').textContent = e.message; }
  });

  // Tap Challenge: 10 seconds
  var tapState = null;
  $('tapBox').addEventListener('click', function () {
    if (!tapState) {
      tapState = { taps: 0, start: Date.now() };
      $('tapBox').textContent = 'Tap fast! 0';
      setTimeout(async function () {
        var duration = Date.now() - tapState.start, score = tapState.taps;
        tapState = null;
        $('tapBox').textContent = 'Submitting ' + score + ' taps…';
        try {
          var r = await api('/api/games/submit', { method: 'POST', body: { game: 'tap', score: score, duration_ms: duration } });
          $('tapResult').textContent = '+' + r.coins_awarded + ' coins (daily cap ' + r.daily_cap + ')';
          $('tapBox').textContent = 'Tap to start again';
          await loadMe();
        } catch (e) { $('tapResult').textContent = e.message; $('tapBox').textContent = 'Tap to start'; }
      }, 10000);
      return;
    }
    tapState.taps++;
    $('tapBox').textContent = 'Tap fast! ' + tapState.taps;
  });

  // Memory Match: 8 pairs
  var mem = null;
  function renderMemory() {
    $('memoryBoard').innerHTML = mem.cards.map(function (c, i) {
      var shown = c.flipped || c.done;
      return '<div class="memcard' + (c.done ? ' done' : '') + '" data-i="' + i + '">' + (shown ? c.emoji : '?') + '</div>';
    }).join('');
    document.querySelectorAll('.memcard').forEach(function (el) {
      el.addEventListener('click', function () {
        var i = Number(el.getAttribute('data-i')), c = mem.cards[i];
        if (c.flipped || c.done || mem.lock) return;
        c.flipped = true; mem.flips++;
        var open = mem.cards.filter(function (x) { return x.flipped && !x.done; });
        if (open.length === 2) {
          mem.lock = true;
          setTimeout(function () {
            if (open[0].emoji === open[1].emoji) { open[0].done = open[1].done = true; mem.matched++; }
            else { open[0].flipped = open[1].flipped = false; }
            mem.lock = false; renderMemory();
            if (mem.matched === 8) finishMemory();
          }, 600);
        }
        renderMemory();
      });
    });
  }
  async function finishMemory() {
    var duration = Date.now() - mem.start;
    var score = mem.matched * 100;
    $('memoryResult').textContent = 'Finished: ' + score + ' points — submitting…';
    try {
      var r = await api('/api/games/submit', { method: 'POST', body: { game: 'memory', score: score, duration_ms: duration } });
      $('memoryResult').textContent = '+' + r.coins_awarded + ' coins (daily cap ' + r.daily_cap + ')';
      await loadMe();
    } catch (e) { $('memoryResult').textContent = e.message; }
    mem = null;
  }
  $('memoryStart').addEventListener('click', function () {
    var emojis = ['🍎', '⭐', '🎵', '🚀', '💎', '🌙', '🔥', '🎯'];
    var cards = emojis.concat(emojis).map(function (e) { return { emoji: e, flipped: false, done: false }; });
    for (var i = cards.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = cards[i]; cards[i] = cards[j]; cards[j] = t; }
    mem = { cards: cards, matched: 0, flips: 0, lock: false, start: Date.now() };
    $('memoryResult').textContent = 'Find all pairs!';
    renderMemory();
  });

  $('copyRef').addEventListener('click', function () {
    var code = $('refCode').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(code);
    $('refSummary').textContent = 'Copied: ' + code;
  });
  $('refreshTx').addEventListener('click', loadWallet);
  $('refreshNotif').addEventListener('click', loadNotifications);
  $('wdForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    try {
      var r = await api('/api/withdrawals', { method: 'POST', body: {
        method: $('wdMethod').value, account_number: $('wdAccount').value,
        account_name: $('wdName').value, amount_pkr: Number($('wdAmount').value)
      } });
      show($('wdResult'), 'Withdrawal requested: ' + r.withdrawal.amount_pkr + ' PKR via ' + r.withdrawal.method + ' — status: ' + r.withdrawal.status + '. Coins are locked until an admin confirms a real payout.', true);
      hide($('wdError')); await loadMe(); loadWallet();
    } catch (err) { show($('wdError'), err.message); }
  });
  $('supportForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    try {
      await api('/api/support', { method: 'POST', body: { subject: $('supSubject').value, message: $('supMessage').value } });
      show($('globalOk'), 'Support ticket sent.', true); $('supSubject').value = ''; $('supMessage').value = '';
      loadTickets();
    } catch (err) { show($('supportError'), err.message); }
  });

  // Restore session
  if (token) {
    setAuth(token, null);
    loadConfig(); loadMe();
  }
})();
