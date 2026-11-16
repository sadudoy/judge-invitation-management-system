'use strict';

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Unauthorized: login required' });
  }
  next();
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ error: 'Unauthorized: login required' });
    }
    if (!allowedRoles.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
    }
    next();
  };
}

module.exports = {
  requireAuth,
  requireRole,
};
