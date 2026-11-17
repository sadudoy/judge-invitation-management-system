'use strict';

// Extract token from URL /j/:token
const pathSegments = window.location.pathname.split('/');
const token = pathSegments[pathSegments.length - 1];

// DOM Elements
const invitationHeading = document.getElementById('invitation-heading');
const invitationIntro = document.getElementById('invitation-intro');
const statusBadge = document.getElementById('invitation-status-badge');
const portalAlert = document.getElementById('portal-alert');
const rsvpActiveContainer = document.getElementById('rsvp-active-container');
const rsvpConfirmedMessage = document.getElementById('rsvp-confirmed-message');
const confirmedResponseText = document.getElementById('confirmed-response-text');
const rsvpNotes = document.getElementById('rsvp-notes');

const btnAccept = document.getElementById('btn-accept');
const btnTentative = document.getElementById('btn-tentative');
const btnDecline = document.getElementById('btn-decline');

const slotsContainer = document.getElementById('slots-container');
const addSlotBtn = document.getElementById('add-slot-btn');
const saveAvailabilityBtn = document.getElementById('save-availability-btn');

const coiContainer = document.getElementById('coi-container');
const addCoiBtn = document.getElementById('add-coi-btn');
const saveCoiBtn = document.getElementById('save-coi-btn');

