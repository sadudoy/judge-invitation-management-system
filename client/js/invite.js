'use strict';

let competitions = [];
let allJudges = [];

// DOM Elements
const tbody = document.getElementById('invitations-tbody');
const filterCompetition = document.getElementById('filter-competition');
const filterStatus = document.getElementById('filter-status');
const invitationsCount = document.getElementById('invitations-count');
const bulkModal = document.getElementById('bulk-modal');
const bulkInviteForm = document.getElementById('bulk-invite-form');
const modalCompetition = document.getElementById('modal-competition');
const deadlineHours = document.getElementById('deadline-hours');
const judgesPickerList = document.getElementById('judges-picker-list');
const judgeSearchPicker = document.getElementById('judge-search-picker');
const selectAllBtn = document.getElementById('select-all-btn');
const deselectAllBtn = document.getElementById('deselect-all-btn');
const openBulkModalBtn = document.getElementById('open-bulk-modal-btn');
const closeBulkModalBtn = document.getElementById('close-bulk-modal-btn');
const cancelBulkModalBtn = document.getElementById('cancel-bulk-modal-btn');
const bulkModalError = document.getElementById('bulk-modal-error');
const bulkResultBanner = document.getElementById('bulk-result-banner');
const logoutBtn = document.getElementById('logout-btn');

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) {
      window.location.href = 'index.html';
      return null;
    }
    const data = await res.json();
    if (data.user.role === 'viewer') {
      alert('Viewer role has read-only dashboard access.');
      window.location.href = 'index.html';
      return null;
    }
    return data.user;
  } catch (err) {
    window.location.href = 'index.html';
    return null;
  }
}

async function loadCompetitions() {
  try {
    const res = await fetch('/api/competitions');
    if (!res.ok) return;
    const data = await res.json();
    competitions = data.competitions || [];

    // Populate filter dropdown
    filterCompetition.innerHTML = '<option value="">All Competitions</option>' +
      competitions.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');

    // Populate modal dropdown
    modalCompetition.innerHTML = '<option value="">Select a competition...</option>' +
      competitions.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  } catch (err) {
    console.error('Failed to load competitions', err);
  }
}

async function loadActiveJudges() {
  try {
    const res = await fetch('/api/judges?status=active&limit=100');
    if (!res.ok) return;
    const data = await res.json();
    allJudges = data.judges || [];
    renderJudgePicker(allJudges);
  } catch (err) {
    console.error('Failed to load active judges', err);
  }
}

function renderJudgePicker(judges) {
  if (judges.length === 0) {
    judgesPickerList.innerHTML = '<p class="text-muted" style="font-size: 0.85rem;">No active judges available.</p>';
    return;
  }

  judgesPickerList.innerHTML = judges.map(j => `
    <label style="display: flex; align-items: center; gap: 8px; padding: 4px 6px; font-size: 0.85rem; cursor: pointer; border-bottom: 1px solid #f1f5f9;">
      <input type="checkbox" name="judge_id" value="${j.id}" class="judge-checkbox">
      <span style="font-weight: 600;">${escapeHtml(j.first_name)} ${escapeHtml(j.last_name)}</span>
      <span class="text-muted">(${escapeHtml(j.email)} • ${escapeHtml(j.organization || 'No Org')})</span>
    </label>
  `).join('');
}

