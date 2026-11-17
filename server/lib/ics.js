'use strict';

/**
 * Format a Date object into RFC 5545 UTC timestamp: YYYYMMDDTHHMMSSZ
 */
function formatUtc(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}

/**
 * Clean text strings to avoid CRLF injection and escape special chars for iCalendar.
 */
function sanitizeText(str) {
  if (!str) return '';
  return String(str)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .trim();
}

/**
 * Fold lines longer than 75 bytes per RFC 5545 Section 3.1.
 */
function foldLine(line) {
  if (line.length <= 75) return line;
  const parts = [];
  let remaining = line;
  let first = true;
  while (remaining.length > 0) {
    const chunkLen = first ? 75 : 74;
    parts.push((first ? '' : ' ') + remaining.slice(0, chunkLen));
    remaining = remaining.slice(chunkLen);
    first = false;
  }
  return parts.join('\r\n');
}

/**
 * Generate RFC 5545 iCalendar content for an assignment event.
 *
 * @param {Object} options
 * @param {string|number} options.uid - Unique event identifier
 * @param {Date|string} options.startTime - Session start time
 * @param {Date|string} options.endTime - Session end time
 * @param {string} options.summary - Event title/summary
 * @param {string} [options.description] - Event description
 * @param {string} [options.location] - Venue/location
 * @param {string} [options.organizerName] - Organizer CN
 * @param {string} [options.organizerEmail] - Organizer Email
 * @param {string} [options.attendeeName] - Judge full name
 * @param {string} [options.attendeeEmail] - Judge email
 * @returns {string} CRLF-delimited iCalendar string
 */
function generateIcs(options = {}) {
  const {
    uid = `assignment-${Date.now()}@csefest.org`,
    startTime,
    endTime,
    summary = 'CSE Fest Judging Session',
    description = 'CSE Fest - Judge Invitation & Assignment Management System',
    location = 'CSE Department, Campus',
    organizerName = 'CSE Fest Organizing Committee',
    organizerEmail = 'csefest@example.com',
    attendeeName = 'Judge',
    attendeeEmail = 'judge@example.com',
  } = options;

  if (!startTime || !endTime) {
    throw new Error('startTime and endTime are required to generate ICS calendar event');
  }

  const dtstamp = formatUtc(new Date());
  const dtstart = formatUtc(startTime);
  const dtend = formatUtc(endTime);

  const cleanUid = sanitizeText(uid);
  const cleanSummary = sanitizeText(summary);
  const cleanDescription = sanitizeText(description);
  const cleanLocation = sanitizeText(location);
  const cleanOrgName = sanitizeText(organizerName);
  const cleanOrgEmail = sanitizeText(organizerEmail);
  const cleanAttName = sanitizeText(attendeeName);
  const cleanAttEmail = sanitizeText(attendeeEmail);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CSE Fest//Judge Assignment Management System//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Dhaka',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0600',
    'TZOFFSETTO:+0600',
    'TZNAME:BST',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    `UID:${cleanUid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${dtstart}`,
    `DTEND:${dtend}`,
    `SUMMARY:${cleanSummary}`,
    `DESCRIPTION:${cleanDescription}`,
    `LOCATION:${cleanLocation}`,
    `ORGANIZER;CN=${cleanOrgName}:mailto:${cleanOrgEmail}`,
    `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=${cleanAttName}:mailto:${cleanAttEmail}`,
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  return lines.map(foldLine).join('\r\n') + '\r\n';
}

module.exports = {
  generateIcs,
  formatUtc,
  sanitizeText,
};