let portalData = null;

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showAlert(message, type = 'error') {
  portalAlert.textContent = message;
  portalAlert.className = `alert ${type === 'error' ? 'alert-error' : 'alert-success'}`;
  portalAlert.style.display = 'block';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function clearAlert() {
  portalAlert.style.display = 'none';
}

async function loadPortal() {
  try {
    const res = await fetch(`/api/j/${token}`);
    if (!res.ok) {
      const err = await res.json();
      showAlert(err.error || 'Unable to load invitation details');
      return;
    }

    portalData = await res.json();
    renderPortal();

    // Idempotently mark viewed
    if (portalData.invitation.status === 'sent') {
      fetch(`/api/j/${token}/view`, { method: 'POST' }).catch(() => {});
    }
  } catch (err) {
    showAlert('Network error connecting to invitation service');
  }
}

function renderPortal() {
  const { judge, competition, event, invitation, availability, conflicts } = portalData;

  invitationHeading.textContent = `Invitation to Judge ${competition.name}`;
  invitationIntro.innerHTML = `
    Dear <strong>${escapeHtml(judge.first_name)} ${escapeHtml(judge.last_name)}</strong> (${escapeHtml(judge.organization || 'Evaluator')}),<br>
    You are invited by the CSE Fest organizing committee to serve on the evaluation panel for <strong>${escapeHtml(competition.name)}</strong>.
    ${competition.description ? `<br><span style="margin-top: 6px; display: inline-block;">${escapeHtml(competition.description)}</span>` : ''}
  `;

  renderStatusBadge(invitation.status);

  // If already responded
  if (['accepted', 'declined', 'tentative'].includes(invitation.status) || invitation.is_used) {
    rsvpActiveContainer.style.display = 'none';
    confirmedResponseText.textContent = invitation.status.toUpperCase();
    rsvpConfirmedMessage.style.display = 'block';
  }

  // Pre-fill existing availability if present
  slotsContainer.innerHTML = '';
  if (availability && availability.length > 0) {
    availability.forEach((slot) => {
      // Parse window if possible
      addSlotRow(slot);
    });
  } else {
    // Add default row
    addSlotRow();
  }

  // Pre-fill existing conflicts if present
  coiContainer.innerHTML = '';
  if (conflicts && conflicts.length > 0) {
    conflicts.forEach((c) => {
      addCoiRow(c);
    });
  }

  // Phase 3: Render Assignments & Check-in / Checkout
  renderAssignments(portalData.assignments);
}

function renderAssignments(assignments) {
  const section = document.getElementById('assignments-section');
  const list = document.getElementById('judge-assignments-list');
  if (!section || !list) return;

  if (!assignments || assignments.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  list.innerHTML = '';

  assignments.forEach((a) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.cssText = 'padding: 16px; margin-bottom: 16px; border: 1px solid var(--border-color); border-radius: 8px;';

    const attStatus = a.attendance_status || 'not_arrived';
    const startTimeStr = new Date(a.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const endTimeStr = new Date(a.end_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const reportTimeStr = a.reporting_at ? new Date(a.reporting_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-';

    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 8px; margin-bottom: 8px;">
        <div>
          <h4 style="font-size: 1.05rem; margin-bottom: 2px;">${escapeHtml(a.session_name)}</h4>
          <span class="text-muted" style="font-size: 0.85rem;">${escapeHtml(a.competition_name || '')} &bull; Venue: ${escapeHtml(a.venue_name || 'Main Hall')}</span>
        </div>
        <div style="display: flex; gap: 6px;">
          <span class="badge badge-role">${escapeHtml(a.role)}</span>
          <span class="badge badge-${a.status}">${escapeHtml(a.status)}</span>
        </div>
      </div>

      <div style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 12px;">
        <div><strong>Session Time:</strong> ${startTimeStr} – ${endTimeStr}</div>
        <div><strong>Reporting Time:</strong> ${reportTimeStr} (Grace: ${a.grace_minutes || 15} mins)</div>
        <div><strong>Current Attendance:</strong> <span class="badge att-${attStatus}">${escapeHtml(attStatus.replace('_', ' '))}</span> ${a.minutes_late > 0 ? `(+${a.minutes_late}m late)` : ''}</div>
      </div>

      <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
        ${
          ['held', 'assigned'].includes(a.status)
            ? `
              <button type="button" class="btn btn-primary btn-sm btn-assign-accept" data-id="${a.id}">
                &check; Confirm Assignment
              </button>
              <button type="button" class="btn btn-danger btn-sm btn-assign-decline" data-id="${a.id}">
                &times; Decline Assignment
              </button>
            `
            : ''
        }
        ${
          a.status === 'confirmed'
            ? `
              <button type="button" class="btn btn-primary btn-sm btn-checkin" data-id="${a.id}" ${attStatus === 'checked_in' || attStatus === 'late' ? 'disabled' : ''}>
                &check; Check In Now
              </button>
              <button type="button" class="btn btn-secondary btn-sm btn-checkout" data-id="${a.id}">
                Check Out
              </button>
            `
            : ''
        }
      </div>
    `;

    list.appendChild(card);
  });

  // Attach handlers
  list.querySelectorAll('.btn-assign-accept').forEach((btn) => {
    btn.addEventListener('click', () => submitAssignmentResponse(btn.getAttribute('data-id'), 'accepted'));
  });

  list.querySelectorAll('.btn-assign-decline').forEach((btn) => {
    btn.addEventListener('click', () => {
      const reason = prompt('Please enter a brief reason for declining this judging assignment:');
      if (reason !== null) {
        submitAssignmentResponse(btn.getAttribute('data-id'), 'declined', reason);
      }
    });
  });

  list.querySelectorAll('.btn-checkin').forEach((btn) => {
    btn.addEventListener('click', () => submitCheckin(btn.getAttribute('data-id')));
  });

  list.querySelectorAll('.btn-checkout').forEach((btn) => {
    btn.addEventListener('click', () => submitCheckout(btn.getAttribute('data-id')));
  });
}

async function submitAssignmentResponse(assignmentId, response, reason = '') {
  clearAlert();
  try {
    const res = await fetch(`/api/j/${token}/assignment/${assignmentId}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response, reason }),
    });

    const data = await res.json();
    if (!res.ok) {
      showAlert(data.error || 'Failed to record assignment response');
      return;
    }

    showAlert(`Assignment response recorded: ${data.status.toUpperCase()}`, 'success');
    await loadPortal();
  } catch (err) {
    showAlert('Network error recording assignment response');
  }
}

async function submitCheckin(assignmentId) {
  clearAlert();
  try {
    const res = await fetch(`/api/j/${token}/checkin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignment_id: Number(assignmentId) }),
    });

    const data = await res.json();
    if (!res.ok) {
      showAlert(data.error || 'Failed to check in');
      return;
    }

    const lateMsg = data.minutes_late > 0 ? ` (Recorded late by ${data.minutes_late} min)` : ' (On Time)';
    showAlert(`Check-in successful: ${data.status.toUpperCase()}${lateMsg}`, 'success');
    await loadPortal();
  } catch (err) {
    showAlert('Network error during check-in');
  }
}

async function submitCheckout(assignmentId) {
  clearAlert();
  try {
    const res = await fetch(`/api/j/${token}/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignment_id: Number(assignmentId) }),
    });

    const data = await res.json();
    if (!res.ok) {
      showAlert(data.error || 'Failed to check out');
      return;
    }

    const earlyMsg = data.early_departure ? ' (Early Departure recorded)' : '';
    showAlert(`Checkout successful: ${data.status.toUpperCase()}${earlyMsg}`, 'success');
    await loadPortal();
  } catch (err) {
    showAlert('Network error during checkout');
  }
}

