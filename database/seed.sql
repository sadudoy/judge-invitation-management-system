-- Seed Data for CSE Fest - Judge Invitation & Assignment Management System
-- WARNING: FOR DEVELOPMENT / DEMO PURPOSES ONLY.
-- Do not run in production.

TRUNCATE TABLE
  assignment_attendance,
  assignment_responses,
  judge_assignments,
  judge_conflicts,
  judge_availability,
  invitation_responses,
  judge_invitations,
  auth_tokens,
  users,
  judges,
  sessions,
  competitions,
  venues,
  events,
  notification_deliveries,
  notification_outbox,
  audit_log
RESTART IDENTITY CASCADE;

-- 1 Event
INSERT INTO events (name, slug, description, start_date, end_date, status)
VALUES (
  'CSE Fest 2026',
  'cse-fest-2026',
  'Annual Computer Science & Engineering Festival featuring hackathons, programming contests, and project showcases.',
  '2026-11-20',
  '2026-11-22',
  'published'
);

-- 5 Venues
INSERT INTO venues (event_id, name, building, room, capacity)
VALUES
  (1, 'Main Auditorium', 'CSE Academic Block', 'Auditorium-101', 500),
  (1, 'Software Engineering Lab', 'CSE Academic Block', 'Lab-201', 80),
  (1, 'Network Systems Lab', 'CSE Academic Block', 'Lab-301', 60),
  (1, 'Seminar Hall A', 'Library Complex', 'SH-A', 150),
  (1, 'Conference Hall B', 'Administrative Building', 'CH-B', 100);

-- 5 Competitions
INSERT INTO competitions (event_id, name, slug, category, description, min_judges, max_judges)
VALUES
  (1, 'Inter-University Hackathon', 'hackathon', 'Software Development', '36-hour hackathon to build high-impact real-world solutions.', 2, 5),
  (1, 'Competitive Programming Contest', 'cp-contest', 'Algorithms & Problem Solving', 'ICPC-style team programming contest.', 2, 4),
  (1, 'Project Showcasing & Expo', 'project-expo', 'Hardware & IoT', 'Undergraduate project presentations and live demonstrations.', 2, 4),
  (1, 'Robotics Arena Clash', 'robotics-clash', 'Robotics & Automation', 'Autonomous and manual obstacle challenge for line-following and combat bots.', 2, 3),
  (1, 'AI & Data Science Challenge', 'ai-challenge', 'Machine Learning & AI', 'Predictive modeling, data analytics, and generative AI track.', 2, 4);

-- 5 Sessions
INSERT INTO sessions (competition_id, venue_id, name, start_time, end_time, buffer_minutes, status)
VALUES
  (1, 1, 'Hackathon Round 1 Evaluation', '2026-11-20 09:00:00+06', '2026-11-20 12:00:00+06', 15, 'scheduled'),
  (2, 2, 'CP Contest Final Round', '2026-11-20 14:00:00+06', '2026-11-20 17:00:00+06', 15, 'scheduled'),
  (3, 4, 'Project Expo Assessment', '2026-11-21 10:00:00+06', '2026-11-21 13:00:00+06', 20, 'scheduled'),
  (4, 5, 'Robotics Qualifying Matches', '2026-11-21 14:30:00+06', '2026-11-21 17:30:00+06', 15, 'scheduled'),
  (5, 3, 'AI Challenge Pitch & Demo', '2026-11-22 10:00:00+06', '2026-11-22 13:00:00+06', 15, 'scheduled');

