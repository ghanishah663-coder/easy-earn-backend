/* EASY EARN Admin Panel — talks only to the real backend API.
   No mock/demo data. A failed endpoint is shown as an error, never
   replaced with invented users, revenue or transactions.
   Token: sessionStorage only (cleared when the tab/browser closes).
   Base URL: optional field, default "" = same origin. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var state = { token: sessionStorage.getItem('shah_earn_admin_token') || '' };

  function baseUrl() {
    var v = ($('baseUrl') ? $('baseUrl').value : '').trim().replace(/\/$/, '');
    return v;
  }
  function headers(json) {
    var h = {};
    if (json) h['Content-Type'] = 'application/json';
    if (state.token) h['Authorization'] = 'Bearer ' + state.token;
    return h;
  }
  function show(el, msg, isError) {
    if (!el) return;
    el.textContent = msg || '';
    el.className = msg ? (isError ? 'alert' : 'notice') : '';
    el.classList.toggle('hidden', !msg);
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(v) {
    if (v == null || v === '') return '—';
    var n = Number(v);
    return isNaN(n) ? esc(v) : 'PKR ' + n.toLocaleString('en-PK');
  }
  function pick(obj, keys, fallback) {
    if (!obj || typeof obj !== 'object') return fallback;
    for (var i = 0; i < keys.length; i++) {
      if (obj[keys[i]] != null) return obj[keys[i]];
    }
    return fallback;
  }
  function listOf(data, keys) {
    if (Array.isArray(data)) return data;
    for (var i = 0; i < keys.length; i++) {
      if (Array.isArray(data && data[keys[i]])) return data[keys[i]];
    }
    return null;
  }

  async function api(path, opts) {
    opts = opts || {};
    var res;
    try {
      res = await fetch(baseUrl() + path, {
        method: opts.method || 'GET',
        headers: headers(opts.json !== false),
        body: opts.body ? JSON.stringify(opts.body) : undefined
      });
    } catch (e) {
      throw new Error('Network error calling ' + path + ': ' + e.message +
        '. Check the backend is running and BASE_URL is correct.');
    }
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!res.ok) {
      var detail = (data && (data.message || data.error)) || text || res.statusText;
      throw new Error(path + ' → HTTP ' + res.status + ': ' + detail);
    }
    return data;
  }

  function requireAuth() {
    if (!state.token) {
      show($('globalError'), 'Not logged in. Log in with an admin account first.', true);
      return false;
    }
    return true;
  }
  function setLoggedIn(on) {
    $('loginView').classList.toggle('hidden', on);
    $('appView').classList.toggle('hidden', !on);
    if (on) $('adminEmail').textContent = sessionStorage.getItem('shah_earn_admin_email') || 'Admin';
  }

  // ---------- Login / logout ----------
  $('loginForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    show($('loginError'), '');
    var email = $('loginEmail').value.trim();
    var password = $('loginPassword').value;
    if (!email || !password) { show($('loginError'), 'Enter email and password.', true); return; }
    try {
      var data = await api('/api/auth/login', { method: 'POST', body: { email: email, password: password } });
      var user = data.user || data.account || {};
      var token = data.token || data.accessToken || data.jwt;
      var role = user.role || data.role || '';
      if (!token) throw new Error('Login succeeded but the server returned no token.');
      if (role && role !== 'admin') {
        throw new Error('This account is not an admin account (role: ' + role + '). Admin access denied.');
      }
      // If the server gives no role, do not assume admin: verify via an admin endpoint.
      state.token = token;
      sessionStorage.setItem('shah_earn_admin_token', token);
      sessionStorage.setItem('shah_earn_admin_email', email);
      if (!role) {
        try { await api('/api/admin/stats'); }
        catch (err) {
          state.token = ''; sessionStorage.removeItem('shah_earn_admin_token');
          throw new Error('Admin verification failed: ' + err.message +
            ' — only accounts the backend recognises as admin can use this panel.');
        }
      }
      setLoggedIn(true);
      show($('globalError'), '');
      loadDashboard();
    } catch (err) { show($('loginError'), err.message, true); }
  });
  $('logoutBtn').addEventListener('click', function () {
    state.token = '';
    sessionStorage.removeItem('shah_earn_admin_token');
    sessionStorage.removeItem('shah_earn_admin_email');
    setLoggedIn(false);
  });
  $('baseUrl').value = localStorage.getItem('shah_earn_admin_base_url') || '';
  $('baseUrl').addEventListener('change', function () {
    localStorage.setItem('shah_earn_admin_base_url', $('baseUrl').value.trim());
  });

  // ---------- Tabs ----------
  var tabs = document.querySelectorAll('[data-tab]');
  tabs.forEach(function (btn) {
    btn.addEventListener('click', function () {
      tabs.forEach(function (b) { b.classList.toggle('active', b === btn); });
      document.querySelectorAll('.tabpane').forEach(function (p) {
        p.classList.toggle('hidden', p.id !== 'tab-' + btn.dataset.tab);
      });
      var loaders = {
        dashboard: loadDashboard, users: loadUsers, tasks: loadTasks,
        rewards: loadRewards, withdrawals: loadWithdrawals,
        transactions: loadTransactions, ads: loadAds, fraud: loadFraud, support: loadTickets
      };
      if (loaders[btn.dataset.tab]) loaders[btn.dataset.tab]();
    });
  });

  // ---------- Dashboard ----------
  async function loadDashboard() {
    if (!requireAuth()) return;
    show($('statsError'), 'Loading…');
    try {
      var d = await api('/api/admin/stats');
      var s = d.stats || d.data || d || {};
      // Actual backend field names (server.js /api/admin/stats):
      $('statUsers').textContent = pick(s, ['users', 'total_users', 'user_count'], 0);
      var earnedCoins = pick(s, ['total_earned_coins', 'total_earned', 'totalEarned'], null);
      $('statEarned').textContent = earnedCoins == null ? '—' : Number(earnedCoins).toLocaleString('en-PK') + ' coins';
      $('statPending').textContent = money(pick(s, ['total_pending_withdrawals_pkr', 'pending_withdrawals', 'pending'], 0));
      $('statPaid').textContent = money(pick(s, ['total_paid_withdrawals_pkr', 'total_paid', 'paid'], 0));
      $('statRevenue').textContent = money(pick(s, ['total_revenue_pkr', 'total_revenue', 'revenue'], 0));
      $('statExpenses').textContent = money(pick(s, ['total_expenses_pkr', 'total_expenses', 'expenses'], 0));
      $('statNote').textContent = 'Figures are exactly what GET /api/admin/stats returned. ' +
        'If the backend has no revenue/expense records yet, those values are 0 — they are not estimates.';
      show($('statsError'), '');
    } catch (err) {
      ['statUsers', 'statEarned', 'statPending', 'statPaid', 'statRevenue', 'statExpenses']
        .forEach(function (id) { $(id).textContent = '—'; });
      $('statNote').textContent = '';
      show($('statsError'), err.message, true);
    }
  }
  $('refreshStats').addEventListener('click', loadDashboard);

  // ---------- Users ----------
  async function loadUsers() {
    if (!requireAuth()) return;
    show($('usersError'), 'Loading…');
    try {
      var d = await api('/api/admin/users');
      var users = listOf(d, ['users', 'data', 'items']);
      if (!users) throw new Error('GET /api/admin/users did not return a user list.');
      $('usersBody').innerHTML = users.length ? users.map(function (u) {
        var id = u.id || u._id || '';
        var w = u.wallet || {};
        return '<tr><td>' + esc(id) + '</td><td>' + esc(pick(u, ['name', 'username'], '—')) +
          '<br><span class="muted">' + esc(pick(u, ['email', 'phone'], '')) + '</span></td>' +
          '<td>' + esc(pick(w, ['available_coins'], pick(u, ['coins', 'balance_coins'], 0))) + '</td>' +
          '<td>' + money(pick(w, ['available_pkr'], pick(u, ['balance_pkr', 'balance'], 0))) + '</td>' +
          '<td>' + (u.fraud_flag || u.flagged ? '<span class="badge flagged">flagged</span> ' : '') +
          (u.is_banned || u.banned ? '<span class="badge banned">banned</span>' : '—') + '</td>' +
          '<td class="actions"><button class="secondary" data-act="flag" data-id="' + esc(id) + '">Flag</button>' +
          '<button class="danger" data-act="ban" data-id="' + esc(id) + '">Ban</button></td></tr>';
      }).join('') : '<tr><td colspan="6">No users returned.</td></tr>';
      show($('usersError'), users.length ? '' : 'No users returned by the backend.');
      $('usersBody').querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', async function () {
          var act = b.dataset.act, id = b.dataset.id;
          if (act === 'ban' && !confirm('Ban user ' + id + '? This blocks their account.')) return;
          try { await api('/api/admin/users/' + encodeURIComponent(id) + '/' + act, { method: 'POST', body: {} }); loadUsers(); }
          catch (err) { show($('usersError'), err.message, true); }
        });
      });
    } catch (err) { $('usersBody').innerHTML = ''; show($('usersError'), err.message, true); }
  }
  $('refreshUsers').addEventListener('click', loadUsers);

  // ---------- Tasks ----------
  async function loadTasks() {
    if (!requireAuth()) return;
    show($('tasksError'), 'Loading…');
    var d = null, lastErr = null;
    try { d = await api('/api/admin/tasks'); }
    catch (err) { lastErr = err; try { d = await api('/api/tasks'); lastErr = null; } catch (e2) { lastErr = e2; } }
    if (lastErr) { $('tasksBody').innerHTML = ''; show($('tasksError'), lastErr.message, true); return; }
    try {
      var tasks = listOf(d, ['tasks', 'data', 'items']);
      if (!tasks) throw new Error('Task endpoint did not return a task list.');
      $('tasksBody').innerHTML = tasks.length ? tasks.map(function (t) {
        var id = t.id || t._id || '';
        return '<tr><td>' + esc(id) + '</td><td>' + esc(t.title || '—') +
          '<br><span class="muted">' + esc(t.description || '') + '</span></td>' +
          '<td>' + esc(t.type || t.category || '—') + '</td>' +
          '<td>' + esc(pick(t, ['reward_coins', 'reward', 'coins'], 0)) + '</td>' +
          '<td>' + (t.active === false || t.enabled === false ? 'inactive' : 'active') + '</td>' +
          '<td class="actions"><button class="secondary" data-act="edit" data-id="' + esc(id) + '">Edit</button>' +
          '<button class="danger" data-act="del" data-id="' + esc(id) + '">Delete</button></td></tr>';
      }).join('') : '<tr><td colspan="6">No tasks returned.</td></tr>';
      show($('tasksError'), '');
      $('tasksBody').querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', async function () {
          var id = b.dataset.id;
          if (b.dataset.act === 'del') {
            if (!confirm('Delete task ' + id + '?')) return;
            try { await api('/api/admin/tasks/' + encodeURIComponent(id), { method: 'DELETE' }); loadTasks(); }
            catch (err) { show($('tasksError'), err.message, true); }
          } else {
            var coins = prompt('New reward (coins) for task ' + id + ':');
            if (coins === null) return;
            try { await api('/api/admin/tasks/' + encodeURIComponent(id), { method: 'PUT', body: { reward_coins: Number(coins) } }); loadTasks(); }
            catch (err) { show($('tasksError'), err.message, true); }
          }
        });
      });
    } catch (err) { show($('tasksError'), err.message, true); }
  }
  $('refreshTasks').addEventListener('click', loadTasks);
  $('taskForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    if (!requireAuth()) return;
    var body = {
      title: $('taskTitle').value.trim(),
      type: $('taskType').value.trim() || 'task',
      reward_coins: Number($('taskReward').value || 0),
      partner_url: $('taskUrl').value.trim() || undefined
      // Backend task columns: title, title_ur, type (survey/task/offerwall),
      // partner, partner_url, reward_coins, verification_mode, active.
      // There is no description column; the form's description is not sent.
    };
    if (!body.title) { show($('tasksError'), 'Task title is required.', true); return; }
    try { await api('/api/admin/tasks', { method: 'POST', body: body }); show($('tasksError'), 'Task created.'); e.target.reset(); loadTasks(); }
    catch (err) { show($('tasksError'), err.message, true); }
  });

  // ---------- Rewards / config ----------
  async function loadRewards() {
    if (!requireAuth()) return;
    show($('rewardsError'), 'Loading…');
    try {
      var d = await api('/api/config/public');
      var c = d.config || d.data || d || {};
      // Actual backend config keys (src/utils.js getConfig/publicConfig).
      // coin_to_pkr_rate = coins per PKR 1 (e.g. 100 = 100 coins = PKR 1).
      $('cfgCoinRate').value = pick(c, ['coin_to_pkr_rate'], '');
      $('cfgMinWithdrawal').value = pick(c, ['min_withdrawal_pkr'], '');
      $('cfgCheckin').value = pick(c, ['daily_checkin_coins'], '');
      $('cfgAdReward').value = pick(c, ['ad_reward_coins'], '');
      $('cfgAdCap').value = pick(c, ['ad_daily_cap'], '');
      $('cfgGameCap').value = pick(c, ['game_daily_cap'], '');
      $('cfgReferral').value = pick(c, ['referral_reward_coins'], '');
      $('cfgSpinFree').value = pick(c, ['spin_free_per_day'], '');
      $('cfgSpinWeights').value = JSON.stringify(pick(c, ['spin_weights'], []));
      $('rewardsRaw').textContent = JSON.stringify(c, null, 2);
      show($('rewardsError'), '');
    } catch (err) { show($('rewardsError'), err.message, true); }
  }
  $('refreshRewards').addEventListener('click', loadRewards);
  $('rewardsForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    if (!requireAuth()) return;
    // Only keys the backend allows in POST /api/admin/config; anything
    // else is rejected with invalid_config_key, so never send extras.
    var body = {};
    var setNum = function (key, elId) {
      var v = $(elId).value;
      if (v !== '') body[key] = Number(v);
    };
    setNum('coin_to_pkr_rate', 'cfgCoinRate');
    setNum('min_withdrawal_pkr', 'cfgMinWithdrawal');
    setNum('daily_checkin_coins', 'cfgCheckin');
    setNum('ad_reward_coins', 'cfgAdReward');
    setNum('ad_daily_cap', 'cfgAdCap');
    setNum('game_daily_cap', 'cfgGameCap');
    setNum('referral_reward_coins', 'cfgReferral');
    setNum('spin_free_per_day', 'cfgSpinFree');
    var weightsRaw = $('cfgSpinWeights').value.trim();
    if (weightsRaw) {
      try { body.spin_weights = JSON.parse(weightsRaw); }
      catch (e) { show($('rewardsError'), 'spin_weights must be valid JSON, e.g. [{"label":"10 coins","coins":10,"weight":5}].', true); return; }
    }
    try { await api('/api/admin/config', { method: 'POST', body: body }); show($('rewardsError'), 'Reward config saved (server-confirmed).'); loadRewards(); }
    catch (err) { show($('rewardsError'), err.message, true); }
  });

  // ---------- Withdrawals ----------
  async function loadWithdrawals() {
    if (!requireAuth()) return;
    show($('withdrawalsError'), 'Loading…');
    try {
      var d = await api('/api/admin/withdrawals');
      var list = listOf(d, ['withdrawals', 'data', 'items']);
      if (!list) throw new Error('GET /api/admin/withdrawals did not return a withdrawal list.');
      $('withdrawalsBody').innerHTML = list.length ? list.map(function (w) {
        var id = w.id || w._id || '';
        return '<tr><td>' + esc(id) + '</td><td>' + esc(pick(w, ['user_id', 'user', 'email'], '—')) + '</td>' +
          '<td>' + esc(pick(w, ['method', 'provider'], '—')) + '<br><span class="muted">' + esc(pick(w, ['account_name'], '')) + ' · ' + esc(pick(w, ['account_number', 'account'], '')) + '</span></td>' +
          '<td>' + money(pick(w, ['amount_pkr', 'amount'], 0)) + '</td><td>' + esc(w.status || '—') + '</td>' +
          '<td class="actions"><button class="secondary" data-act="approve" data-id="' + esc(id) + '">Approve</button>' +
          '<button data-act="paid" data-id="' + esc(id) + '">Mark paid</button>' +
          '<button class="danger" data-act="reject" data-id="' + esc(id) + '">Reject</button></td></tr>';
      }).join('') : '<tr><td colspan="6">No withdrawals returned.</td></tr>';
      show($('withdrawalsError'), '');
      $('withdrawalsBody').querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', async function () {
          var id = b.dataset.id, act = b.dataset.act, body = {};
          if (act === 'paid') {
            var ref = prompt('Payout reference (required — e.g. JazzCash/Easypaisa transaction ID or bank reference):');
            if (!ref || !ref.trim()) { show($('withdrawalsError'), 'Mark-paid cancelled: payout_reference is required. Do not mark a withdrawal paid without a real payout.', true); return; }
            body = { payout_reference: ref.trim() };
          }
          if (act === 'reject') {
            var reason = prompt('Rejection reason (shown to the user):') || '';
            // Backend stores admin_note; reason is also sent for forward compatibility.
            body = { reason: reason, admin_note: reason };
          }
          var path = act === 'paid' ? 'mark-paid' : act;
          try {
            await api('/api/admin/withdrawals/' + encodeURIComponent(id) + '/' + path, { method: 'POST', body: body });
            if (act === 'reject') show($('withdrawalsError'), 'Rejected. The server is responsible for refunding the coins — this panel does not invent a refund.');
            loadWithdrawals();
          } catch (err) { show($('withdrawalsError'), err.message, true); }
        });
      });
    } catch (err) { $('withdrawalsBody').innerHTML = ''; show($('withdrawalsError'), err.message, true); }
  }
  $('refreshWithdrawals').addEventListener('click', loadWithdrawals);

  // ---------- Generic list sections ----------
  async function loadList(path, bodyId, errId, render) {
    if (!requireAuth()) return;
    show($(errId), 'Loading…');
    try {
      var d = await api(path);
      var list = listOf(d, ['data', 'items', 'transactions', 'events', 'tickets', 'users', 'ads']);
      if (!list && d && typeof d === 'object') { $(bodyId).innerHTML = '<tr><td colspan="6">Returned object (no list field): see raw below.</td></tr>'; }
      else if (!list) throw new Error(path + ' did not return a list.');
      else $(bodyId).innerHTML = list.length ? list.map(render).join('') : '<tr><td colspan="6">No records returned.</td></tr>';
      show($(errId), '');
      var raw = $(errId.replace('Error', 'Raw'));
      if (raw) raw.textContent = JSON.stringify(d, null, 2).slice(0, 4000);
    } catch (err) { $(bodyId).innerHTML = ''; show($(errId), err.message, true); }
  }
  function loadTransactions() {
    loadList('/api/admin/transactions', 'transactionsBody', 'transactionsError', function (t) {
      return '<tr><td>' + esc(t.id || t._id || '') + '</td><td>' + esc(pick(t, ['user_id', 'user', 'email'], '—')) + '</td>' +
        '<td>' + esc(t.type || t.kind || '—') + '</td><td>' + esc(pick(t, ['coins', 'amount_coins'], 0)) + '</td>' +
        '<td>' + money(pick(t, ['amount_pkr', 'amount'], 0)) + '</td><td>' + esc(t.status || '—') + '</td></tr>';
    });
  }
  function loadAds() {
    if (!requireAuth()) return;
    show($('adsError'), 'Loading…');
    Promise.allSettled([api('/api/admin/ads'), api('/api/config/public')]).then(function (r) {
      if (r[0].status === 'rejected') { $('adsBody').innerHTML = ''; show($('adsError'), r[0].reason.message, true); return; }
      var d = r[0].value, c = (r[1].status === 'fulfilled' ? (r[1].value.config || r[1].value.data || r[1].value) : {});
      $('adsConfig').textContent = 'Ad unit IDs (from config): ' + JSON.stringify({
        ad_app_id: c.ad_app_id, ad_rewarded_unit_id: c.ad_rewarded_unit_id,
        ad_banner_unit_id: c.ad_banner_unit_id,
        total_coins_awarded: d.total_coins_awarded
      }, null, 2) + '\nTest IDs must be replaced with real AdMob IDs before release — see docs/DEPLOYMENT.md.';
      // Actual backend shape: {config, events, total_coins_awarded}.
      var list = listOf(d, ['events', 'ad_events', 'data', 'items']);
      if (!list) { $('adsBody').innerHTML = ''; show($('adsError'), 'GET /api/admin/ads did not return an events list.'); return; }
      $('adsBody').innerHTML = list.length ? list.map(function (a) {
        return '<tr><td>' + esc(a.id || '') + '</td><td>' + esc(pick(a, ['user_id', 'user'], '—')) + '</td>' +
          '<td>' + esc(pick(a, ['network', 'event', 'type'], '—')) + '<br><span class="muted">' + esc(a.ad_event_id || '') + '</span></td>' +
          '<td>' + esc(pick(a, ['coins_awarded', 'coins', 'reward_coins'], 0)) + '</td>' +
          '<td>' + esc(a.date || a.created_at || '—') + '</td></tr>';
      }).join('') : '<tr><td colspan="5">No ad events returned.</td></tr>';
      show($('adsError'), '');
    });
  }
  function loadFraud() {
    loadList('/api/admin/fraud', 'fraudBody', 'fraudError', function (f) {
      return '<tr><td>' + esc(f.id || f.user_id || '') + '</td><td>' + esc(pick(f, ['user', 'email', 'user_id'], '—')) + '</td>' +
        '<td>' + esc(f.type || f.reason || '—') + '</td><td>' + esc(pick(f, ['detail', 'details', 'evidence'], '')) +
        '<br><span class="muted">' + esc(pick(f, ['ip', 'device_id'], '')) + '</span></td>' +
        '<td>' + esc(f.created_at || f.status || 'flagged') + '</td></tr>';
    });
  }
  function loadTickets() {
    if (!requireAuth()) return;
    show($('ticketsError'), 'Loading…');
    api('/api/admin/tickets').then(function (d) {
      var list = listOf(d, ['tickets', 'data', 'items']);
      if (!list) throw new Error('GET /api/admin/tickets did not return a ticket list.');
      $('ticketsBody').innerHTML = list.length ? list.map(function (t) {
        var id = t.id || t._id || '';
        return '<tr><td>' + esc(id) + '</td><td>' + esc(pick(t, ['user_id', 'user', 'email'], '—')) + '</td>' +
          '<td>' + esc(t.subject || t.title || '—') + '<br><span class="muted">' + esc(t.message || t.body || '') + '</span></td>' +
          '<td>' + esc(t.status || 'open') + '</td>' +
          '<td class="actions"><button class="secondary" data-id="' + esc(id) + '">Reply</button></td></tr>';
      }).join('') : '<tr><td colspan="5">No tickets returned.</td></tr>';
      show($('ticketsError'), '');
      $('ticketsBody').querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', async function () {
          var msg = prompt('Reply to ticket ' + b.dataset.id + ':');
          if (!msg || !msg.trim()) return;
          try { await api('/api/admin/tickets/' + encodeURIComponent(b.dataset.id) + '/reply', { method: 'POST', body: { message: msg.trim() } }); loadTickets(); }
          catch (err) { show($('ticketsError'), err.message, true); }
        });
      });
    }).catch(function (err) { $('ticketsBody').innerHTML = ''; show($('ticketsError'), err.message, true); });
  }
  $('refreshTransactions').addEventListener('click', loadTransactions);
  $('refreshAds').addEventListener('click', loadAds);
  $('refreshFraud').addEventListener('click', loadFraud);
  $('refreshTickets').addEventListener('click', loadTickets);

  if (state.token) { setLoggedIn(true); loadDashboard(); } else { setLoggedIn(false); }
})();
