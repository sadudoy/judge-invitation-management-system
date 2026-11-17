'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateIcs, formatUtc, sanitizeText } = require('../server/lib/ics');

test('ICS: formatUtc formats dates into RFC 5545 timestamp', () => {
  const date = new Date('2026-11-20T09:30:00.000Z');
  const formatted = formatUtc(date);
  assert.equal(formatted, '20261120T093000Z');
});

test('ICS: sanitizeText escapes and strips newline characters', () => {
  const dirty = 'Line 1\r\nLine 2; with semicolons, and commas\nLine 3';
  const clean = sanitizeText(dirty);
  assert.equal(dirty.includes('\n'), true);
  assert.equal(clean.includes('\n'), false);
  assert.equal(clean.includes('\r'), false);
  assert.ok(clean.includes('\\;'));
  assert.ok(clean.includes('\\,'));
});

test('ICS: generateIcs throws if startTime or endTime is missing', () => {
  assert.throws(() => generateIcs({}), /startTime and endTime are required/);
  assert.throws(() => generateIcs({ startTime: new Date() }), /startTime and endTime are required/);
});

test('ICS: generateIcs produces valid RFC 5545 iCalendar stream with Dhaka VTIMEZONE', () => {
  const start = new Date('2026-11-20T09:00:00+06:00');
  const end = new Date('2026-11-20T12:00:00+06:00');

  const ics = generateIcs({
    uid: 'session-101@csefest.org',
    startTime: start,
    endTime: end,
    summary: 'Hackathon Final Judging',
    description: 'Final round evaluations for CSE Fest Hackathon',
    location: 'Auditorium A',
    organizerName: 'CSE Fest Admin',
    organizerEmail: 'admin@csefest.edu',
    attendeeName: 'Dr. Jane Doe',
    attendeeEmail: 'jane.doe@university.edu',
  });

  const unfolded = ics.replace(/\r\n /g, '');
  assert.ok(unfolded.includes('BEGIN:VCALENDAR'));
  assert.ok(unfolded.includes('VERSION:2.0'));
  assert.ok(unfolded.includes('BEGIN:VTIMEZONE'));
  assert.ok(unfolded.includes('TZID:Asia/Dhaka'));
  assert.ok(unfolded.includes('BEGIN:VEVENT'));
  assert.ok(unfolded.includes('UID:session-101@csefest.org'));
  assert.ok(unfolded.includes('SUMMARY:Hackathon Final Judging'));
  assert.ok(unfolded.includes('ORGANIZER;CN=CSE Fest Admin:mailto:admin@csefest.edu'));
  assert.ok(unfolded.includes('ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Dr. Jane Doe:mailto:jane.doe@university.edu'));
  assert.ok(unfolded.includes('STATUS:CONFIRMED'));
  assert.ok(unfolded.includes('END:VEVENT'));
  assert.ok(unfolded.includes('END:VCALENDAR'));
  assert.ok(ics.endsWith('\r\n'));
});

test('ICS: generateIcs neutralizes CRLF injection attempts in judge name and summary', () => {
  const start = new Date('2026-11-20T09:00:00Z');
  const end = new Date('2026-11-20T11:00:00Z');

  const injectionName = 'Injected Judge\r\nATTENDEE:mailto:attacker@evil.com\r\n';
  const injectionSummary = 'Clean Session\r\nSTATUS:CANCELLED\r\n';

  const ics = generateIcs({
    uid: 'session-crlf@csefest.org',
    startTime: start,
    endTime: end,
    summary: injectionSummary,
    attendeeName: injectionName,
  });

  // Verify that CRLF injection did not create unauthorized top-level lines
  const lines = ics.split('\r\n');
  const cancelledLines = lines.filter((l) => l.trim() === 'STATUS:CANCELLED');
  assert.equal(cancelledLines.length, 0, 'STATUS:CANCELLED must not be injected as a distinct iCalendar statement');

  const attackerLines = lines.filter((l) => l.startsWith('ATTENDEE:mailto:attacker@evil.com'));
  assert.equal(attackerLines.length, 0, 'Injected attacker ATTENDEE must not appear as a distinct statement');
});
