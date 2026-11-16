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

module.exports = router;