function renderStatusBadge(status) {
  statusBadge.innerHTML = `<span class="badge badge-status badge-status-${status}" style="font-size: 0.85rem; padding: 4px 10px;">${status}</span>`;
}

// RSVP Submission
async function submitRsvp(responseType) {
  clearAlert();
  const note = rsvpNotes.value.trim();

  try {
    const res = await fetch(`/api/j/${token}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: responseType, note }),
    });

    const data = await res.json();
    if (!res.ok) {
      showAlert(data.error || 'Failed to record response');
      return;
    }

    showAlert(`Thank you! Your response (${responseType}) has been confirmed.`, 'success');
    renderStatusBadge(responseType);
    rsvpActiveContainer.style.display = 'none';
    confirmedResponseText.textContent = responseType.toUpperCase();
    rsvpConfirmedMessage.style.display = 'block';
  } catch (err) {
    showAlert('Network error recording response');
  }
}

btnAccept.addEventListener('click', () => submitRsvp('accepted'));
btnTentative.addEventListener('click', () => submitRsvp('tentative'));
btnDecline.addEventListener('click', () => submitRsvp('declined'));

// Availability Handling
function addSlotRow(existing = null) {
  const currentSlots = document.querySelectorAll('.slot-entry').length;
  if (currentSlots >= 10) {
    alert('Maximum 10 availability windows allowed.');
    return;
  }

  const row = document.createElement('div');
  row.className = 'slot-entry';

  // Format existing dates if provided
  let startVal = '';
  let endVal = '';
  if (existing && existing.available_window) {
    // e.g. "[2026-11-20 09:00:00+00,2026-11-20 17:00:00+00]"
    const match = existing.available_window.match(/\["?(.*?)"?,/);
    const matchEnd = existing.available_window.match(/,"?(.*?)"?[\]\)]/);
    if (match && match[1]) {
      const d1 = new Date(match[1]);
      if (!isNaN(d1)) startVal = new Date(d1.getTime() - d1.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }
    if (matchEnd && matchEnd[1]) {
      const d2 = new Date(matchEnd[1]);
      if (!isNaN(d2)) endVal = new Date(d2.getTime() - d2.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }
  }

  row.innerHTML = `
    <div>
      <label style="font-size: 0.75rem; margin-bottom: 2px;">Start Time *</label>
      <input type="datetime-local" class="slot-start" value="${startVal}" required style="width: 100%; padding: 6px; font-size: 0.8rem; border: 1px solid var(--border-color); border-radius: 4px;">
    </div>
    <div>
      <label style="font-size: 0.75rem; margin-bottom: 2px;">End Time *</label>
      <input type="datetime-local" class="slot-end" value="${endVal}" required style="width: 100%; padding: 6px; font-size: 0.8rem; border: 1px solid var(--border-color); border-radius: 4px;">
    </div>
    <div>
      <label style="font-size: 0.75rem; margin-bottom: 2px;">&nbsp;</label>
      <button type="button" class="btn btn-secondary btn-sm" onclick="this.closest('.slot-entry').remove()">&times;</button>
    </div>
  `;

  slotsContainer.appendChild(row);
}

addSlotBtn.addEventListener('click', () => addSlotRow());

saveAvailabilityBtn.addEventListener('click', async () => {
  clearAlert();
  const rows = document.querySelectorAll('.slot-entry');
  const slots = [];

  for (const r of rows) {
    const start = r.querySelector('.slot-start').value;
    const end = r.querySelector('.slot-end').value;
    if (!start || !end) {
      showAlert('All availability windows must have both a start and end time');
      return;
    }
    slots.push({
      start_time: new Date(start).toISOString(),
      end_time: new Date(end).toISOString(),
      is_available: true,
    });
  }

  if (slots.length === 0) {
    showAlert('Please add at least one availability window');
    return;
  }

  try {
    const res = await fetch(`/api/j/${token}/availability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slots }),
    });

    const data = await res.json();
    if (!res.ok) {
      showAlert(data.error || (data.details ? data.details.join(', ') : 'Failed to save availability'));
      return;
    }

    showAlert('Availability schedule successfully saved!', 'success');
  } catch (err) {
    showAlert('Network error saving availability');
  }
});