async function loadInvitations() {
  const compId = filterCompetition.value;
  const status = filterStatus.value;

  const params = new URLSearchParams({ limit: 100 });
  if (compId) params.set('competition_id', compId);
  if (status) params.set('status', status);

  tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 24px;" class="text-muted">Loading invitations...</td></tr>';

  try {
    const res = await fetch(`/api/invitations?${params.toString()}`);
    if (!res.ok) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--error-text);">Failed to load invitations</td></tr>';
      return;
    }

    const data = await res.json();
    const invitations = data.invitations || [];
    invitationsCount.textContent = `Showing ${invitations.length} invitations`;

    if (invitations.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 32px;" class="text-muted">No invitations found matching filters.</td></tr>';
      return;
    }

    tbody.innerHTML = invitations.map(inv => {
      const isLive = ['sent', 'viewed', 'tentative'].includes(inv.status);
      const isTerminal = ['accepted', 'declined', 'cancelled'].includes(inv.status);

      return `
        <tr>
          <td>
            <strong>${escapeHtml(inv.first_name)} ${escapeHtml(inv.last_name)}</strong>
            <div class="text-muted" style="font-size: 0.8rem;">${escapeHtml(inv.email)}</div>
          </td>
          <td>${escapeHtml(inv.competition_name)}</td>
          <td>
            <span class="badge badge-status badge-status-${inv.status}">${inv.status}</span>
          </td>
          <td>${inv.sent_at ? new Date(inv.sent_at).toLocaleDateString() : 'Draft'}</td>
          <td>${inv.expires_at ? new Date(inv.expires_at).toLocaleDateString() : '—'}</td>
          <td style="text-align: right; white-space: nowrap;">
            ${!isTerminal ? `<button class="btn btn-secondary btn-sm" onclick="resendInvitation(${inv.id})">Resend</button>` : ''}
            ${!isTerminal ? `<button class="btn btn-danger btn-sm" onclick="cancelInvitation(${inv.id})">Cancel</button>` : ''}
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--error-text);">Network error loading invitations</td></tr>';
  }
}

async function resendInvitation(id) {
  if (!confirm('Resend this invitation? This generates a new magic link and extends the response deadline.')) {
    return;
  }

  try {
    const res = await fetch(`/api/invitations/${id}/resend`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Failed to resend invitation');
      return;
    }

    let msg = 'Invitation resent successfully!';
    if (data.magicLinkUrl) {
      msg += `\n\n[DEV MODE] Magic Link:\n${window.location.origin}${data.magicLinkUrl}`;
    }
    alert(msg);
    loadInvitations();
  } catch (err) {
    alert('Network error resending invitation');
  }
}

async function cancelInvitation(id) {
  if (!confirm('Are you sure you want to cancel this invitation?')) {
    return;
  }

  try {
    const res = await fetch(`/api/invitations/${id}/cancel`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Failed to cancel invitation');
      return;
    }

    alert('Invitation cancelled successfully.');
    loadInvitations();
  } catch (err) {
    alert('Network error cancelling invitation');
  }
}

// Bulk Modal Handling
function openBulkModal() {
  bulkInviteForm.reset();
  bulkModalError.style.display = 'none';
  renderJudgePicker(allJudges);
  bulkModal.style.display = 'flex';
}

function closeBulkModal() {
  bulkModal.style.display = 'none';
}

judgeSearchPicker.addEventListener('input', () => {
  const query = judgeSearchPicker.value.toLowerCase().trim();
  const filtered = allJudges.filter(j =>
    `${j.first_name} ${j.last_name}`.toLowerCase().includes(query) ||
    j.email.toLowerCase().includes(query) ||
    (j.organization && j.organization.toLowerCase().includes(query))
  );
  renderJudgePicker(filtered);
});

selectAllBtn.addEventListener('click', () => {
  document.querySelectorAll('.judge-checkbox').forEach(cb => cb.checked = true);
});

deselectAllBtn.addEventListener('click', () => {
  document.querySelectorAll('.judge-checkbox').forEach(cb => cb.checked = false);
});

openBulkModalBtn.addEventListener('click', openBulkModal);
closeBulkModalBtn.addEventListener('click', closeBulkModal);
cancelBulkModalBtn.addEventListener('click', closeBulkModal);

bulkInviteForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  bulkModalError.style.display = 'none';

  const compId = modalCompetition.value;
  if (!compId) {
    bulkModalError.textContent = 'Please select a target competition';
    bulkModalError.style.display = 'block';
    return;
  }

  const checkedBoxes = Array.from(document.querySelectorAll('.judge-checkbox:checked'));
  const judgeIds = checkedBoxes.map(cb => Number(cb.value));

  if (judgeIds.length === 0) {
    bulkModalError.textContent = 'Please select at least one judge to invite';
    bulkModalError.style.display = 'block';
    return;
  }

  const hours = Number(deadlineHours.value) || 72;

  try {
    const res = await fetch('/api/invitations/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        competition_id: Number(compId),
        judge_ids: judgeIds,
        deadline_hours: hours,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      bulkModalError.textContent = data.error || 'Failed to dispatch invitations';
      bulkModalError.style.display = 'block';
      return;
    }

    closeBulkModal();

    // Render results in banner
    let bannerHtml = `<strong>Batch Dispatched:</strong> ${data.created_count} invited, ${data.skipped_count} skipped.`;
    if (data.skipped && data.skipped.length > 0) {
      bannerHtml += `<br><span style="font-size: 0.85rem;">Skipped: ${data.skipped.map(s => `Judge #${s.judge_id} (${s.reason})`).join(', ')}</span>`;
    }
    if (data.created && data.created.length > 0 && data.created[0].magicLinkUrl) {
      bannerHtml += `<br><span style="font-size: 0.85rem;">[DEV Magic Link Sample]: <a href="${data.created[0].magicLinkUrl}" target="_blank" style="color: #1e40af; text-decoration: underline;">Open Sample Judge Portal (${data.created[0].judge_name})</a></span>`;
    }

    bulkResultBanner.innerHTML = bannerHtml;
    bulkResultBanner.style.display = 'block';

    loadInvitations();
  } catch (err) {
    bulkModalError.textContent = 'Network error during bulk dispatch';
    bulkModalError.style.display = 'block';
  }
});

filterCompetition.addEventListener('change', loadInvitations);
filterStatus.addEventListener('change', loadInvitations);

logoutBtn.addEventListener('click', async () => {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } finally {
    window.location.href = 'index.html';
  }
});

window.resendInvitation = resendInvitation;
window.cancelInvitation = cancelInvitation;

// Init
checkAuth().then(user => {
  if (user) {
    loadCompetitions();
    loadActiveJudges();
    loadInvitations();
  }
});