-- 8 Judges
INSERT INTO judges (first_name, last_name, email, phone, organization, designation, expertise, bio, is_active)
VALUES
  ('Aminul', 'Islam', 'aminislam@university.edu', '+8801711000001', 'University of Engineering & Tech', 'Professor', ARRAY['Algorithms', 'Distributed Systems'], 'Senior professor with 20+ years of teaching and judging experience.', true),
  ('Nadia', 'Rahman', 'nadia.rahman@techcorp.com', '+8801711000002', 'TechCorp Labs', 'Principal AI Scientist', ARRAY['Machine Learning', 'Deep Learning', 'NLP'], 'Industry AI researcher focusing on LLMs and generative systems.', true),
  ('Tanvir', 'Ahmed', 'tanvir.ahmed@innovate.org', '+8801711000003', 'Innovate Solutions', 'Chief Architect', ARRAY['Cloud Architecture', 'Microservices', 'Security'], 'Cloud systems architect with expertise in large-scale backend design.', true),
  ('Farhana', 'Yasmin', 'farhana.y@devstudio.io', '+8801711000004', 'DevStudio', 'Engineering Director', ARRAY['Web Technologies', 'UI/UX', 'Scalability'], 'Frontend and engineering leader specializing in web platforms.', true),
  ('Kazi', 'Mostafa', 'k.mostafa@robotics.ac.bd', '+8801711000005', 'Robotics Institute', 'Associate Professor', ARRAY['Robotics', 'Embedded Systems', 'IoT'], 'Specialist in autonomous rovers and industrial automation.', true),
  ('Shamim', 'Reza', 'shamim.reza@fintechbd.com', '+8801711000006', 'FinTech BD', 'VP of Engineering', ARRAY['Fintech', 'Blockchain', 'Database Engines'], 'Experienced fintech engineer building resilient transaction networks.', true),
  ('Sadia', 'Afrin', 'sadia.afrin@researchcenter.org', '+8801711000007', 'National Research Center', 'Senior Research Fellow', ARRAY['Data Science', 'Computer Vision'], 'Researcher in medical imaging and edge AI processing.', true),
  ('Mahbubur', 'Rahman', 'mahbub@cybersec.net', '+8801711000008', 'CyberShield', 'Principal Security Consultant', ARRAY['Cybersecurity', 'Cryptography'], 'Information security auditor and CTF challenge designer.', true);

-- 3 Availability Rows
INSERT INTO judge_availability (judge_id, event_id, available_window, status, notes)
VALUES
  (1, 1, tstzrange('2026-11-20 08:00:00+06', '2026-11-20 18:00:00+06', '[)'), 'available', 'Available all day for CP and Hackathon.'),
  (2, 1, tstzrange('2026-11-20 12:00:00+06', '2026-11-21 18:00:00+06', '[)'), 'available', 'Available Friday afternoon and Saturday.'),
  (5, 1, tstzrange('2026-11-21 09:00:00+06', '2026-11-21 18:00:00+06', '[)'), 'available', 'Available Saturday for robotics track.');

-- 3 Conflict Rows (Immutable Audit-safe Conflict Declarations)
INSERT INTO judge_conflicts (judge_id, competition_id, student_name, institution, conflict_type, description)
VALUES
  (1, 1, 'Rafiqul Islam', 'Dhaka Tech', 'student_supervision', 'Direct MS thesis advisor to team lead.'),
  (2, 5, 'Tasnim Jahan', 'TechCorp Labs', 'co_author', 'Co-authored CVPR 2025 paper with participant.'),
  (5, 4, 'Alim Hossain', 'Robotics Institute', 'institutional', 'Affiliated with student home department.');

-- Mixed-State Invitations
INSERT INTO judge_invitations (event_id, judge_id, invitation_token, status, sent_at, expires_at)
VALUES
  (1, 1, 'inv-tok-111111111111', 'accepted', '2026-11-01 10:00:00+06', '2026-11-15 23:59:59+06'),
  (1, 2, 'inv-tok-222222222222', 'accepted', '2026-11-01 10:00:00+06', '2026-11-15 23:59:59+06'),
  (1, 3, 'inv-tok-333333333333', 'invited', '2026-11-02 11:00:00+06', '2026-11-16 23:59:59+06'),
  (1, 4, 'inv-tok-444444444444', 'draft', NULL, NULL),
  (1, 5, 'inv-tok-555555555555', 'declined', '2026-11-02 12:00:00+06', '2026-11-16 23:59:59+06'),
  (1, 6, 'inv-tok-666666666666', 'cancelled', '2026-11-03 14:00:00+06', '2026-11-17 23:59:59+06');
