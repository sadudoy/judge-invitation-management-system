-- Migration 007: Phase 4 Dashboard Materialized Views & Refresh Triggers
-- CSE Fest - Judge Invitation & Assignment Management System

-- 1. Materialized View: mv_session_coverage
DROP MATERIALIZED VIEW IF EXISTS mv_session_coverage CASCADE;
CREATE MATERIALIZED VIEW mv_session_coverage AS
SELECT
  s.id AS session_id,
  s.name AS session_name,
  s.competition_id,
  c.name AS competition_name,
  s.start_time,
  s.end_time,
  s.status AS session_status,
  c.min_judges AS required_judges,
  COUNT(CASE WHEN ja.status = 'confirmed' THEN 1 END)::int AS confirmed_count,
  COUNT(CASE WHEN ja.status <> 'cancelled' THEN 1 END)::int AS total_assigned,
  COALESCE(BOOL_OR(ja.role = 'head_judge' AND ja.status IN ('confirmed', 'held', 'assigned')), false) AS has_head,
  GREATEST(0, c.min_judges - COUNT(CASE WHEN ja.status = 'confirmed' THEN 1 END)::int) AS missing,
  CASE
    WHEN COUNT(CASE WHEN ja.status = 'confirmed' THEN 1 END)::int < c.min_judges THEN 'understaffed'
    WHEN c.max_judges IS NOT NULL AND COUNT(CASE WHEN ja.status = 'confirmed' THEN 1 END)::int > c.max_judges THEN 'overstaffed'
    ELSE 'covered'
  END AS status
FROM sessions s
JOIN competitions c ON c.id = s.competition_id
LEFT JOIN judge_assignments ja ON ja.session_id = s.id AND ja.status <> 'cancelled'
GROUP BY s.id, s.name, s.competition_id, c.name, s.start_time, s.end_time, s.status, c.min_judges, c.max_judges;

CREATE UNIQUE INDEX idx_mv_session_coverage_session_id ON mv_session_coverage (session_id);

-- 2. Materialized View: mv_judge_workload
DROP MATERIALIZED VIEW IF EXISTS mv_judge_workload CASCADE;
CREATE MATERIALIZED VIEW mv_judge_workload AS
SELECT
  j.id AS judge_id,
  (j.first_name || ' ' || j.last_name) AS full_name,
  j.email,
  j.organization,
  j.kind,
  COUNT(CASE WHEN ja.status = 'confirmed' THEN 1 END)::int AS confirmed_count,
  COUNT(CASE WHEN ja.status = 'held' THEN 1 END)::int AS held_count,
  COUNT(CASE WHEN ja.status = 'assigned' THEN 1 END)::int AS assigned_count,
  COUNT(CASE WHEN ja.status <> 'cancelled' THEN 1 END)::int AS total_assignments,
  COALESCE(
    ROUND(
      (COUNT(CASE WHEN aa.status = 'absent' OR aa.status = 'not_arrived' THEN 1 END)::numeric /
       NULLIF(COUNT(CASE WHEN aa.status IS NOT NULL THEN 1 END), 0)::numeric) * 100,
      1
    ),
    0.0
  )::float AS no_show_rate,
  MAX(s.start_time) AS last_assignment_at
FROM judges j
LEFT JOIN judge_assignments ja ON ja.judge_id = j.id AND ja.status <> 'cancelled'
LEFT JOIN sessions s ON s.id = ja.session_id
LEFT JOIN assignment_attendance aa ON aa.assignment_id = ja.id
WHERE j.is_active = true
GROUP BY j.id, j.first_name, j.last_name, j.email, j.organization, j.kind;

CREATE UNIQUE INDEX idx_mv_judge_workload_judge_id ON mv_judge_workload (judge_id);

-- 3. Control table for debounce tracking (in _control schema to preserve 19 public tables invariant)
CREATE SCHEMA IF NOT EXISTS _control;
CREATE TABLE IF NOT EXISTS _control.mv_refresh_log (
  id INT PRIMARY KEY,
  last_refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO _control.mv_refresh_log (id, last_refreshed_at)
VALUES (1, '1970-01-01 00:00:00Z')
ON CONFLICT (id) DO NOTHING;

-- 4. Debounced refresh function (max once per 30 seconds)
CREATE OR REPLACE FUNCTION refresh_mv_dashboard()
RETURNS trigger AS $$
DECLARE
  v_last TIMESTAMPTZ;
BEGIN
  SELECT last_refreshed_at INTO v_last
  FROM _control.mv_refresh_log
  WHERE id = 1
  FOR UPDATE;

  IF v_last IS NULL OR (NOW() - v_last) >= INTERVAL '30 seconds' THEN
    UPDATE _control.mv_refresh_log
    SET last_refreshed_at = NOW()
    WHERE id = 1;

    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_session_coverage;
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_judge_workload;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 5. Explicit force refresh function (bypasses debounce window for on-demand sync)
CREATE OR REPLACE FUNCTION refresh_mv_dashboard_force()
RETURNS void AS $$
BEGIN
  UPDATE _control.mv_refresh_log
  SET last_refreshed_at = NOW()
  WHERE id = 1;

  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_session_coverage;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_judge_workload;
END;
$$ LANGUAGE plpgsql;

-- 6. Statement-level triggers on assignments and attendance
DROP TRIGGER IF EXISTS trg_refresh_mv_assignments ON judge_assignments;
CREATE TRIGGER trg_refresh_mv_assignments
AFTER INSERT OR UPDATE ON judge_assignments
FOR EACH STATEMENT
EXECUTE FUNCTION refresh_mv_dashboard();

DROP TRIGGER IF EXISTS trg_refresh_mv_attendance ON assignment_attendance;
CREATE TRIGGER trg_refresh_mv_attendance
AFTER UPDATE ON assignment_attendance
FOR EACH STATEMENT
EXECUTE FUNCTION refresh_mv_dashboard();

-- 7. Permissions
GRANT SELECT ON mv_session_coverage TO csefest_app;
GRANT SELECT ON mv_judge_workload TO csefest_app;
GRANT ALL ON SCHEMA _control TO csefest_app;
GRANT ALL ON TABLE _control.mv_refresh_log TO csefest_app;
