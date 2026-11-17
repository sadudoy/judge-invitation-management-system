'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const result = await db.query(
      `SELECT id, email, password_hash, full_name, role, is_active
       FROM users
       WHERE LOWER(email) = $1
       LIMIT 1;`,
      [trimmedEmail]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is deactivated' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Regenerate session to protect against session fixation attacks
    req.session.regenerate((err) => {
      if (err) {
        return next(err);
      }

      req.session.user = {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
      };

      req.session.save((saveErr) => {
        if (saveErr) {
          return next(saveErr);
        }
        return res.status(200).json({
          message: 'Login successful',
          user: req.session.user,
        });
      });
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res, next) => {
  if (req.session) {
    req.session.destroy((err) => {
      if (err) {
        return next(err);
      }
      res.clearCookie('connect.sid');
      return res.status(200).json({ message: 'Logged out successfully' });
    });
  } else {
    return res.status(200).json({ message: 'Logged out successfully' });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  return res.status(200).json({
    user: req.session.user,
  });
});

// POST /api/auth/password
router.post('/password', requireAuth, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password || typeof current_password !== 'string' || typeof new_password !== 'string') {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }

    if (new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters long' });
    }

    const userId = req.session.user.id;
    const userRes = await db.query('SELECT id, password_hash FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const match = await bcrypt.compare(current_password, userRes.rows[0].password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const saltRounds = 12;
    const newHash = await bcrypt.hash(new_password, saltRounds);

    await db.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [newHash, userId]);

    // Record audit log
    await db.query(
      `INSERT INTO audit_log (table_name, record_id, action, actor_id, old_values, new_values)
       VALUES ('users', $1::bigint, 'UPDATE', $1::bigint, jsonb_build_object('user_id', $1::bigint), jsonb_build_object('action', 'password_changed'))`,
      [userId]
    );

    // Invalidate all active sessions for this user in PostgreSQL session store
    await db.query(
      `DELETE FROM session WHERE sess->'user'->>'id' = $1::text`,
      [String(userId)]
    );

    // Destroy current session and clear cookie
    if (req.session) {
      req.session.destroy(() => {
        res.clearCookie('connect.sid');
        return res.status(200).json({ message: 'Password updated successfully. Please log in again.' });
      });
    } else {
      res.clearCookie('connect.sid');
      return res.status(200).json({ message: 'Password updated successfully. Please log in again.' });
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
