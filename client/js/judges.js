'use strict';

// State
let currentPage = 1;
const pageSize = 20;
let totalCount = 0;
let searchDebounceTimer = null;

// DOM Elements
const tbody = document.getElementById('judges-tbody');
const searchInput = document.getElementById('search-input');
const filterKind = document.getElementById('filter-kind');
const filterStatus = document.getElementById('filter-status');
const resultsCount = document.getElementById('results-count');
const prevPageBtn = document.getElementById('prev-page-btn');
const nextPageBtn = document.getElementById('next-page-btn');
const pageIndicator = document.getElementById('page-indicator');

const judgeModal = document.getElementById('judge-modal');
const judgeForm = document.getElementById('judge-form');
const modalTitle = document.getElementById('modal-title');
const modalError = document.getElementById('modal-error');
const openAddBtn = document.getElementById('open-add-judge-btn');
const closeModalBtn = document.getElementById('close-modal-btn');
const cancelModalBtn = document.getElementById('cancel-modal-btn');

const historyDrawer = document.getElementById('history-drawer');
const drawerCloseBtn = document.getElementById('close-drawer-btn');
const drawerContent = document.getElementById('drawer-content');
const drawerJudgeName = document.getElementById('drawer-judge-name');
const drawerJudgeSub = document.getElementById('drawer-judge-sub');
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

async function loadJudges() {
  const q = searchInput.value.trim();
  const kind = filterKind.value;
  const status = filterStatus.value;
  const offset = (currentPage - 1) * pageSize;

  const params = new URLSearchParams({
    limit: pageSize,
    offset: offset,
    sort_by: 'created_at',
    order: 'desc',
  });
  if (q) params.set('q', q);
  if (kind) params.set('kind', kind);
  if (status) params.set('status', status);

  tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 24px;" class="text-muted">Loading judges...</td></tr>`;

  try {
    const res = await fetch(`/api/judges?${params.toString()}`);
    if (!res.ok) {
      const err = await res.json();
      tbody.innerHTML = `<tr><td colspan="6" style="color: var(--error-text); text-align: center; padding: 20px;">Error: ${escapeHtml(err.error || 'Failed to load judges')}</td></tr>`;
      return;
    }

    const data = await res.json();
    totalCount = data.total;
    resultsCount.textContent = `Showing ${data.judges.length} of ${totalCount} judges`;

    renderTable(data.judges);
    updatePagination();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="color: var(--error-text); text-align: center; padding: 20px;">Network error loading judges.</td></tr>`;
  }
}

function renderTable(judges) {
  if (judges.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 32px;" class="text-muted">No judges found matching current filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = judges
    .map((j) => {
      const fullName = `${j.first_name} ${j.last_name}`;
      const isActive = j.status === 'active';
      const expertiseBadges = Array.isArray(j.expertise) && j.expertise.length > 0
        ? `<div style="margin-top: 4px;">${j.expertise.map(e => `<span class="badge" style="background: #e2e8f0; color: #334155; margin-right: 4px;">${escapeHtml(e)}</span>`).join('')}</div>`
        : '';

      return `
        <tr>
          <td>
            <strong>${escapeHtml(fullName)}</strong>
            ${expertiseBadges}
          </td>
          <td>
            <div>${escapeHtml(j.email)}</div>
            ${j.phone ? `<div class="text-muted" style="font-size: 0.8rem;">${escapeHtml(j.phone)}</div>` : ''}
          </td>
          <td>
            <div>${escapeHtml(j.organization || '—')}</div>
            <div class="text-muted" style="font-size: 0.8rem;">${escapeHtml(j.designation || '—')}</div>
          </td>
          <td>
            <span class="badge" style="background: #f1f5f9; color: #475569;">${escapeHtml(j.kind)}</span>
          </td>
          <td>
            <span class="badge ${isActive ? 'badge-active' : 'badge-inactive'}">
              ${escapeHtml(j.status)}
            </span>
          </td>
          <td style="text-align: right; white-space: nowrap;">
            <button class="btn btn-secondary btn-sm" onclick="openHistoryDrawer(${j.id})">History</button>
            <button class="btn btn-secondary btn-sm" onclick="openEditModal(${j.id})">Edit</button>
            ${
              isActive
                ? `<button class="btn btn-danger btn-sm" onclick="deactivateJudge(${j.id}, '${escapeHtml(fullName)}')">Deactivate</button>`
                : ''
            }
          </td>
        </tr>
      `;
    })
    .join('');
}

function updatePagination() {
  const maxPage = Math.max(1, Math.ceil(totalCount / pageSize));
  pageIndicator.textContent = `Page ${currentPage} of ${maxPage}`;
  prevPageBtn.disabled = currentPage <= 1;
  nextPageBtn.disabled = currentPage >= maxPage;
}

// Modal Handling
function openAddModal() {
  judgeForm.reset();
  document.getElementById('judge-id').value = '';
  modalTitle.textContent = 'Add New Judge';
  modalError.style.display = 'none';
  judgeModal.style.display = 'flex';
}

async function openEditModal(judgeId) {
  judgeForm.reset();
  modalError.style.display = 'none';
  modalTitle.textContent = 'Edit Judge Profile';

  try {
    const res = await fetch(`/api/judges/${judgeId}`);
    if (!res.ok) {
      alert('Failed to load judge details');
      return;
    }
    const { judge } = await res.json();
    document.getElementById('judge-id').value = judge.id;
    document.getElementById('first_name').value = judge.first_name || '';
    document.getElementById('last_name').value = judge.last_name || '';
    document.getElementById('judge-email').value = judge.email || '';
    document.getElementById('phone').value = judge.phone || '';
    document.getElementById('kind').value = judge.kind || 'academic';
    document.getElementById('organization').value = judge.organization || '';
    document.getElementById('designation').value = judge.designation || '';
    document.getElementById('expertise').value = Array.isArray(judge.expertise) ? judge.expertise.join(', ') : '';
    document.getElementById('bio').value = judge.bio || '';

    judgeModal.style.display = 'flex';
  } catch (err) {
    alert('Failed to connect to server');
  }
}

function closeModal() {
  judgeModal.style.display = 'none';
}

judgeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  modalError.style.display = 'none';

  const judgeId = document.getElementById('judge-id').value;
  const isEdit = Boolean(judgeId);

  const expertiseRaw = document.getElementById('expertise').value;
  const expertise = expertiseRaw
    ? expertiseRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  const payload = {
    first_name: document.getElementById('first_name').value.trim(),
    last_name: document.getElementById('last_name').value.trim(),
    email: document.getElementById('judge-email').value.trim(),
    phone: document.getElementById('phone').value.trim() || undefined,
    kind: document.getElementById('kind').value,
    organization: document.getElementById('organization').value.trim() || undefined,
    designation: document.getElementById('designation').value.trim() || undefined,
    expertise,
    bio: document.getElementById('bio').value.trim() || undefined,
  };

  try {
    const url = isEdit ? `/api/judges/${judgeId}` : '/api/judges';
    const method = isEdit ? 'PATCH' : 'POST';

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) {
      modalError.textContent = data.error || (data.details ? data.details.join(', ') : 'Request failed');
      modalError.style.display = 'block';
      return;
    }

    closeModal();
    loadJudges();
  } catch (err) {
    modalError.textContent = 'Network error saving judge';
    modalError.style.display = 'block';
  }
});

// Guarded Deactivation
async function deactivateJudge(judgeId, judgeName) {
  if (!confirm(`Are you sure you want to deactivate ${judgeName}?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/judges/${judgeId}/deactivate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const data = await res.json();
    if (!res.ok) {
      if (res.status === 409 && data.conflict) {
        alert(
          `Deactivation blocked!\n\n${judgeName} has an active/confirmed future assignment for: ${data.conflict.competition}.\n\nReassign or cancel that session before deactivating.`
        );
      } else {
        alert(data.error || 'Failed to deactivate judge');
      }
      return;
    }

    alert('Judge deactivated successfully');
    loadJudges();
  } catch (err) {
    alert('Network error while deactivating judge');
  }
}

