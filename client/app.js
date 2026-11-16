'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const loginSection = document.getElementById('login-section');
  const dashboardSection = document.getElementById('dashboard-section');
  const loginForm = document.getElementById('login-form');
  const loginError = document.getElementById('login-error');
  const loginBtn = document.getElementById('login-btn');
  const logoutBtn = document.getElementById('logout-btn');

  const userFullname = document.getElementById('user-fullname');
  const userEmail = document.getElementById('user-email');
  const userRole = document.getElementById('user-role');
  const userAvatar = document.getElementById('user-avatar');

  function showError(message) {
    loginError.textContent = message;
    loginError.style.display = 'block';
  }

  function hideError() {
    loginError.textContent = '';
    loginError.style.display = 'none';
  }

  function setAuthenticatedView(user) {
    loginSection.style.display = 'none';
    dashboardSection.style.display = 'block';

    userFullname.textContent = user.fullName || 'User';
    userEmail.textContent = user.email || '';
    userRole.textContent = user.role || 'Member';
    userAvatar.textContent = (user.fullName || user.email || 'U').charAt(0).toUpperCase();
  }

  function setUnauthenticatedView() {
    dashboardSection.style.display = 'none';
    loginSection.style.display = 'block';
    loginForm.reset();
    hideError();
  }

  // Check current auth status on load
  async function checkAuth() {
    try {
      const response = await fetch('/api/auth/me', {
        headers: { Accept: 'application/json' },
      });
      if (response.ok) {
        const data = await response.json();
        if (data.user) {
          setAuthenticatedView(data.user);
          return;
        }
      }
      setUnauthenticatedView();
    } catch {
      setUnauthenticatedView();
    }
  }

  // Handle Login
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();

    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    if (!email || !password) {
      showError('Please provide both email and password.');
      return;
    }

    loginBtn.disabled = true;
    loginBtn.querySelector('.btn-text').textContent = 'Authenticating...';

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      if (!response.ok) {
        showError(data.error || 'Authentication failed. Please verify credentials.');
      } else {
        setAuthenticatedView(data.user);
      }
    } catch {
      showError('Unable to connect to the server. Please check your network connection.');
    } finally {
      loginBtn.disabled = false;
      loginBtn.querySelector('.btn-text').textContent = 'Sign In';
    }
  });

  // Handle Logout
  logoutBtn.addEventListener('click', async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
    } finally {
      setUnauthenticatedView();
    }
  });

  // Initialize
  checkAuth();
});
