'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validateInvitationInput, validateBulkInvitationInput, isInteger } = require('../lib/validate');
const { generateToken, hashToken } = require('../lib/tokens');

// All invitation management routes require authentication and admin/coordinator role
router.use(requireAuth, requireRole('admin', 'coordinator'));

/**
 * GET /api/invitations
 * Filter and list invitations.
 */
router.get('/', async (req, res, next) => {
  try {
    const { competition_id, judge_id, status } = req.query;
    let limit = parseInt(req.query.limit, 10);
    let offset = parseInt(req.query.offset, 10);

    if (isNaN(limit) || limit < 1) limit = 50;
    if (limit > 100) limit = 100;
    if (isNaN(offset) || offset < 0) offset = 0;

    const whereClauses = [];
    const params = [];
    let paramIdx = 1;

    if (competition_id && isInteger(competition_id)) {
      params.push(competition_id);
      whereClauses.push(`ji.competition_id = $${paramIdx++}`);
    }

    if (judge_id && isInteger(judge_id)) {
      params.push(judge_id);
      whereClauses.push(`ji.judge_id = $${paramIdx++}`);
    }

    if (status && typeof status === 'string') {
      params.push(status);
      whereClauses.push(`ji.status = $${paramIdx++}`);
    }

    const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countResult = await db.query(
      `SELECT COUNT(*)::int AS total FROM judge_invitations ji ${whereSQL}`,
      params
    );
    const total = countResult.rows[0]?.total || 0;

    params.push(limit);
    const limitIdx = paramIdx++;
    params.push(offset);
    const offsetIdx = paramIdx++;

    const sql = `
      SELECT ji.id, ji.competition_id, ji.event_id, ji.judge_id, ji.status,
             ji.sent_at, ji.expires_at, ji.created_at, ji.updated_at,
             j.first_name, j.last_name, j.email, j.organization, j.kind,
             c.name AS competition_name, e.name AS event_name
      FROM judge_invitations ji
      JOIN judges j ON j.id = ji.judge_id
      JOIN competitions c ON c.id = ji.competition_id
      LEFT JOIN events e ON e.id = ji.event_id
      ${whereSQL}
      ORDER BY ji.created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const dataResult = await db.query(sql, params);

    res.json({
      invitations: dataResult.rows,
      total,
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/invitations
 * Create a single invitation (sent).
 */
router.post('/', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const validation = validateInvitationInput(req.body);
    if (!validation.isValid) {
      return res.status(400).json({ error: 'Validation failed', details: validation.errors });
    }

    const { judge_id, competition_id, expires_at } = req.body;

    await client.query('BEGIN');

    // Verify judge exists and is active
    const judgeRes = await client.query('SELECT * FROM judges WHERE id = $1', [judge_id]);
    if (judgeRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Judge not found' });
    }
    const judge = judgeRes.rows[0];
    if (judge.status === 'inactive' || judge.is_active === false) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot invite an inactive judge' });
    }

    // Verify competition exists
    const compRes = await client.query('SELECT id, event_id, name FROM competitions WHERE id = $1', [competition_id]);
    if (compRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Competition not found' });
    }
    const competition = compRes.rows[0];

    // Check for existing live invitation
    const liveCheck = await client.query(
      `SELECT id, status FROM judge_invitations
       WHERE judge_id = $1 AND competition_id = $2
         AND status IN ('sent','viewed','accepted','tentative','invited')`,
      [judge_id, competition_id]
    );
    if (liveCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Judge already has an active invitation for this competition',
        existingInvitationId: liveCheck.rows[0].id,
      });
    }

    // Expiry calculation: default 72 hours
    const expiryDate = expires_at ? new Date(expires_at) : new Date(Date.now() + 72 * 60 * 60 * 1000);

    // Generate token
    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);

    // Insert judge_invitations
    const invRes = await client.query(
      `INSERT INTO judge_invitations (
        judge_id, competition_id, event_id, invitation_token, status, sent_at, expires_at
      ) VALUES ($1, $2, $3, $4, 'sent', NOW(), $5)
      RETURNING *`,
      [judge_id, competition_id, competition.event_id, tokenHash, expiryDate]
    );
    const invitation = invRes.rows[0];

    // Insert auth_tokens
    await client.query(
      `INSERT INTO auth_tokens (
        judge_id, invitation_id, token_hash, purpose, expires_at
      ) VALUES ($1, $2, $3, 'invitation', $4)`,
      [judge_id, invitation.id, tokenHash, expiryDate]
    );

    // Produce outbox row
    const idempotencyKey = `invite_${invitation.id}_${tokenHash.substring(0, 16)}`;
    const magicLinkUrl = `/j/${rawToken}`;

    await client.query(
      `INSERT INTO notification_outbox (
        recipient_email, to_email, recipient_name, channel, subject, body,
        payload, template, idempotency_key, status
      ) VALUES ($1, $2, $3, 'email', $4, $5, $6, 'judge_invitation', $7, 'pending')`,
      [
        judge.email,
        judge.email,
        `${judge.first_name} ${judge.last_name}`,
        `Invitation to judge: ${competition.name}`,
        `Dear ${judge.first_name}, you have been invited to evaluate at ${competition.name}. Use your magic link: ${magicLinkUrl}`,
        JSON.stringify({
          invitation_id: invitation.id,
          judge_id: judge.id,
          competition_id: competition.id,
          competition_name: competition.name,
          magic_link: magicLinkUrl,
          expires_at: expiryDate.toISOString(),
        }),
        idempotencyKey,
      ]
    );

    await client.query('COMMIT');

    const response = {
      invitation,
    };

    // STRICT SECURITY: Expose magic link in response ONLY during development / test
    if (process.env.NODE_ENV !== 'production') {
      response.magicLinkUrl = magicLinkUrl;
      response.rawToken = rawToken;
    }

    res.status(201).json(response);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Judge already has an active invitation for this competition' });
    }
    next(err);
  } finally {
    client.release();
  }
});

/**
 * POST /api/invitations/bulk
 * Send batch invitations with automatic skip for existing live invitations.
 */
router.post('/bulk', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const validation = validateBulkInvitationInput(req.body);
    if (!validation.isValid) {
      return res.status(400).json({ error: 'Validation failed', details: validation.errors });
    }

    const { judge_ids, competition_id, deadline_hours } = req.body;
    const hours = deadline_hours ? Number(deadline_hours) : 72;
    const expiryDate = new Date(Date.now() + hours * 60 * 60 * 1000);

    await client.query('BEGIN');

    // Check competition
    const compRes = await client.query('SELECT id, event_id, name FROM competitions WHERE id = $1', [competition_id]);
    if (compRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Competition not found' });
    }
    const competition = compRes.rows[0];

    // Query all requested judges
    const judgesRes = await client.query('SELECT * FROM judges WHERE id = ANY($1)', [judge_ids]);
    const judgesMap = new Map(judgesRes.rows.map((j) => [Number(j.id), j]));

    // Query judges with existing live invitations for this competition
    const liveInvitesRes = await client.query(
      `SELECT judge_id FROM judge_invitations
       WHERE competition_id = $1 AND judge_id = ANY($2)
         AND status IN ('sent','viewed','accepted','tentative','invited')`,
      [competition_id, judge_ids]
    );
    const liveJudgeIds = new Set(liveInvitesRes.rows.map((r) => Number(r.judge_id)));

    const created = [];
    const skipped = [];

    for (const rawId of judge_ids) {
      const judgeId = Number(rawId);
      const judge = judgesMap.get(judgeId);

      if (!judge) {
        skipped.push({ judge_id: judgeId, reason: 'Judge not found' });
        continue;
      }

      if (judge.status === 'inactive' || judge.is_active === false) {
        skipped.push({ judge_id: judgeId, reason: 'Judge is inactive' });
        continue;
      }

      if (liveJudgeIds.has(judgeId)) {
        skipped.push({ judge_id: judgeId, reason: 'Judge already has an active invitation' });
        continue;
      }

      // Generate credentials
      const rawToken = generateToken();
      const tokenHash = hashToken(rawToken);

      // Insert invitation
      const invRes = await client.query(
        `INSERT INTO judge_invitations (
          judge_id, competition_id, event_id, invitation_token, status, sent_at, expires_at
        ) VALUES ($1, $2, $3, $4, 'sent', NOW(), $5)
        RETURNING *`,
        [judgeId, competition_id, competition.event_id, tokenHash, expiryDate]
      );
      const invitation = invRes.rows[0];

      // Insert auth token
      await client.query(
        `INSERT INTO auth_tokens (
          judge_id, invitation_id, token_hash, purpose, expires_at
        ) VALUES ($1, $2, $3, 'invitation', $4)`,
        [judgeId, invitation.id, tokenHash, expiryDate]
      );

      const idempotencyKey = `invite_${invitation.id}_${tokenHash.substring(0, 16)}`;
      const magicLinkUrl = `/j/${rawToken}`;

      // Insert outbox row
      await client.query(
        `INSERT INTO notification_outbox (
          recipient_email, to_email, recipient_name, channel, subject, body,
          payload, template, idempotency_key, status
        ) VALUES ($1, $2, $3, 'email', $4, $5, $6, 'judge_invitation', $7, 'pending')`,
        [
          judge.email,
          judge.email,
          `${judge.first_name} ${judge.last_name}`,
          `Invitation to judge: ${competition.name}`,
          `Dear ${judge.first_name}, you have been invited to evaluate at ${competition.name}. Link: ${magicLinkUrl}`,
          JSON.stringify({
            invitation_id: invitation.id,
            judge_id: judge.id,
            competition_id: competition.id,
            competition_name: competition.name,
            magic_link: magicLinkUrl,
            expires_at: expiryDate.toISOString(),
          }),
          idempotencyKey,
        ]
      );

      // Track created record
      const item = {
        invitation_id: invitation.id,
        judge_id: judgeId,
        judge_name: `${judge.first_name} ${judge.last_name}`,
        email: judge.email,
      };
      if (process.env.NODE_ENV !== 'production') {
        item.magicLinkUrl = magicLinkUrl;
        item.rawToken = rawToken;
      }
      created.push(item);
    }

    await client.query('COMMIT');

    res.status(201).json({
      message: `Processed ${judge_ids.length} invitations`,
      created_count: created.length,
      skipped_count: skipped.length,
      created,
      skipped,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

/**
 * POST /api/invitations/:id/resend
 * Resend invitation with a newly generated magic link.
 */
router.post('/:id/resend', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { id } = req.params;
    if (!isInteger(id)) {
      return res.status(400).json({ error: 'Invalid invitation ID' });
    }

    await client.query('BEGIN');

    const invRes = await client.query(
      `SELECT ji.*, j.first_name, j.last_name, j.email, c.name AS competition_name
       FROM judge_invitations ji
       JOIN judges j ON j.id = ji.judge_id
       JOIN competitions c ON c.id = ji.competition_id
       WHERE ji.id = $1`,
      [id]
    );

    if (invRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Invitation not found' });
    }

    const invitation = invRes.rows[0];
    if (['accepted', 'declined', 'cancelled'].includes(invitation.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Cannot resend invitation with status '${invitation.status}'`,
      });
    }

    // Invalidate previous active tokens for this invitation
    await client.query(
      'UPDATE auth_tokens SET expires_at = NOW() WHERE invitation_id = $1 AND expires_at > NOW()',
      [id]
    );

    // Generate fresh credentials (72h extension)
    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
    const newExpiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);

    // Add new auth token
    await client.query(
      `INSERT INTO auth_tokens (
        judge_id, invitation_id, token_hash, purpose, expires_at
      ) VALUES ($1, $2, $3, 'invitation', $4)`,
      [invitation.judge_id, id, tokenHash, newExpiresAt]
    );

    // Update invitation sent_at, expires_at, and invitation_token
    const updatedInv = await client.query(
      `UPDATE judge_invitations
       SET invitation_token = $1, sent_at = NOW(), expires_at = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [tokenHash, newExpiresAt, id]
    );

    const magicLinkUrl = `/j/${rawToken}`;
    const idempotencyKey = `resend_${id}_${Date.now()}`;

    // Produce outbox notification
    await client.query(
      `INSERT INTO notification_outbox (
        recipient_email, to_email, recipient_name, channel, subject, body,
        payload, template, idempotency_key, status
      ) VALUES ($1, $2, $3, 'email', $4, $5, $6, 'judge_invitation_reminder', $7, 'pending')`,
      [
        invitation.email,
        invitation.email,
        `${invitation.first_name} ${invitation.last_name}`,
        `Reminder: Invitation to judge: ${invitation.competition_name}`,
        `Dear ${invitation.first_name}, here is your updated link: ${magicLinkUrl}`,
        JSON.stringify({
          invitation_id: id,
          judge_id: invitation.judge_id,
          competition_id: invitation.competition_id,
          competition_name: invitation.competition_name,
          magic_link: magicLinkUrl,
          expires_at: newExpiresAt.toISOString(),
        }),
        idempotencyKey,
      ]
    );

    await client.query('COMMIT');

    const response = {
      message: 'Invitation resent successfully',
      invitation: updatedInv.rows[0],
    };

    if (process.env.NODE_ENV !== 'production') {
      response.magicLinkUrl = magicLinkUrl;
      response.rawToken = rawToken;
    }

    res.json(response);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

/**
 * POST /api/invitations/:id/cancel
 * Cancel an outstanding invitation.
 */
router.post('/:id/cancel', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { id } = req.params;
    if (!isInteger(id)) {
      return res.status(400).json({ error: 'Invalid invitation ID' });
    }

    await client.query('BEGIN');

    const invRes = await client.query('SELECT id, status FROM judge_invitations WHERE id = $1', [id]);
    if (invRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Invitation not found' });
    }

    const invitation = invRes.rows[0];
    if (['accepted', 'declined'].includes(invitation.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Cannot cancel an invitation that has already been ${invitation.status}`,
      });
    }

    // Cancel invitation
    const updateRes = await client.query(
      `UPDATE judge_invitations
       SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    // Invalidate active auth tokens
    await client.query(
      'UPDATE auth_tokens SET expires_at = NOW() WHERE invitation_id = $1 AND expires_at > NOW()',
      [id]
    );

    await client.query('COMMIT');

    res.json({
      message: 'Invitation cancelled successfully',
      invitation: updateRes.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
