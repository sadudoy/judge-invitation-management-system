'use strict';

document.addEventListener('DOMContentLoaded', () => {
  let currentUser = null;
  let auditOffset = 0;
  const auditLimit = 25;
  let pollTimer = null;

  // DOM Elements
  const lastUpdatedEl = document.getElementById('last-updated');
  const pageAlert = document.getElementById('page-alert');
  const btnManualRefresh = document.getElementById('btn-manual-refresh');
  const logoutBtn = document.getElementById('logout-btn');

  function showAlert(msg, isError = false) {
    if (!pageAlert) return;
    pageAlert.textContent = msg;
    pageAlert.className = `alert ${isError ? 'alert-error' : 'alert-success'}`;
    pageAlert.style.display = 'block';
    setTimeout(() => {
      pageAlert.style.display = 'none';
    }, 5000);
  }

  // Auth check
  async function checkAuth() {
    try {
      const res = await fetch('/api/auth/me');
      if (!res.ok) {
        window.location.href = 'index.html';
        return false;
      }
      const data = await res.json();
      currentUser = data.user;
      return true;
    } catch {
      window.location.href = 'index.html';
      return false;
    }
  }

  // Logout handler
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      try {
        await fetch('/api/auth/logout', { method: 'POST' });
      } finally {
        window.location.href = 'index.html';
      }
    });
  }

  // Tab switching
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-tab');
      tabBtns.forEach((b) => b.classList.remove('active'));
      tabContents.forEach((c) => (c.style.display = 'none'));

      btn.classList.add('active');
      const targetEl = document.getElementById(targetId);
      if (targetEl) targetEl.style.display = 'block';

      if (targetId === 'tab-audit') {
        loadAuditLog();
      }
    });
  });

  // Load KPI Summary
  async function loadSummary() {
    try {
      const res = await fetch('/api/dashboard/summary');
      if (!res.ok) return;
      const data = await res.json();

      document.getElementById('kpi-total-judges').textContent = data.total_judges;
      document.getElementById('kpi-invitations').textContent = `${data.invitations_sent} / ${data.invitations_pending}`;
      document.getElementById('kpi-accepted').textContent = data.invitations_accepted;
      document.getElementById('kpi-declined').textContent = data.invitations_declined;

      document.getElementById('kpi-assignments').textContent = data.assignments_confirmed;
      document.getElementById('kpi-held').textContent = data.assignments_held;

      document.getElementById('kpi-missing').textContent = data.missing;
      document.getElementById('kpi-unassigned-sessions').textContent = data.unassigned_sessions;

      document.getElementById('kpi-arrivals').textContent = data.expected_arrivals_today;
      document.getElementById('kpi-checkedin').textContent = data.checked_in;

      document.getElementById('kpi-exceptions').textContent = Number(data.scheduling_conflicts) + Number(data.replacements_open);
      document.getElementById('kpi-conflicts').textContent = data.scheduling_conflicts;
      document.getElementById('kpi-replacements').textContent = data.replacements_open;
    } catch (err) {
      console.error('Failed to load dashboard summary:', err);
    }
  }

  // Load Feasibility Meter
  async function loadFeasibility() {
    try {
      const res = await fetch('/api/dashboard/feasibility');
      if (!res.ok) return;
      const data = await res.json();

      document.getElementById('feat-peak-val').textContent = data.peak;
      document.getElementById('feat-avail-val').textContent = data.available;

      const fill = document.getElementById('meter-fill');
      const badge = document.getElementById('feasibility-badge');
      const diffVal = document.getElementById('feat-diff-val');

      const maxVal = Math.max(data.available, data.peak, 1);
      const pct = Math.min(100, Math.round((data.peak / maxVal) * 100));
      fill.style.width = `${pct}%`;

      if (data.feasible) {
        badge.textContent = 'Feasible (Capacity OK)';
        badge.className = 'pill-badge pill-covered';
        fill.className = 'meter-fill meter-good';
        diffVal.textContent = `Surplus of ${data.available - data.peak} judge(s)`;
        diffVal.style.color = '#16a34a';
      } else {
        badge.textContent = `Deficit of ${data.deficit} Judge(s)`;
        badge.className = 'pill-badge pill-understaffed';
        fill.className = 'meter-fill meter-danger';
        diffVal.textContent = `CRITICAL: Short by ${data.deficit} judge(s)`;
        diffVal.style.color = '#dc2626';
      }
    } catch (err) {
      console.error('Failed to load feasibility:', err);
    }
  }

  // Load Session Coverage Table
  const coverageFilter = document.getElementById('coverage-status-filter');
  if (coverageFilter) {
    coverageFilter.addEventListener('change', () => loadCoverage());
  }

  async function loadCoverage() {
    try {
      const status = coverageFilter ? coverageFilter.value : '';
      const url = status ? `/api/dashboard/coverage?status=${encodeURIComponent(status)}` : '/api/dashboard/coverage';
      const res = await fetch(url);
      if (!res.ok) return;
      const rows = await res.json();

      const tbody = document.getElementById('coverage-tbody');
      if (!tbody) return;

      if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;">No sessions match filter.</td></tr>';
        return;
      }

      tbody.innerHTML = rows
        .map((r) => {
          const startTime = new Date(r.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const endTime = new Date(r.end_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const headBadge = r.has_head
            ? '<span class="pill-badge pill-covered">Assigned</span>'
            : '<span class="pill-badge pill-missing-head">Missing Head</span>';

          const statusBadge = `<span class="pill-badge pill-${r.status}">${r.status}</span>`;

          return `
            <tr>
              <td><strong>${escapeHtml(r.session_name)}</strong></td>
              <td>${escapeHtml(r.competition_name)}</td>
              <td>${startTime} – ${endTime}</td>
              <td style="text-align:center;">${r.required_judges}</td>
              <td style="text-align:center; font-weight:600;">${r.confirmed_count}</td>
              <td style="text-align:center; color:${r.missing > 0 ? '#dc2626' : '#64748b'}; font-weight:700;">${r.missing}</td>
              <td>${headBadge}</td>
              <td>${statusBadge}</td>
            </tr>
          `;
        })
        .join('');
    } catch (err) {
      console.error('Failed to load coverage:', err);
    }
  }

  // Load Workload Leaderboard
  const workloadFilter = document.getElementById('workload-kind-filter');
  if (workloadFilter) {
    workloadFilter.addEventListener('change', () => loadWorkload());
  }

  async function loadWorkload() {
    try {
      const kind = workloadFilter ? workloadFilter.value : '';
      const url = kind ? `/api/dashboard/workload?kind=${encodeURIComponent(kind)}` : '/api/dashboard/workload';
      const res = await fetch(url);
      if (!res.ok) return;
      const rows = await res.json();

      const tbody = document.getElementById('workload-tbody');
      if (!tbody) return;

      if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;">No judges match filter.</td></tr>';
        return;
      }

      tbody.innerHTML = rows
        .map((r) => {
          const lastSlot = r.last_assignment_at
            ? new Date(r.last_assignment_at).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
            : '—';

          const noShowColor = r.no_show_rate > 10 ? '#dc2626' : '#64748b';

          return `
            <tr>
              <td>
                <strong>${escapeHtml(r.full_name)}</strong><br>
                <small class="text-muted">${escapeHtml(r.email)}</small>
              </td>
              <td>${escapeHtml(r.organization || '—')}</td>
              <td><span class="badge" style="text-transform:capitalize;">${escapeHtml(r.kind || 'general')}</span></td>
              <td style="text-align:center; font-weight:600; color:#16a34a;">${r.confirmed_count}</td>
              <td style="text-align:center; color:#92400e;">${r.held_count}</td>
              <td style="text-align:center; font-weight:700;">${r.total_assignments}</td>
              <td style="text-align:center; color:${noShowColor}; font-weight:600;">${r.no_show_rate}%</td>
              <td>${lastSlot}</td>
            </tr>
          `;
        })
        .join('');
    } catch (err) {
      console.error('Failed to load workload:', err);
    }
  }

  // Load Audit Log
  const auditTableFilter = document.getElementById('audit-table-filter');
  const btnAuditFilter = document.getElementById('btn-audit-filter');
  const btnAuditPrev = document.getElementById('btn-audit-prev');
  const btnAuditNext = document.getElementById('btn-audit-next');

  if (btnAuditFilter) {
    btnAuditFilter.addEventListener('click', () => {
      auditOffset = 0;
      loadAuditLog();
    });
  }

  if (btnAuditPrev) {
    btnAuditPrev.addEventListener('click', () => {
      if (auditOffset >= auditLimit) {
        auditOffset -= auditLimit;
        loadAuditLog();
      }
    });
  }

  if (btnAuditNext) {
    btnAuditNext.addEventListener('click', () => {
      auditOffset += auditLimit;
      loadAuditLog();
    });
  }

  async function loadAuditLog() {
    try {
      const table = auditTableFilter ? auditTableFilter.value.trim() : '';
      let url = `/api/audit?limit=${auditLimit}&offset=${auditOffset}`;
      if (table) url += `&table=${encodeURIComponent(table)}`;

      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 403) {
          document.getElementById('audit-tbody').innerHTML =
            '<tr><td colspan="6" style="text-align:center; color:#94a3b8;">Restricted to Admin role.</td></tr>';
        }
        return;
      }

      const data = await res.json();
      const entries = data.entries || [];
      const total = data.total || 0;

      const tbody = document.getElementById('audit-tbody');
      if (!tbody) return;

      if (entries.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No audit records found.</td></tr>';
      } else {
        tbody.innerHTML = entries
          .map((e) => {
            const time = new Date(e.created_at).toLocaleString();
            const actor = e.actor_email || `User #${e.changed_by || 'System'}`;
            const details = e.new_data ? JSON.stringify(e.new_data).slice(0, 80) : '—';

            return `
              <tr>
                <td><small>${time}</small></td>
                <td><code>${escapeHtml(e.table_name)}</code></td>
                <td>${e.record_id || '—'}</td>
                <td><span class="badge badge-role">${escapeHtml(e.action)}</span></td>
                <td>${escapeHtml(actor)}</td>
                <td><small style="font-family:monospace;">${escapeHtml(details)}</small></td>
              </tr>
            `;
          })
          .join('');
      }

      const countInfo = document.getElementById('audit-count-info');
      if (countInfo) {
        const start = entries.length > 0 ? auditOffset + 1 : 0;
        const end = auditOffset + entries.length;
        countInfo.textContent = `Showing ${start}–${end} of ${total} entries`;
      }

      if (btnAuditPrev) btnAuditPrev.disabled = auditOffset === 0;
      if (btnAuditNext) btnAuditNext.disabled = auditOffset + entries.length >= total;
    } catch (err) {
      console.error('Failed to load audit log:', err);
    }
  }

  // Password Rotation Form
  const passwordForm = document.getElementById('password-form');
  if (passwordForm) {
    passwordForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const current_password = document.getElementById('current_password').value;
      const new_password = document.getElementById('new_password').value;
      const confirm_password = document.getElementById('confirm_password').value;

      if (new_password !== confirm_password) {
        showAlert('New password and confirmation do not match.', true);
        return;
      }

      try {
        const res = await fetch('/api/auth/password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ current_password, new_password }),
        });

        const data = await res.json();
        if (!res.ok) {
          showAlert(data.error || 'Failed to update password.', true);
          return;
        }

        alert('Password changed successfully! You will now be redirected to log in again.');
        window.location.href = 'index.html';
      } catch (err) {
        showAlert('Network error updating password.', true);
      }
    });
  }

  // Global Refresh Routine
  async function refreshAll() {
    await Promise.all([loadSummary(), loadFeasibility(), loadCoverage(), loadWorkload()]);
    if (lastUpdatedEl) {
      lastUpdatedEl.textContent = new Date().toLocaleTimeString();
    }
  }

  if (btnManualRefresh) {
    btnManualRefresh.addEventListener('click', () => {
      refreshAll();
      showAlert('Dashboard refreshed.');
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Initial Load
  checkAuth().then((authenticated) => {
    if (authenticated) {
      refreshAll();
      // Setup 60s background polling
      pollTimer = setInterval(refreshAll, 60000);
    }
  });

  window.addEventListener('beforeunload', () => {
    if (pollTimer) clearInterval(pollTimer);
  });
});
