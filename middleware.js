'use strict';
const jwt = require('jsonwebtoken');
const { prepare } = require('./db');

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing_token' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev-only-change-me');
    const user = prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
    if (!user) return res.status(401).json({ error: 'user_not_found' });
    if (user.is_banned) return res.status(403).json({ error: 'account_banned' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
  next();
}
module.exports = { auth, adminOnly };