// History Drawer
async function openHistoryDrawer(judgeId) {
  drawerJudgeName.textContent = 'Loading...';
  drawerJudgeSub.textContent = '';
  drawerContent.innerHTML = '<p class="text-muted">Fetching history...</p>';
  historyDrawer.style.display = 'flex';

  try {
    const res = await fetch(`/api/judges/${judgeId}/history`);
    if (!res.ok) {
      drawerContent.innerHTML = '<p style="color: var(--error-text);">Failed to load history</p>';
      return;
    }

    const data = await res.json();
    const j = data.judge;
    drawerJudgeName.textContent = `${j.first_name} ${j.last_name}`;
    drawerJudgeSub.textContent = `${j.email} • ${j.organization || 'No Org'} • ${j.kind}`;

    let html = '';

    // Invitations section
    html += '<h4 style="margin: 16px 0 8px;">Invitations History</h4>';
    if (!data.invitations || data.invitations.length === 0) {
      html += '<p class="text-muted" style="font-size: 0.85rem;">No invitations recorded.</p>';
    } else {
      html += '<div style="display: flex; flex-direction: column; gap: 8px;">';
      data.invitations.forEach((inv) => {
        html += `
          <div style="background: #f8fafc; border: 1px solid var(--border-color); border-radius: 6px; padding: 10px; font-size: 0.85rem;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <strong>${escapeHtml(inv.competition_name)}</strong>
              <span class="badge badge-status badge-status-${inv.status}">${inv.status}</span>
            </div>
            <div class="text-muted" style="margin-top: 4px; font-size: 0.75rem;">
              Sent: ${inv.sent_at ? new Date(inv.sent_at).toLocaleDateString() : 'Draft'} |
              Expires: ${inv.expires_at ? new Date(inv.expires_at).toLocaleDateString() : 'None'}
            </div>
          </div>
        `;
      });
      html += '</div>';
    }

    // Assignments section
    html += '<h4 style="margin: 20px 0 8px;">Judging Assignments</h4>';
    if (!data.assignments || data.assignments.length === 0) {
      html += '<p class="text-muted" style="font-size: 0.85rem;">No session assignments recorded.</p>';
    } else {
      html += '<div style="display: flex; flex-direction: column; gap: 8px;">';
      data.assignments.forEach((a) => {
        html += `
          <div style="background: #f8fafc; border: 1px solid var(--border-color); border-radius: 6px; padding: 10px; font-size: 0.85rem;">
            <div style="display: flex; justify-content: space-between;">
              <strong>${escapeHtml(a.session_name)} (${escapeHtml(a.competition_name)})</strong>
              <span class="badge" style="background: #e2e8f0; color: #334155;">${escapeHtml(a.status)}</span>
            </div>
            <div class="text-muted" style="margin-top: 4px; font-size: 0.75rem;">
              Time: ${new Date(a.start_time).toLocaleString()} — ${new Date(a.end_time).toLocaleTimeString()}
              ${a.venue_name ? `| Venue: ${escapeHtml(a.venue_name)}` : ''}
            </div>
          </div>
        `;
      });
      html += '</div>';
    }

    // Declared Conflicts section
    html += '<h4 style="margin: 20px 0 8px;">Declared Conflicts of Interest</h4>';
    if (!data.conflicts || data.conflicts.length === 0) {
      html += '<p class="text-muted" style="font-size: 0.85rem;">No declared conflicts.</p>';
    } else {
      html += '<div style="display: flex; flex-direction: column; gap: 8px;">';
      data.conflicts.forEach((c) => {
        const isSuperseded = Boolean(c.superseded_by);
        html += `
          <div style="background: ${isSuperseded ? '#f1f5f9' : '#fff7ed'}; border: 1px solid ${isSuperseded ? '#e2e8f0' : '#fed7aa'}; border-radius: 6px; padding: 10px; font-size: 0.85rem;">
            <div style="display: flex; justify-content: space-between;">
              <span>${c.subject_name ? `<strong>${escapeHtml(c.subject_name)}</strong> ` : ''}${c.subject_kind ? `(${escapeHtml(c.subject_kind)})` : ''}</span>
              <span class="badge" style="background: #fee2e2; color: #991b1b;">${escapeHtml(c.severity || 'medium')}</span>
            </div>
            <p style="margin: 4px 0;">${escapeHtml(c.description)}</p>
            ${isSuperseded ? '<span class="badge" style="background: #e2e8f0; color: #64748b;">Superseded</span>' : ''}
          </div>
        `;
      });
      html += '</div>';
    }

    drawerContent.innerHTML = html;
  } catch (err) {
    drawerContent.innerHTML = '<p style="color: var(--error-text);">Network error loading history</p>';
  }
}

