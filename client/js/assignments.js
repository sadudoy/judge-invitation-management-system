/**
 * CSE Fest — Scheduling, Assignments, & Attendance Client Script
 */

(function () {
  'use strict';

  // Elements
  const alertEl = document.getElementById('page-alert');
  const logoutBtn = document.getElementById('logout-btn');
  const selectComp = document.getElementById('select-competition');
  const selectSess = document.getElementById('select-session');
  const btnFeasibility = document.getElementById('btn-check-feasibility');
  const btnFlagAbsent = document.getElementById('btn-flag-absent');

  // Feasibility Elements
  const featPeak = document.getElementById('feat-peak');
  const featAvailable = document.getElementById('feat-available');
  const featStatus = document.getElementById('feat-status');
  const featDeficit = document.getElementById('feat-deficit');

  // Coverage Elements
  const coverageBox = document.getElementById('coverage-box');
  const covSessionName = document.getElementById('cov-session-name');
  const covSessionMeta = document.getElementById('cov-session-meta');
  const covBadgeStatus = document.getElementById('cov-badge-status');
  const covBadgeHead = document.getElementById('cov-badge-head');
  const covGaps = document.getElementById('cov-gaps');

  // Table Elements
  const assignmentsTbody = document.getElementById('assignments-tbody');
  const assignedCount = document.getElementById('assigned-count');
  const candidatesTbody = document.getElementById('candidates-tbody');
  const candidatesCount = document.getElementById('candidates-count');

  // Modals
  const replaceModal = document.getElementById('replace-modal');
  const replaceForm = document.getElementById('replace-form');
  const replaceAssignmentId = document.getElementById('replace-assignment-id');
  const replaceCandidateSelect = document.getElementById('replace-candidate-select');
  const replaceReason = document.getElementById('replace-reason');
  const replaceCancelBtn = document.getElementById('replace-cancel-btn');

  const attendanceModal = document.getElementById('attendance-modal');
  const attendanceForm = document.getElementById('attendance-form');
  const attAssignmentId = document.getElementById('att-assignment-id');
  const attStatusSelect = document.getElementById('att-status-select');
  const attNotes = document.getElementById('att-notes');
  const attCancelBtn = document.getElementById('att-cancel-btn');

  let currentCompetition = null;
  let currentSession = null;
  let competitionsList = [];
  let currentCandidates = [];

  // Helper: Display Alert
  function showAlert(msg, isError = false) {
    alertEl.textContent = msg;
    alertEl.className = isError ? 'alert alert-error' : 'alert alert-success';
    alertEl.style.display = 'block';
    setTimeout(() => {
      alertEl.style.display = 'none';
    }, 6000);
  }

  // Format Dates
  function formatDateTime(isoStr) {
    if (!isoStr) return '-';
    const d = new Date(isoStr);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Check Auth
  async function checkAuth() {
    try {
      const res = await fetch('/api/auth/me');
      if (!res.ok) {
        window.location.href = 'index.html';
        return;
      }
      const data = await res.json();
      if (!['admin', 'coordinator'].includes(data.user?.role)) {
        showAlert('Unauthorized role for assignments management', true);
        setTimeout(() => { window.location.href = 'index.html'; }, 2000);
        return;
      }
      init();
    } catch (err) {
      window.location.href = 'index.html';
    }
  }

  // Logout
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = 'index.html';
    });
  }

  // Initialize
  async function init() {
    await loadCompetitions();
  }

  // Load Competitions
  async function loadCompetitions() {
    try {
      const res = await fetch('/api/competitions');
      const data = await res.json();
      competitionsList = data.competitions || [];

      selectComp.innerHTML = '<option value="">-- Choose Competition --</option>';
      competitionsList.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = `${c.name} (${c.event_name || 'Event'})`;
        selectComp.appendChild(opt);
      });

      if (competitionsList.length > 0) {
        selectComp.value = competitionsList[0].id;
        onCompetitionChange();
      }
    } catch (err) {
      showAlert('Failed to load competitions: ' + err.message, true);
    }
  }

  // Handle Competition Change
  selectComp.addEventListener('change', onCompetitionChange);

  async function onCompetitionChange() {
    const compId = selectComp.value;
    if (!compId) {
      selectSess.disabled = true;
      selectSess.innerHTML = '<option value="">Choose competition first</option>';
      resetViews();
      return;
    }

    currentCompetition = competitionsList.find((c) => String(c.id) === String(compId));

    // Run Feasibility Check for this competition's event
    if (currentCompetition?.event_id) {
      loadFeasibility(currentCompetition.event_id);
    }

    // Load Sessions
    try {
      const res = await fetch(`/api/competitions/${compId}/sessions`);
      const data = await res.json();
      const sessions = data.sessions || [];

      selectSess.innerHTML = '<option value="">-- Choose Session --</option>';
      sessions.forEach((s) => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = `${s.name} [${formatDateTime(s.start_time)}]`;
        selectSess.appendChild(opt);
      });

      selectSess.disabled = false;
      if (sessions.length > 0) {
        selectSess.value = sessions[0].id;
        onSessionChange();
      } else {
        resetViews();
      }
    } catch (err) {
      showAlert('Failed to load sessions: ' + err.message, true);
    }
  }

  // Handle Session Change
  selectSess.addEventListener('change', onSessionChange);

  async function onSessionChange() {
    const sessId = selectSess.value;
    if (!sessId) {
      resetViews();
      return;
    }

    btnFlagAbsent.disabled = false;
    await Promise.all([
      loadCoverage(sessId),
      loadAssignments(sessId),
      loadCandidates(sessId),
    ]);
  }

  // Load Feasibility
  async function loadFeasibility(eventId) {
    try {
      const res = await fetch(`/api/events/${eventId}/feasibility`);
      const data = await res.json();

      featPeak.textContent = data.peak ?? '-';
      featAvailable.textContent = data.available ?? '-';

      if (data.feasible) {
        featStatus.textContent = 'Feasible';
        featStatus.className = 'status-value status-online';
        featDeficit.textContent = 'Full capacity available';
      } else {
        featStatus.textContent = 'Deficit';
        featStatus.className = 'status-value status-error';
        featDeficit.textContent = `Short by ${data.deficit} judge(s)`;
      }
    } catch (err) {
      featStatus.textContent = 'Error';
    }
  }

  btnFeasibility.addEventListener('click', () => {
    if (currentCompetition?.event_id) {
      loadFeasibility(currentCompetition.event_id);
    }
  });

  // Load Coverage
  async function loadCoverage(sessionId) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/coverage`);
      const data = await res.json();

      coverageBox.style.display = 'block';
      covSessionName.textContent = `${data.session_name} (${data.competition_name})`;
      covSessionMeta.textContent = `Required Judges: ${data.required_judges} | Confirmed: ${data.confirmed_judges} | Total Assigned: ${data.total_assigned}`;

      // Coverage badge
      if (data.is_covered) {
        covBadgeStatus.textContent = 'Ready / Covered';
        covBadgeStatus.className = 'badge badge-success';
      } else {
        covBadgeStatus.textContent = `Understaffed (${data.missing_judges} needed)`;
        covBadgeStatus.className = 'badge badge-warning';
      }

      // Head Judge badge
      if (data.missing_head) {
        covBadgeHead.textContent = 'Missing Head Judge';
        covBadgeHead.className = 'badge badge-danger';
      } else {
        covBadgeHead.textContent = 'Head Judge Assigned';
        covBadgeHead.className = 'badge badge-success';
      }

      if (data.gaps && data.gaps.length > 0) {
        covGaps.innerHTML = '<strong>Staffing Gaps:</strong> ' + data.gaps.join(' &bull; ');
      } else {
        covGaps.innerHTML = '<span style="color: #166534;">&check; All session coverage requirements satisfied.</span>';
      }
    } catch (err) {
      showAlert('Failed to load coverage: ' + err.message, true);
    }
  }

  // Load Assignments & Attendance
  async function loadAssignments(sessionId) {
    try {
      const res = await fetch(`/api/assignments?session_id=${sessionId}&limit=100`);
      const data = await res.json();
      const assignments = data.assignments || [];

      assignedCount.textContent = assignments.length;
      assignmentsTbody.innerHTML = '';

      if (assignments.length === 0) {
        assignmentsTbody.innerHTML = `
          <tr>
            <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 24px;">
              No judges currently assigned to this session.
            </td>
          </tr>
        `;
        return;
      }

      assignments.forEach((a) => {
        const tr = document.createElement('tr');

        // Status badge class
        const statusClass = `badge-${a.status}`;
        const attStatus = a.attendance_status || 'not_arrived';
        const attClass = `att-${attStatus}`;

        let attendanceDisplay = attStatus.replace('_', ' ');
        if (attStatus === 'late' && a.minutes_late > 0) {
          attendanceDisplay += ` (+${a.minutes_late}m)`;
        }

        tr.innerHTML = `
          <td>
            <strong>${escapeHTML(a.first_name)} ${escapeHTML(a.last_name)}</strong>
            <div class="text-muted" style="font-size: 0.75rem;">${escapeHTML(a.organization || a.email)}</div>
          </td>
          <td>
            <span class="badge badge-role">${escapeHTML(a.role)}</span>
          </td>
          <td>
            <span class="badge ${statusClass}">${escapeHTML(a.status)}</span>
          </td>
          <td>
            <span class="badge ${attClass}">${escapeHTML(attendanceDisplay)}</span>
          </td>
          <td style="white-space: nowrap;">
            ${
              a.status === 'held'
                ? `<button class="btn btn-secondary btn-sm btn-confirm" data-id="${a.id}" title="Admin Override Confirmation">&check; Confirm</button>`
                : ''
            }
            ${
              a.status !== 'cancelled' && a.status !== 'replaced'
                ? `<button class="btn btn-secondary btn-sm btn-replace" data-id="${a.id}" data-name="${escapeHTML(a.first_name + ' ' + a.last_name)}">Replace</button>`
                : ''
            }
            ${
              a.superseded_by || a.replaces_assignment_id
                ? `<button class="btn btn-secondary btn-sm btn-undo-replace" data-id="${a.id}" title="Cancel replacement within 10-minute undo window">&larr; Undo</button>`
                : ''
            }
            <button class="btn btn-secondary btn-sm btn-edit-att" data-id="${a.id}" data-status="${attStatus}" data-notes="${escapeHTML(a.notes || '')}">Att</button>
            ${
              a.status !== 'cancelled'
                ? `<button class="btn btn-danger btn-sm btn-cancel-assign" data-id="${a.id}">&times;</button>`
                : ''
            }
          </td>
        `;

        assignmentsTbody.appendChild(tr);
      });

      // Attach row action handlers
      attachRowHandlers();
    } catch (err) {
      showAlert('Failed to load assignments: ' + err.message, true);
    }
  }

  // Load Candidates
  async function loadCandidates(sessionId) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/candidates`);
      const data = await res.json();
      currentCandidates = data.candidates || [];

      candidatesCount.textContent = currentCandidates.length;
      candidatesTbody.innerHTML = '';

      if (currentCandidates.length === 0) {
        candidatesTbody.innerHTML = `
          <tr>
            <td colspan="4" style="text-align: center; color: var(--text-muted); padding: 24px;">
              No eligible candidate judges found (all judges have overlaps, COI, or unavailability).
            </td>
          </tr>
        `;
        return;
      }

      currentCandidates.forEach((c) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>
            <strong>${escapeHTML(c.first_name)} ${escapeHTML(c.last_name)}</strong>
            <div class="text-muted" style="font-size: 0.75rem;">${escapeHTML(c.organization || c.email)}</div>
          </td>
          <td>
            <span class="badge" style="background:#e0f2fe; color:#0369a1;">${escapeHTML(c.kind || 'academic')}</span>
          </td>
          <td>
            <select class="filter-select select-assign-role" style="padding: 4px 8px; font-size: 0.8rem;">
              <option value="judge">Judge</option>
              <option value="head_judge">Head Judge</option>
              <option value="evaluator">Evaluator</option>
            </select>
          </td>
          <td>
            <button class="btn btn-primary btn-sm btn-assign" data-judge-id="${c.id}">
              + Assign
            </button>
          </td>
        `;
        candidatesTbody.appendChild(tr);
      });

      // Attach candidate assign handlers
      candidatesTbody.querySelectorAll('.btn-assign').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const row = e.target.closest('tr');
          const judgeId = e.target.getAttribute('data-judge-id');
          const roleSelect = row.querySelector('.select-assign-role');
          const role = roleSelect ? roleSelect.value : 'judge';

          await assignJudge(selectSess.value, judgeId, role);
        });
      });
    } catch (err) {
      showAlert('Failed to load candidates: ' + err.message, true);
    }
  }

  // Action: Assign Judge (PostgreSQL 23P01 overlap guard handled here)
  async function assignJudge(sessionId, judgeId, role) {
    try {
      const res = await fetch('/api/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: Number(sessionId),
          judge_id: Number(judgeId),
          role,
        }),
      });

      const data = await res.json();

      if (res.status === 409) {
        // Double-booking exclusion violation error
        if (data.error === 'overlap') {
          showAlert(`Overlap Conflict: Judge is already assigned to an overlapping session (Conflicting Assignment: #${data.conflicting_assignment_id || 'ID'}). Database EXCLUDE constraint blocked double-booking.`, true);
          return;
        }
        showAlert(data.error || 'Assignment conflict', true);
        return;
      }

      if (!res.ok) {
        showAlert(data.error || 'Failed to assign judge', true);
        return;
      }

      showAlert(`Judge assigned successfully (Status: ${data.assignment?.status})!`);
      await onSessionChange();
    } catch (err) {
      showAlert('Assignment error: ' + err.message, true);
    }
  }

  // Row Action Handlers
  function attachRowHandlers() {
    // Confirm Override
    assignmentsTbody.querySelectorAll('.btn-confirm').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        try {
          const res = await fetch(`/api/assignments/${id}/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'Admin confirmed from coverage dashboard' }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Failed to confirm');
          showAlert('Assignment confirmed via admin override');
          await onSessionChange();
        } catch (err) {
          showAlert(err.message, true);
        }
      });
    });

    // Replace Modal Trigger
    assignmentsTbody.querySelectorAll('.btn-replace').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        replaceAssignmentId.value = id;

        // Populate replacement candidate select
        replaceCandidateSelect.innerHTML = '<option value="">Leave Vacant (No immediate replacement)</option>';
        currentCandidates.forEach((c) => {
          const opt = document.createElement('option');
          opt.value = c.id;
          opt.textContent = `${c.first_name} ${c.last_name} (${c.organization || c.email})`;
          replaceCandidateSelect.appendChild(opt);
        });

        replaceReason.value = '';
        replaceModal.style.display = 'flex';
      });
    });

    // Undo Replacement
    assignmentsTbody.querySelectorAll('.btn-undo-replace').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        if (!confirm('Undo this replacement and restore original assignment?')) return;
        try {
          const res = await fetch(`/api/assignments/${id}/cancel-replacement`, {
            method: 'POST',
          });
          const data = await res.json();
          if (res.status === 409) {
            showAlert('Cannot undo replacement: 10-minute undo window has elapsed!', true);
            return;
          }
          if (!res.ok) throw new Error(data.error || 'Failed to cancel replacement');
          showAlert('Replacement undone and original assignment restored.');
          await onSessionChange();
        } catch (err) {
          showAlert(err.message, true);
        }
      });
    });

    // Attendance Edit Modal Trigger
    assignmentsTbody.querySelectorAll('.btn-edit-att').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const status = btn.getAttribute('data-status') || 'checked_in';
        const notes = btn.getAttribute('data-notes') || '';

        attAssignmentId.value = id;
        attStatusSelect.value = status;
        attNotes.value = notes;

        attendanceModal.style.display = 'flex';
      });
    });

    // Cancel Assignment (Soft delete)
    assignmentsTbody.querySelectorAll('.btn-cancel-assign').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        if (!confirm('Cancel this judging assignment? (Soft-delete status=cancelled)')) return;
        try {
          const res = await fetch(`/api/assignments/${id}`, { method: 'DELETE' });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Failed to cancel');
          showAlert('Assignment cancelled.');
          await onSessionChange();
        } catch (err) {
          showAlert(err.message, true);
        }
      });
    });
  }

  // Replace Form Submission
  replaceForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = replaceAssignmentId.value;
    const replacementJudgeId = replaceCandidateSelect.value ? Number(replaceCandidateSelect.value) : undefined;
    const reason = replaceReason.value.trim();

    try {
      const res = await fetch(`/api/assignments/${id}/replace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          replacement_judge_id: replacementJudgeId,
          reason,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Replacement failed');

      showAlert('Replacement processed successfully');
      replaceModal.style.display = 'none';
      await onSessionChange();
    } catch (err) {
      showAlert(err.message, true);
    }
  });

  replaceCancelBtn.addEventListener('click', () => {
    replaceModal.style.display = 'none';
  });

  // Attendance Form Submission
  attendanceForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = attAssignmentId.value;
    const status = attStatusSelect.value;
    const notes = attNotes.value.trim();

    try {
      const res = await fetch(`/api/assignments/${id}/attendance`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, notes }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update attendance');

      showAlert('Attendance record updated');
      attendanceModal.style.display = 'none';
      await onSessionChange();
    } catch (err) {
      showAlert(err.message, true);
    }
  });

  attCancelBtn.addEventListener('click', () => {
    attendanceModal.style.display = 'none';
  });

  // Flag Absent Button Handler
  btnFlagAbsent.addEventListener('click', async () => {
    const sessionId = selectSess.value;
    if (!sessionId) return;
    if (!confirm('Flag all unchecked judges as Absent and trigger coordinator notification?')) return;

    try {
      const res = await fetch(`/api/sessions/${sessionId}/flag-absent`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to flag absent');

      showAlert(`Flagged ${data.flagged_count} judge(s) as Absent.`);
      await onSessionChange();
    } catch (err) {
      showAlert(err.message, true);
    }
  });

  function resetViews() {
    coverageBox.style.display = 'none';
    btnFlagAbsent.disabled = true;
    assignmentsTbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px;">Select a session.</td></tr>';
    candidatesTbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:24px;">Select a session.</td></tr>';
    assignedCount.textContent = '0';
    candidatesCount.textContent = '0';
  }

  function escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Run Auth Check on start
  checkAuth();
})();