'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { isInteger } = require('../lib/validate');

// Audit viewer is restricted strictly to Admins
router.use(requireAuth);
router.use(requireRole('admin'));

/**
 * GET /api/audit
 * Query params: table, actor, since, limit, offset
 */
router.get('/', async (req, res, next) => {
  try {
    const { table, actor, since, limit = '50', offset = '0' } = req.query;

    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const parsedOffset = Math.max(0, parseInt(offset, 10) || 0);

    const conditions = [];
    const values = [];

    if (table && typeof table === 'string' && table.trim().length > 0) {
      values.push(table.trim());
      conditions.push(`table_name = $${values.length}`);
    }

    if (actor && isInteger(actor)) {
      values.push(parseInt(actor, 10));
      conditions.push(`actor_id = $${values.length}`);
    }

    if (since && typeof since === 'string' && !isNaN(Date.parse(since))) {
      values.push(new Date(since).toISOString());
      conditions.push(`created_at >= $${values.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countSql = `SELECT COUNT(*)::int AS count FROM audit_log ${whereClause};`;
    const countRes = await db.query(countSql, values);
    const total = countRes.rows[0]?.count || 0;

    const dataSql = `
      SELECT a.id, a.table_name, a.record_id, a.action, a.actor_id, a.old_values, a.new_values, a.created_at,
             u.email AS actor_email, u.full_name AS actor_name
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.actor_id
      ${whereClause}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2};
    `;

    const dataRes = await db.query(dataSql, [...values, parsedLimit, parsedOffset]);

    res.json({
      entries: dataRes.rows,
      total,
      limit: parsedLimit,
      offset: parsedOffset,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