// Conflicts Handling
function addCoiRow(existing = null) {
  const row = document.createElement('div');
  row.className = 'coi-entry';
  row.style.cssText = 'background: #fff; border: 1px solid var(--border-color); border-radius: 6px; padding: 12px; margin-bottom: 10px;';

  const descVal = existing ? escapeHtml(existing.description || '') : '';
  const subjName = existing ? escapeHtml(existing.subject_name || '') : '';
  const subjKind = existing ? escapeHtml(existing.subject_kind || '') : '';
  const severityVal = existing ? existing.severity : 'medium';
  const conflictId = existing ? existing.id : '';

  row.innerHTML = `
    <input type="hidden" class="coi-supersedes-id" value="${conflictId}">
    <div style="display: grid; grid-template-columns: 1fr 1fr 120px auto; gap: 8px; margin-bottom: 8px; align-items: flex-end;">
      <div>
        <label style="font-size: 0.75rem;">Subject / Person / Team Name</label>
        <input type="text" class="coi-name" value="${subjName}" placeholder="e.g. Team ByteCraft or Student Name" style="width: 100%; padding: 6px; font-size: 0.8rem; border: 1px solid var(--border-color); border-radius: 4px;">
      </div>
      <div>
        <label style="font-size: 0.75rem;">Relationship Type</label>
        <input type="text" class="coi-kind" value="${subjKind}" placeholder="e.g. Former Advisee, Family, Co-author" style="width: 100%; padding: 6px; font-size: 0.8rem; border: 1px solid var(--border-color); border-radius: 4px;">
      </div>
      <div>
        <label style="font-size: 0.75rem;">Severity</label>
        <select class="coi-severity" style="width: 100%; padding: 6px; font-size: 0.8rem; border: 1px solid var(--border-color); border-radius: 4px;">
          <option value="low" ${severityVal === 'low' ? 'selected' : ''}>Low</option>
          <option value="medium" ${severityVal === 'medium' ? 'selected' : ''}>Medium</option>
          <option value="high" ${severityVal === 'high' ? 'selected' : ''}>High</option>
        </select>
      </div>
      <div>
        <button type="button" class="btn btn-secondary btn-sm" onclick="this.closest('.coi-entry').remove()">&times;</button>
      </div>
    </div>
    <div>
      <label style="font-size: 0.75rem;">Description of Conflict *</label>
      <input type="text" class="coi-desc" value="${descVal}" placeholder="Specific context regarding the conflict of interest..." required style="width: 100%; padding: 6px; font-size: 0.8rem; border: 1px solid var(--border-color); border-radius: 4px;">
    </div>
  `;

  coiContainer.appendChild(row);
}

addCoiBtn.addEventListener('click', () => addCoiRow());

saveCoiBtn.addEventListener('click', async () => {
  clearAlert();
  const rows = document.querySelectorAll('.coi-entry');
  const conflicts = [];

  for (const r of rows) {
    const desc = r.querySelector('.coi-desc').value.trim();
    if (!desc || desc.length < 3) {
      showAlert('All declared conflicts must include a description (minimum 3 characters)');
      return;
    }
    const supersedesId = r.querySelector('.coi-supersedes-id').value;
    conflicts.push({
      subject_name: r.querySelector('.coi-name').value.trim() || undefined,
      subject_kind: r.querySelector('.coi-kind').value.trim() || undefined,
      severity: r.querySelector('.coi-severity').value,
      description: desc,
      supersedes_id: supersedesId ? Number(supersedesId) : undefined,
    });
  }

  if (conflicts.length === 0) {
    showAlert('Please add at least one conflict to declare, or leave empty if none exist.');
    return;
  }

  try {
    const res = await fetch(`/api/j/${token}/conflicts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conflicts }),
    });

    const data = await res.json();
    if (!res.ok) {
      showAlert(data.error || (data.details ? data.details.join(', ') : 'Failed to declare conflicts'));
      return;
    }

    showAlert('Conflict of interest declarations successfully submitted!', 'success');
  } catch (err) {
    showAlert('Network error saving conflicts');
  }
});

// Init
loadPortal();