function closeDrawer() {
  historyDrawer.style.display = 'none';
}

// Event Listeners
openAddBtn.addEventListener('click', openAddModal);
closeModalBtn.addEventListener('click', closeModal);
cancelModalBtn.addEventListener('click', closeModal);
drawerCloseBtn.addEventListener('click', closeDrawer);

// Close on backdrop click
judgeModal.addEventListener('click', (e) => {
  if (e.target === judgeModal) closeModal();
});
historyDrawer.addEventListener('click', (e) => {
  if (e.target === historyDrawer) closeDrawer();
});

// Search debounce
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    currentPage = 1;
    loadJudges();
  }, 250);
});

filterKind.addEventListener('change', () => {
  currentPage = 1;
  loadJudges();
});

filterStatus.addEventListener('change', () => {
  currentPage = 1;
  loadJudges();
});

prevPageBtn.addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage--;
    loadJudges();
  }
});

nextPageBtn.addEventListener('click', () => {
  currentPage++;
  loadJudges();
});

logoutBtn.addEventListener('click', async () => {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } finally {
    window.location.href = 'index.html';
  }
});

// Expose globals for inline HTML handlers
window.openEditModal = openEditModal;
window.deactivateJudge = deactivateJudge;
window.openHistoryDrawer = openHistoryDrawer;

// Init
checkAuth().then((user) => {
  if (user) {
    loadJudges();
  }
});
