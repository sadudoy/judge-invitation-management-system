'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

/**
 * GET /api/competitions
 * List competitions with event metadata.
 */
router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(`
      SELECT c.id, c.event_id, c.name, c.slug, c.category, c.description,
             c.min_judges, c.max_judges, e.name AS event_name
      FROM competitions c
      LEFT JOIN events e ON e.id = c.event_id
      ORDER BY c.name ASC
    `);
    res.json({ competitions: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/competitions/:id/sessions
 * List sessions for a competition.
 */
router.get('/:id/sessions', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT s.*, v.name AS venue_name
       FROM sessions s
       LEFT JOIN venues v ON v.id = s.venue_id
       WHERE s.competition_id = $1
       ORDER BY s.start_time ASC`,
      [id]
    );
    res.json({ sessions: result.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
