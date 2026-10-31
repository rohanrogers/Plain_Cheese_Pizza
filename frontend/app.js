// ============================================================================
// Brightloop Software Subscription Management System (Make-A-Ton 9.0 Odoo Track)
// Live Transactional ERP Client Controller (SQLite WAL Engine on Port 8001)
// ============================================================================


// ============================================================================
// CURRENCY BRIDGE: BigInteger Cents <-> Decimal Dollar Formatting
// ============================================================================
function formatMoney(amountInCents) {
  if (amountInCents === null || amountInCents === undefined || isNaN(amountInCents)) return "$0.00";
  const num = Number(amountInCents);
  // Backend stores BigInteger cents (120000 = $1,200.00)
  const dollars = num / 100;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(dollars);
}

function parseMoneyToCents(dollarInput) {
  if (typeof dollarInput === 'number') {
    return Math.round(dollarInput * 100);
  }
  const clean = String(dollarInput).replace(/[^0-9.-]/g, '');
  const parsed = parseFloat(clean) || 0;
  return Math.round(parsed * 100);
}

// DOM & Identity Helpers for teammate 2FA flow (identity.js)
function $(id) {
  return document.getElementById(id);
}

function text(id, val) {
  const el = $(id);
  if (el) el.textContent = val;
}

function html(id, val) {
  const el = $(id);
  if (el) el.innerHTML = val;
}

async function post(path, body) {
  const url = path.startsWith("/api") ? path : `${API_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
  const res = await authFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || "Request failed");
  }
  return res.json();
}

function loginSuccess() {
  localStorage.setItem("brightloop_user", JSON.stringify(currentUser));
  const loginView = document.getElementById("view-login");
  if (loginView) loginView.style.display = "none";
  updateUserNavbarDisplay();
  refreshAllLiveERPData();
  showOdooToast("✓ Verified and signed in successfully!", "success");
}

const API_BASE = (window.location.origin && !window.location.origin.includes(":8001") && window.location.protocol.startsWith("http")) ? "/api" : "http://127.0.0.1:8001/api";

let isMockMode = false;
let currentSubscription = null;
let currentInvoice = null;
let odooChartInstance = null;
let dashMrrChartInstance = null;
let dashPlansChartInstance = null;
let currentActiveView = "dashboard";

// Cache for live backend records
let liveSubscriptions = [];
let liveInvoices = [];
let liveProducts = [];
let liveTemplates = [];
let liveCustomers = [];
let liveMetrics = null;

// User Session & RBAC
let currentUser = {
  id: null,
  full_name: "Marc Demo",
  role: "ADMIN",
  email: "admin@brightloop.com",
  company_name: "Brightloop Systems Inc."
};
let sessionToken = null;

// Auth Fetch Helper (Injects Bearer Token)
async function authFetch(url, options = {}) {
  const headers = options.headers || {};
  if (sessionToken) {
    headers["Authorization"] = `Bearer ${sessionToken}`;
    headers["X-Auth-Token"] = sessionToken;
  }
  return fetch(url, { ...options, headers });
}

// ----------------------------------------------------------------------------
// INITIALIZATION
// ----------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", async () => {
  // Restore saved session if exists
  const savedUser = localStorage.getItem("brightloop_user");
  const savedToken = localStorage.getItem("brightloop_token");

  if (savedUser && savedToken) {
    try {
      currentUser = JSON.parse(savedUser);
      sessionToken = savedToken;
      updateUserNavbarDisplay();
    } catch (e) {
      console.warn("Failed to parse saved user session", e);
    }
  }

  // Set today's date in date inputs
  const todayStr = new Date().toISOString().split("T")[0];
  const billingDateInput = document.getElementById("billing-target-date");
  if (billingDateInput) billingDateInput.value = todayStr;

  const paymentDateInput = document.getElementById("modal-payment-date");
  if (paymentDateInput) paymentDateInput.value = todayStr;

  // Verify backend connectivity and load live data
  await verifyBackendConnectivity();
  await refreshAllLiveERPData();

  // Close dropdowns on outside click
  document.addEventListener("click", (e) => {
    const userMenu = document.getElementById("o-user-menu");
    const userPill = document.querySelector(".o_user_pill");
    if (userMenu && userPill && !userPill.contains(e.target)) {
      userMenu.classList.remove("show");
    }
  });

  // Apply RBAC UI gates
  applyRoleGating();

  // Route to initial view based on role
  if (currentUser.role === "CUSTOMER") {
    navigateTo("portal");
  } else {
    navigateTo("dashboard");
  }
});

// ----------------------------------------------------------------------------
// 1. BACKEND CONNECTIVITY & LIVE REFRESH
// ----------------------------------------------------------------------------
async function verifyBackendConnectivity() {
  const badge = document.getElementById("backend-status-badge");
  const badgeText = document.getElementById("backend-status-text");

  try {
    const t0 = performance.now();
    const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(2000) });
    const t1 = performance.now();
    const latency = Math.round(t1 - t0);

    if (!res.ok) throw new Error("Backend error");
    const health = await res.json();
    isMockMode = false;

    if (badge) badge.style.background = "rgba(0,0,0,0.25)";
    if (badgeText) {
      badgeText.innerHTML = `Port 8001 Live (<span id="sla-val">${latency}ms</span>)`;
    }
    console.log(`✓ Connected to live FastAPI SQLite WAL backend. Database has ${health.subscriptions_count} subscriptions.`);
  } catch (err) {
    isMockMode = false; // Always prefer attempting live API requests
    if (badge) badge.style.background = "rgba(245, 158, 11, 0.25)";
    if (badgeText) {
      badgeText.innerHTML = `Backend Connecting...`;
    }
    console.warn("Backend on port 8001 initializing...", err);
  }
}

async function refreshAllLiveERPData() {
  await Promise.all([
    fetchLiveMetrics(),
    fetchLiveSubscriptions(),
    fetchLiveInvoices(),
    fetchLiveProducts(),
    fetchLiveQuotationTemplates()
  ]);
}

// ----------------------------------------------------------------------------
// 2. DATA LOADERS (Live SQLite WAL Transactions)
// ----------------------------------------------------------------------------
async function fetchLiveMetrics() {
  try {
    const res = await authFetch(`${API_BASE}/analytics/dashboard`);
    if (res.ok) {
      liveMetrics = await res.json();
      renderDashboardWithData(liveMetrics);
    }
  } catch (e) {
    console.error("Failed to fetch dashboard metrics", e);
  }
}

async function fetchLiveSubscriptions() {
  try {
    const res = await authFetch(`${API_BASE}/subscriptions`);
    if (res.ok) {
      liveSubscriptions = await res.json();
      renderSubscriptionsList();
      renderKanbanView();
    }
  } catch (e) {
    console.error("Failed to fetch subscriptions", e);
  }
}

async function fetchLiveInvoices() {
  try {
    const res = await authFetch(`${API_BASE}/invoices`);
    if (res.ok) {
      liveInvoices = await res.json();
      renderInvoicesList();
    }
  } catch (e) {
    console.error("Failed to fetch invoices", e);
  }
}

async function fetchLiveProducts() {
  try {
    const res = await authFetch(`${API_BASE}/products`);
    if (res.ok) {
      liveProducts = await res.json();
      renderProductsView();
    }
  } catch (e) {
    console.error("Failed to fetch products", e);
  }
}

async function fetchLiveQuotationTemplates() {
  try {
    const res = await authFetch(`${API_BASE}/quotation-templates`);
    if (res.ok) {
      liveTemplates = await res.json();
      populateQuotationTemplateDropdown();
    }
  } catch (e) {
    console.error("Failed to fetch quotation templates", e);
  }
}

// ----------------------------------------------------------------------------
// 3. PHASE 1: AUTHENTICATION, PASSWORD COMPLEXITY & RBAC
// ----------------------------------------------------------------------------
function switchAuthTab(tab) {
  const tabs = ["login", "register", "forgot"];
  tabs.forEach(t => {
    const tabEl = document.getElementById(`tab-auth-${t}`);
    const panelEl = document.getElementById(`auth-panel-${t}`);
    if (tabEl) tabEl.classList.toggle("active", t === tab);
    if (panelEl) panelEl.style.display = t === tab ? "block" : "none";
  });

  // Clear messages
  const loginErr = document.getElementById("login-error-msg");
  const regErr = document.getElementById("reg-error-msg");
  const regSucc = document.getElementById("reg-success-msg");
  const forgotErr = document.getElementById("forgot-error-msg");
  if (loginErr) loginErr.style.display = "none";
  if (regErr) regErr.style.display = "none";
  if (regSucc) regSucc.style.display = "none";
  if (forgotErr) forgotErr.style.display = "none";
}

function validateLivePasswordHints(pwd) {
  const hasLen = pwd.length > 8;
  const hasUpper = /[A-Z]/.test(pwd);
  const hasLower = /[a-z]/.test(pwd);
  const hasSpecial = /[!@#$%^&*(),.?":{}|<>]/.test(pwd);

  updateHintStatus("hint-len", hasLen);
  updateHintStatus("hint-upper", hasUpper);
  updateHintStatus("hint-lower", hasLower);
  updateHintStatus("hint-special", hasSpecial);

  return hasLen && hasUpper && hasLower && hasSpecial;
}

function validateStaffPasswordHints(pwd) {
  const hasLen = pwd.length > 8;
  const hasUpper = /[A-Z]/.test(pwd);
  const hasLower = /[a-z]/.test(pwd);
  const hasSpecial = /[!@#$%^&*(),.?":{}|<>]/.test(pwd);

  updateHintStatus("staff-hint-len", hasLen);
  updateHintStatus("staff-hint-upper", hasUpper);
  updateHintStatus("staff-hint-lower", hasLower);
  updateHintStatus("staff-hint-special", hasSpecial);

  return hasLen && hasUpper && hasLower && hasSpecial;
}

function updateHintStatus(elId, isValid) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (isValid) {
    el.className = "pwd-hint valid";
  } else {
    el.className = "pwd-hint invalid";
  }
}

async function handleManualLogin() {
  const emailInput = document.getElementById("login-email");
  const pwdInput = document.getElementById("login-password");
  const errBox = document.getElementById("login-error-msg");
  const btn = document.getElementById("btn-manual-login");

  if (!emailInput || !pwdInput) return;
  const email = emailInput.value.trim();
  const password = pwdInput.value;

  if (!email || !password) {
    if (errBox) {
      errBox.textContent = "Please provide both email and password.";
      errBox.style.display = "block";
    }
    return;
  }

  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Authenticating...";
    }
    if (errBox) errBox.style.display = "none";

    const res = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || "Authentication failed.");
    }

    // Login successful
    sessionToken = data.token;
    currentUser = data.user;
    localStorage.setItem("brightloop_token", sessionToken);
    localStorage.setItem("brightloop_user", JSON.stringify(currentUser));

    updateUserNavbarDisplay();
    applyRoleGating();

    if (currentUser.role === "CUSTOMER") {
      navigateTo("portal");
    } else {
      navigateTo("dashboard");
    }
  } catch (err) {
    if (errBox) {
      errBox.textContent = err.message;
      errBox.style.display = "block";
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Log in to Odoo";
    }
  }
}

async function quickLogin(roleKey) {
  const credentials = {
    admin: { email: "admin@brightloop.com", password: "Admin@Brightloop123!" },
    staff: { email: "staff@brightloop.com", password: "Staff@Brightloop123!" },
    customer: { email: "customer@clientcorp.com", password: "Customer@Clientcorp123!" }
  };

  const cred = credentials[roleKey];
  if (!cred) return;

  const emailInput = document.getElementById("login-email");
  const pwdInput = document.getElementById("login-password");
  if (emailInput) emailInput.value = cred.email;
  if (pwdInput) pwdInput.value = cred.password;

  await handleManualLogin();
}

async function handleAccountRegistration() {
  const nameInput = document.getElementById("reg-name");
  const compInput = document.getElementById("reg-company");
  const emailInput = document.getElementById("reg-email");
  const pwdInput = document.getElementById("reg-password");
  const errBox = document.getElementById("reg-error-msg");
  const succBox = document.getElementById("reg-success-msg");
  const btn = document.getElementById("btn-register");

  if (!emailInput || !pwdInput) return;
  const fullName = nameInput ? nameInput.value.trim() : "New Customer";
  const companyName = compInput ? compInput.value.trim() : "Acme Corp";
  const email = emailInput.value.trim();
  const password = pwdInput.value;

  if (!validateLivePasswordHints(password)) {
    if (errBox) {
      errBox.textContent = "Password does not satisfy strict complexity requirements (length > 8, 1 uppercase, 1 lowercase, 1 special character).";
      errBox.style.display = "block";
    }
    return;
  }

  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Creating Account...";
    }
    if (errBox) errBox.style.display = "none";
    if (succBox) succBox.style.display = "none";

    const res = await fetch(`${API_BASE}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        full_name: fullName,
        company_name: companyName
      })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || "Registration failed.");
    }

    // Auto-login registered customer
    sessionToken = data.token;
    currentUser = data.user;
    localStorage.setItem("brightloop_token", sessionToken);
    localStorage.setItem("brightloop_user", JSON.stringify(currentUser));

    if (succBox) {
      succBox.textContent = `✓ Welcome, ${fullName}! Account registered successfully. Redirecting to Customer Portal...`;
      succBox.style.display = "block";
    }

    updateUserNavbarDisplay();
    applyRoleGating();

    setTimeout(() => {
      navigateTo("portal");
    }, 600);
  } catch (err) {
    if (errBox) {
      errBox.textContent = err.message;
      errBox.style.display = "block";
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Create Free Account";
    }
  }
}

async function handleForgotPassword() {
  const emailInput = document.getElementById("forgot-email");
  const errBox = document.getElementById("forgot-error-msg");
  const resBox = document.getElementById("forgot-result-box");
  const tokenVal = document.getElementById("forgot-token-val");
  const urlLink = document.getElementById("forgot-url-link");
  const btn = document.getElementById("btn-forgot-submit");

  if (!emailInput) return;
  const email = emailInput.value.trim();
  if (!email) {
    if (errBox) {
      errBox.textContent = "Please enter your registered email address.";
      errBox.style.display = "block";
    }
    return;
  }

  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Generating Token...";
    }
    if (errBox) errBox.style.display = "none";
    if (resBox) resBox.style.display = "none";

    const res = await fetch(`${API_BASE}/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Unable to reset password.");

    if (resBox && tokenVal && urlLink) {
      tokenVal.textContent = data.reset_token;
      urlLink.textContent = data.reset_url;
      urlLink.href = data.reset_url;
      resBox.style.display = "block";
    }
  } catch (err) {
    if (errBox) {
      errBox.textContent = err.message;
      errBox.style.display = "block";
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Send Reset Token";
    }
  }
}

// Staff Provisioning (ADMIN Only)
function openStaffModal() {
  const modal = document.getElementById("odoo-staff-modal");
  const errBox = document.getElementById("modal-staff-error");
  const succBox = document.getElementById("modal-staff-success");
  if (errBox) errBox.style.display = "none";
  if (succBox) succBox.style.display = "none";
  if (modal) modal.style.display = "flex";
}

function closeStaffModal() {
  const modal = document.getElementById("odoo-staff-modal");
  if (modal) modal.style.display = "none";
}

async function submitStaffProvisioning() {
  const name = document.getElementById("staff-name").value.trim();
  const company = document.getElementById("staff-company").value.trim();
  const email = document.getElementById("staff-email").value.trim();
  const password = document.getElementById("staff-password").value;
  const errBox = document.getElementById("modal-staff-error");
  const succBox = document.getElementById("modal-staff-success");
  const btn = document.getElementById("btn-provision-staff");

  if (!validateStaffPasswordHints(password)) {
    if (errBox) {
      errBox.textContent = "Password does not meet required complexity standards.";
      errBox.style.display = "block";
    }
    return;
  }

  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Provisioning...";
    }
    if (errBox) errBox.style.display = "none";
    if (succBox) succBox.style.display = "none";

    const res = await authFetch(`${API_BASE}/users/staff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        full_name: name,
        company_name: company
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Staff provisioning failed.");

    if (succBox) {
      succBox.textContent = `✓ Staff member ${data.full_name} (${data.email}) provisioned successfully!`;
      succBox.style.display = "block";
    }

    setTimeout(() => {
      closeStaffModal();
    }, 1200);
  } catch (err) {
    if (errBox) {
      errBox.textContent = err.message;
      errBox.style.display = "block";
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Provision Staff";
    }
  }
}

// Dynamic RBAC UI Gating
function applyRoleGating() {
  const role = (currentUser && currentUser.role) ? currentUser.role.toUpperCase() : "CUSTOMER";

  const appDrawerBtn = document.querySelector(".o_app_drawer_icon");
  const controlPanel = document.getElementById("odoo-control-panel");
  const portalBtn = document.querySelector(".o_portal_toggle_btn");
  const navSettings = document.getElementById("nav-settings");
  const navProducts = document.getElementById("nav-products");
  const navDashboard = document.getElementById("nav-dashboard");
  const navBilling = document.getElementById("nav-billing");
  const navPivot = document.getElementById("nav-pivot");
  const menuSettings = document.getElementById("menu-item-settings");
  const menuStaff = document.getElementById("menu-item-provision-staff");

  if (role === "CUSTOMER") {
    // CUSTOMER: Can ONLY view their own subscriptions and invoices under /my/ portal view
    if (appDrawerBtn) appDrawerBtn.style.display = "none";
    if (controlPanel) controlPanel.style.display = "none";
    if (navDashboard) navDashboard.style.display = "none";
    if (navBilling) navBilling.style.display = "none";
    if (navProducts) navProducts.style.display = "none";
    if (navPivot) navPivot.style.display = "none";
    if (navSettings) navSettings.style.display = "none";
    if (menuSettings) menuSettings.style.display = "none";
    if (menuStaff) menuStaff.style.display = "none";
    if (portalBtn) portalBtn.style.display = "none";
  } else if (role === "STAFF") {
    // STAFF: Access day-to-day operations (Quotes, Subscriptions, Invoices, Batch Billing); hide settings & staff management
    if (appDrawerBtn) appDrawerBtn.style.display = "grid";
    if (controlPanel) controlPanel.style.display = "flex";
    if (navDashboard) navDashboard.style.display = "inline-block";
    if (navBilling) navBilling.style.display = "inline-block";
    if (navProducts) navProducts.style.display = "inline-block";
    if (navPivot) navPivot.style.display = "inline-block";
    if (navSettings) navSettings.style.display = "none";
    if (menuSettings) menuSettings.style.display = "none";
    if (menuStaff) menuStaff.style.display = "none";
    if (portalBtn) portalBtn.style.display = "flex";
  } else {
    // ADMIN: Full access to everything
    if (appDrawerBtn) appDrawerBtn.style.display = "grid";
    if (controlPanel) controlPanel.style.display = "flex";
    if (navDashboard) navDashboard.style.display = "inline-block";
    if (navBilling) navBilling.style.display = "inline-block";
    if (navProducts) navProducts.style.display = "inline-block";
    if (navPivot) navPivot.style.display = "inline-block";
    if (navSettings) navSettings.style.display = "inline-block";
    if (menuSettings) menuSettings.style.display = "block";
    if (menuStaff) menuStaff.style.display = "block";
    if (portalBtn) portalBtn.style.display = "flex";
  }
}

function updateUserNavbarDisplay() {
  const nameEl = document.getElementById("user-display-name");
  const avatarEl = document.getElementById("user-avatar-initials");

  if (nameEl) nameEl.textContent = currentUser.full_name || currentUser.email;
  if (avatarEl) {
    const initials = (currentUser.full_name || currentUser.email)
      .split(" ")
      .map(p => p[0])
      .join("")
      .substring(0, 2)
      .toUpperCase();
    avatarEl.textContent = initials || "U";
  }
}

function logoutUser() {
  sessionToken = null;
  currentUser = { id: null, full_name: "Marc Demo", role: "ADMIN", email: "admin@brightloop.com" };
  localStorage.removeItem("brightloop_token");
  localStorage.removeItem("brightloop_user");

  const menu = document.getElementById("o-user-menu");
  if (menu) menu.classList.remove("show");

  navigateTo("login");
}

function toggleUserMenu(e) {
  e.stopPropagation();
  const menu = document.getElementById("o-user-menu");
  if (menu) menu.classList.toggle("show");
}

function togglePortalMode() {
  if (currentActiveView === "portal") {
    navigateTo(currentUser.role === "CUSTOMER" ? "portal" : "dashboard");
  } else {
    navigateTo("portal");
  }
}

// ----------------------------------------------------------------------------
// 4. NAVIGATION & VIEW ROUTING
// ----------------------------------------------------------------------------
function navigateTo(viewName) {
  // Gate customer from accessing backend admin views
  if (currentUser.role === "CUSTOMER" && viewName !== "login" && viewName !== "portal") {
    viewName = "portal";
  }

  currentActiveView = viewName;
  const allViews = ["login", "dashboard", "kanban", "list", "form", "invoices", "invoice-form", "billing", "products", "pivot", "settings", "portal"];

  allViews.forEach(v => {
    const el = document.getElementById(`view-${v}`);
    if (el) el.style.display = v === viewName ? "block" : "none";
  });

  const topNav = document.getElementById("odoo-top-navbar");
  const cp = document.getElementById("odoo-control-panel");
  const appTitle = document.getElementById("o-current-app-name");

  if (viewName === "login") {
    if (topNav) topNav.style.display = "none";
    if (cp) cp.style.display = "none";
    return;
  }

  if (topNav) topNav.style.display = "flex";

  if (viewName === "portal" || currentUser.role === "CUSTOMER") {
    if (cp) cp.style.display = "none";
    if (appTitle) appTitle.textContent = "Customer Portal";
    renderCustomerPortalView();
  } else {
    if (cp) cp.style.display = "flex";
  }

  // Update tabs active state
  document.querySelectorAll(".o_nav_tab").forEach(tab => {
    tab.classList.toggle("active", tab.id === `nav-${viewName}` || (viewName === "list" && tab.id === "nav-subscriptions"));
  });

  // Breadcrumbs & View Refresh
  const parentBreadcrumb = document.getElementById("cp-parent-view");
  const breadcrumbText = document.getElementById("cp-current-view");

  if (viewName === "dashboard") {
    if (appTitle) appTitle.textContent = "Subscriptions Dashboard";
    if (parentBreadcrumb) parentBreadcrumb.textContent = "Dashboard";
    if (breadcrumbText) breadcrumbText.textContent = "Executive Overview";
    fetchLiveMetrics();
  } else if (viewName === "kanban") {
    if (appTitle) appTitle.textContent = "Subscriptions";
    if (parentBreadcrumb) parentBreadcrumb.textContent = "Subscriptions";
    if (breadcrumbText) breadcrumbText.textContent = "Kanban Pipeline";
    fetchLiveSubscriptions();
  } else if (viewName === "list") {
    if (appTitle) appTitle.textContent = "Subscriptions";
    if (parentBreadcrumb) parentBreadcrumb.textContent = "Subscriptions";
    if (breadcrumbText) breadcrumbText.textContent = "All Records";
    renderSubscriptionsList();
  } else if (viewName === "form") {
    if (appTitle) appTitle.textContent = "Subscriptions";
    if (parentBreadcrumb) parentBreadcrumb.textContent = "Subscriptions";
    if (breadcrumbText) breadcrumbText.textContent = currentSubscription ? currentSubscription.subscription_number : "New Quotation";
  } else if (viewName === "invoices") {
    if (appTitle) appTitle.textContent = "Invoicing";
    if (parentBreadcrumb) parentBreadcrumb.textContent = "Accounting";
    if (breadcrumbText) breadcrumbText.textContent = "Customer Invoices";
    fetchLiveInvoices();
  } else if (viewName === "invoice-form") {
    if (appTitle) appTitle.textContent = "Invoicing";
    if (parentBreadcrumb) parentBreadcrumb.textContent = "Invoices";
    if (breadcrumbText) breadcrumbText.textContent = currentInvoice ? currentInvoice.invoice_number : "New Invoice";
  } else if (viewName === "billing") {
    if (appTitle) appTitle.textContent = "Batch Operations";
    if (parentBreadcrumb) parentBreadcrumb.textContent = "Operations";
    if (breadcrumbText) breadcrumbText.textContent = "Automated Batch Billing";
  } else if (viewName === "products") {
    if (appTitle) appTitle.textContent = "Products & Catalog";
    if (parentBreadcrumb) parentBreadcrumb.textContent = "Catalog";
    if (breadcrumbText) breadcrumbText.textContent = "Products & Pricing Variants";
    fetchLiveProducts();
  } else if (viewName === "pivot") {
    if (appTitle) appTitle.textContent = "Financial Reporting";
    if (parentBreadcrumb) parentBreadcrumb.textContent = "Reporting";
    if (breadcrumbText) breadcrumbText.textContent = "Pivot & A/R Aging Analysis";
    renderOdooAgingChart();
  } else if (viewName === "settings") {
    if (appTitle) appTitle.textContent = "Configuration";
    if (parentBreadcrumb) parentBreadcrumb.textContent = "Settings";
    if (breadcrumbText) breadcrumbText.textContent = "System & Fiscal Parameters";
  }
}

function toggleAppDrawer(e) {
  if (e) e.stopPropagation();
  const overlay = document.getElementById("o-app-drawer-overlay");
  if (overlay) overlay.classList.toggle("show");
}

function openAppFromDrawer(viewName) {
  const overlay = document.getElementById("o-app-drawer-overlay");
  if (overlay) overlay.classList.remove("show");
  navigateTo(viewName);
}

// ----------------------------------------------------------------------------
// 5. PHASE 2: DYNAMIC QUOTATION TEMPLATES & FORM SHEET
// ----------------------------------------------------------------------------
function populateQuotationTemplateDropdown() {
  const select = document.getElementById("form-template-select");
  if (!select) return;

  select.innerHTML = '<option value="">-- Manual Configuration / Custom --</option>';
  liveTemplates.forEach(t => {
    select.innerHTML += `<option value="${t.id}">${t.name} (${t.validity_days} Days Validity)</option>`;
  });
}

function handleTemplateSelection(templateId) {
  if (!templateId) return;

  const tmpl = liveTemplates.find(t => t.id === templateId);
  if (!tmpl) return;

  const validityEl = document.getElementById("form-validity-days");
  if (validityEl) validityEl.textContent = `${tmpl.validity_days} Days`;

  // Populate line items table
  const linesTbody = document.getElementById("form-lines-tbody");
  let subtotal = 0;

  if (linesTbody) {
    linesTbody.innerHTML = "";
    tmpl.lines.forEach(line => {
      const prod = liveProducts.find(p => p.id === line.product_id);
      const prodName = prod ? prod.name : "Enterprise Cloud Service";
      let variantName = "Standard Configuration";
      if (line.variant_id && prod) {
        const v = prod.variants.find(vr => vr.id === line.variant_id);
        if (v) variantName = `${v.attribute_name}: ${v.attribute_value} (+ $${v.price_modifier.toFixed(2)})`;
      }

      const lineTotal = line.quantity * line.unit_price;
      subtotal += lineTotal;

      linesTbody.innerHTML += `
        <tr>
          <td style="font-weight: 600;">${prodName}</td>
          <td><span class="o_tag o_tag_purple">${variantName}</span></td>
          <td>${line.quantity.toFixed(2)}</td>
          <td>$${line.unit_price.toFixed(2)}</td>
          <td>18% GST</td>
          <td style="text-align: right; font-weight: 700;">$${lineTotal.toFixed(2)}</td>
        </tr>
      `;
    });
  }

  const tax = subtotal * 0.18;
  const total = subtotal + tax;

  const subEl = document.getElementById("form-subtotal");
  const taxEl = document.getElementById("form-tax");
  const totEl = document.getElementById("form-total");
  if (subEl) subEl.textContent = `$${subtotal.toFixed(2)}`;
  if (taxEl) taxEl.textContent = `$${tax.toFixed(2)}`;
  if (totEl) totEl.textContent = `$${total.toFixed(2)}`;
}

function createNewQuotation() {
  currentSubscription = null;

  const numEl = document.getElementById("form-doc-number");
  const custRow = document.getElementById("form-customer-select-row");
  const custDisp = document.getElementById("form-customer-display-row");
  const tmplSelect = document.getElementById("form-template-select");

  if (numEl) numEl.textContent = "New Quotation (Draft)";
  if (custRow) custRow.style.display = "flex";
  if (custDisp) custDisp.style.display = "none";
  if (tmplSelect) tmplSelect.value = liveTemplates.length > 0 ? liveTemplates[0].id : "";

  // Populate customer dropdown if empty
  const custSelect = document.getElementById("form-customer-select");
  if (custSelect && custSelect.options.length === 0) {
    custSelect.innerHTML = `
      <option value="test-customer-001">ClientCorp International (Aaron Alex Mathew)</option>
      <option value="test-customer-002">Apex Logistics Ltd</option>
      <option value="test-customer-003">FinTech Global Services</option>
    `;
  }

  if (tmplSelect && tmplSelect.value) {
    handleTemplateSelection(tmplSelect.value);
  }

  updateFormStatusRibbon("DRAFT");
  navigateTo("form");
}

function loadSubscriptionToForm(sub) {
  if (!sub) return;
  currentSubscription = sub;

  const numEl = document.getElementById("form-doc-number");
  const custDisp = document.getElementById("form-customer-name");
  const custRow = document.getElementById("form-customer-select-row");
  const custDispRow = document.getElementById("form-customer-display-row");
  const planEl = document.getElementById("form-plan-name");
  const startEl = document.getElementById("form-start-date");
  const nextEl = document.getElementById("form-next-billing");
  const mrrEl = document.getElementById("stat-mrr-val");

  const subNum = sub.number || sub.subscription_number || `SUB-${sub.id.substring(0, 8)}`;
  const subState = sub.state || sub.status || "DRAFT";
  const startDate = sub.starts_on || sub.start_date || "-";
  const nextBilling = sub.next_billing_date || "-";
  const totalCents = sub.estimate ? sub.estimate.total : (sub.total_recurring_amount || 0);

  if (numEl) numEl.textContent = subNum;
  if (custDisp) custDisp.textContent = sub.customer_name || `Account #${sub.customer_id.substring(0, 8)}`;
  if (custRow) custRow.style.display = "none";
  if (custDispRow) custDispRow.style.display = "flex";
  if (planEl) planEl.textContent = sub.plan_name || "Enterprise Annual Plan";
  if (startEl) startEl.textContent = startDate;
  if (nextEl) nextEl.textContent = nextBilling;
  if (mrrEl) mrrEl.textContent = formatMoney(totalCents);

  updateFormStatusRibbon(subState);

  // Reset coupon input
  const discInput = document.getElementById("form-discount-code");
  const discIcon = document.getElementById("discount-status-icon");
  if (discInput) discInput.value = sub.discount_code || "";
  if (discIcon) discIcon.textContent = sub.discount_code ? "✓ Active Coupon" : "";

  // Render lines
  const linesTbody = document.getElementById("form-lines-tbody");
  let subtotal = 0;
  if (linesTbody) {
    linesTbody.innerHTML = "";
    const lines = sub.lines || [];
    if (lines.length === 0) {
      subtotal = sub.total_recurring_amount;
      linesTbody.innerHTML = `
        <tr>
          <td style="font-weight: 600;">Brightloop Enterprise ERP</td>
          <td><span class="o_badge_odoo">Brand: Odoo (+ $560.00)</span></td>
          <td>1.00</td>
          <td>$${sub.total_recurring_amount.toFixed(2)}</td>
          <td>18% GST</td>
          <td style="text-align: right; font-weight: 700;">$${sub.total_recurring_amount.toFixed(2)}</td>
        </tr>
      `;
    } else {
      lines.forEach(l => {
        const prod = liveProducts.find(p => p.id === l.product_id);
        const prodName = prod ? prod.name : "Enterprise Cloud Service";
        let variantDesc = "Standard Configuration";
        if (prod && l.variant_id) {
          const v = prod.variants.find(vr => vr.id === l.variant_id);
          if (v) {
            const isOdoo = v.attribute_value && v.attribute_value.toLowerCase().includes("odoo");
            variantDesc = `${isOdoo ? '★ ' : ''}${v.attribute_name}: ${v.attribute_value} (+ $${v.price_modifier.toFixed(2)})`;
          }
        }
        subtotal += l.line_total;
        linesTbody.innerHTML += `
          <tr>
            <td style="font-weight: 600;">${prodName}</td>
            <td><span class="o_tag ${variantDesc.includes('Odoo') ? 'o_badge_odoo' : 'o_tag_teal'}">${variantDesc}</span></td>
            <td>${l.quantity.toFixed(2)}</td>
            <td>$${l.unit_price_frozen.toFixed(2)}</td>
            <td>18% GST</td>
            <td style="text-align: right; font-weight: 700;">$${l.line_total.toFixed(2)}</td>
          </tr>
        `;
      });
    }
  }

  const tax = subtotal * 0.18;
  const total = subtotal + tax;
  const subEl = document.getElementById("form-subtotal");
  const taxEl = document.getElementById("form-tax");
  const totEl = document.getElementById("form-total");

  if (subEl) subEl.textContent = `$${subtotal.toFixed(2)}`;
  if (taxEl) taxEl.textContent = `$${tax.toFixed(2)}`;
  if (totEl) totEl.textContent = `$${total.toFixed(2)}`;
}

// ----------------------------------------------------------------------------
// 6. PHASE 3 & TRANSITIONS (DRAFT -> QUOTATION -> CONFIRMED -> ACTIVE -> CLOSED)
// ----------------------------------------------------------------------------
function updateFormStatusRibbon(status) {
  const steps = ["draft", "quotation", "confirmed", "active", "closed"];
  const currentStatusUpper = (status || "DRAFT").toUpperCase();

  steps.forEach(s => {
    const el = document.getElementById(`status-step-${s}`);
    if (el) {
      el.className = "o_arrow_button";
      if (s === currentStatusUpper.toLowerCase()) {
        el.classList.add("o_arrow_active");
        if (currentStatusUpper === "CONFIRMED") el.classList.add("o_arrow_confirmed");
        if (currentStatusUpper === "ACTIVE") el.classList.add("o_arrow_in_progress");
      }
    }
  });

  // Action buttons visibility
  const btnQuote = document.getElementById("form-btn-quote");
  const btnConfirm = document.getElementById("form-btn-confirm");
  const btnActivate = document.getElementById("form-btn-activate");
  const btnInvoice = document.getElementById("form-btn-invoice");
  const btnClose = document.getElementById("form-btn-close");
  const btnCancel = document.getElementById("form-btn-cancel");

  if (btnQuote) btnQuote.style.display = (currentStatusUpper === "DRAFT") ? "inline-flex" : "none";
  if (btnConfirm) btnConfirm.style.display = (currentStatusUpper === "QUOTATION") ? "inline-flex" : "none";
  if (btnActivate) btnActivate.style.display = (currentStatusUpper === "CONFIRMED") ? "inline-flex" : "none";
  if (btnInvoice) btnInvoice.style.display = (currentStatusUpper === "ACTIVE") ? "inline-flex" : "none";
  if (btnClose) btnClose.style.display = (currentStatusUpper === "ACTIVE") ? "inline-flex" : "none";
  if (btnCancel) btnCancel.style.display = (currentStatusUpper !== "CLOSED" && currentStatusUpper !== "CANCELLED") ? "inline-flex" : "none";

  // Expiration Warning Banner
  const expAlert = document.getElementById("form-expiration-alert");
  const expDateVal = document.getElementById("form-expiration-date-val");
  const todayStr = new Date().toISOString().split("T")[0];
  let isExpired = false;

  if (currentSubscription && currentSubscription.expiration_date) {
    if (currentSubscription.expiration_date < todayStr) {
      isExpired = true;
      if (expDateVal) expDateVal.textContent = currentSubscription.expiration_date;
      if (expAlert && (currentStatusUpper === "DRAFT" || currentStatusUpper === "QUOTATION")) {
        expAlert.style.display = "block";
      } else if (expAlert) {
        expAlert.style.display = "none";
      }
    } else if (expAlert) {
      expAlert.style.display = "none";
    }
  } else if (expAlert) {
    expAlert.style.display = "none";
  }

  if (btnConfirm) {
    if (isExpired && currentStatusUpper === "QUOTATION") {
      btnConfirm.disabled = true;
      btnConfirm.title = `Quotation expired on ${currentSubscription.expiration_date}. Confirmation is blocked.`;
      btnConfirm.style.opacity = "0.6";
      btnConfirm.style.cursor = "not-allowed";
    } else {
      btnConfirm.disabled = false;
      btnConfirm.title = "";
      btnConfirm.style.opacity = "1";
      btnConfirm.style.cursor = "pointer";
    }
  }
}

async function actionTransitionQuote() {
  if (!currentSubscription) {
    showOdooToast("Please create or select a quotation first.", "warning");
    return;
  }
  const btn = document.getElementById("form-btn-quote");
  const origText = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-inline"></span> Freezing Pricing...`;
  }
  try {
    const res = await authFetch(`${API_BASE}/subscriptions/${currentSubscription.id}/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "QUOTE" })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Failed to send quotation.");
    currentSubscription = data;
    loadSubscriptionToForm(data);
    await fetchLiveSubscriptions();
    showOdooToast(`✓ Quotation #${data.subscription_number} generated! Line item pricing frozen.`, "success");
  } catch (err) {
    showOdooToast(`Transition Error: ${err.message}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText || "Send Quotation";
    }
  }
}

async function actionTransitionConfirm() {
  const btn = document.getElementById("form-btn-confirm");
  const origText = btn ? btn.innerHTML : "";

  // If drafting from template
  if (!currentSubscription) {
    const tmplSelect = document.getElementById("form-template-select");
    const tmplId = tmplSelect ? tmplSelect.value : (liveTemplates[0] ? liveTemplates[0].id : null);
    const discCode = document.getElementById("form-discount-code") ? document.getElementById("form-discount-code").value.trim() : null;

    if (!tmplId) {
      showOdooToast("Please select a Quotation Template first.", "warning");
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner-inline"></span> Creating from Template...`;
    }
    try {
      let custId = currentUser.id;
      if (!custId) {
        custId = liveSubscriptions[0] ? liveSubscriptions[0].customer_id : "test-customer-001";
      }
      const res = await authFetch(`${API_BASE}/subscriptions/from-template/${tmplId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_id: custId, discount_code: discCode || null })
      });
      const newSub = await res.json();
      if (!res.ok) throw new Error(newSub.detail || "Failed to create subscription from template.");
      currentSubscription = newSub;
      loadSubscriptionToForm(newSub);
      showOdooToast(`✓ Subscription #${newSub.subscription_number} created in DRAFT status!`, "success");
      
      // Auto-transition DRAFT -> QUOTATION
      await actionTransitionQuote();
      return;
    } catch (err) {
      showOdooToast(`Template Error: ${err.message}`, "error");
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = origText || "Confirm Quotation";
      }
      return;
    }
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-inline"></span> Confirming Quote...`;
  }
  try {
    const res = await authFetch(`${API_BASE}/subscriptions/${currentSubscription.id}/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "CONFIRM" })
    });
    const updated = await res.json();
    if (!res.ok) throw new Error(updated.detail || "Quotation confirmation failed.");
    currentSubscription = updated;
    loadSubscriptionToForm(updated);
    await fetchLiveSubscriptions();
    showOdooToast(`✓ Quotation #${updated.subscription_number} confirmed! Ready for activation.`, "success");
  } catch (err) {
    showOdooToast(`Confirmation Blocked: ${err.message}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText || "Confirm Quotation";
    }
  }
}

async function actionTransitionActivate() {
  if (!currentSubscription) return;
  const btn = document.getElementById("form-btn-activate");
  const origText = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-inline"></span> Activating Contract...`;
  }
  try {
    const res = await authFetch(`${API_BASE}/subscriptions/${currentSubscription.id}/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "ACTIVATE" })
    });
    const updated = await res.json();
    if (!res.ok) throw new Error(updated.detail || "Contract activation failed.");
    currentSubscription = updated;
    loadSubscriptionToForm(updated);
    await fetchLiveSubscriptions();
    showOdooToast(`✓ Contract #${updated.subscription_number} is now ACTIVE! Start date and billing cadence set.`, "success");
  } catch (err) {
    showOdooToast(`Activation Failed: ${err.message}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText || "Activate Contract";
    }
  }
}

async function actionTransitionClose() {
  if (!currentSubscription) return;
  const btn = document.getElementById("form-btn-close");
  const origText = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-inline"></span> Closing Contract...`;
  }
  try {
    const res = await authFetch(`${API_BASE}/subscriptions/${currentSubscription.id}/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "CLOSE" })
    });
    const updated = await res.json();
    if (!res.ok) throw new Error(updated.detail || "Subscription closure failed.");
    currentSubscription = updated;
    loadSubscriptionToForm(updated);
    await fetchLiveSubscriptions();
    showOdooToast(`✓ Subscription #${updated.subscription_number} closed.`, "info");
  } catch (err) {
    showOdooToast(`Closure Failed: ${err.message}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText || "Close Subscription";
    }
  }
}

function confirmActiveSubscription() {
  actionTransitionConfirm();
}

// ----------------------------------------------------------------------------
// MODULE 5: ADVANCED DISCOUNT & PROMOTION RULE ENGINE
// ----------------------------------------------------------------------------
let currentDiscountData = null;

async function handleDiscountInput(code) {
  const codeClean = (code || "").trim().toUpperCase();
  const statusIcon = document.getElementById("discount-status-icon");
  const linesTbody = document.getElementById("form-lines-tbody");
  const subEl = document.getElementById("form-subtotal");
  const taxEl = document.getElementById("form-tax");
  const totEl = document.getElementById("form-total");

  // Remove existing discount lines if present
  if (linesTbody) {
    const existing = linesTbody.querySelectorAll(".o_discount_tr");
    existing.forEach(el => el.remove());
  }

  // Calculate current subtotal from non-discount lines
  let untaxedTotal = 0;
  let totalQty = 0;
  if (linesTbody) {
    const rows = linesTbody.querySelectorAll("tr:not(.o_discount_tr)");
    rows.forEach(r => {
      const cells = r.querySelectorAll("td");
      if (cells.length >= 6) {
        const qty = parseFloat(cells[2].textContent) || 1;
        const lineTotal = parseFloat(cells[5].textContent.replace(/[^0-9.-]+/g, "")) || 0;
        untaxedTotal += lineTotal;
        totalQty += qty;
      }
    });
  }

  if (untaxedTotal === 0 && currentSubscription) {
    untaxedTotal = currentSubscription.total_recurring_amount / 1.18;
    totalQty = 1;
  }

  if (!codeClean) {
    currentDiscountData = null;
    if (statusIcon) statusIcon.textContent = "";
    const tax = untaxedTotal * 0.18;
    const total = untaxedTotal + tax;
    if (subEl) animateNumber(subEl, parseFloat(subEl.textContent.replace(/[^0-9.-]+/g, "")) || 0, untaxedTotal);
    if (taxEl) animateNumber(taxEl, parseFloat(taxEl.textContent.replace(/[^0-9.-]+/g, "")) || 0, tax);
    if (totEl) animateNumber(totEl, parseFloat(totEl.textContent.replace(/[^0-9.-]+/g, "")) || 0, total);
    return;
  }

  if (statusIcon) {
    statusIcon.innerHTML = `<span class="spinner-inline" style="width:10px;height:10px;border-width:2px;border-top-color:var(--odoo-primary);"></span> Validating...`;
  }

  try {
    const res = await authFetch(`${API_BASE}/discounts/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: codeClean,
        subtotal: untaxedTotal,
        total_qty: Math.max(1, Math.round(totalQty))
      })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || "Invalid coupon.");
    }

    currentDiscountData = data;
    if (statusIcon) {
      statusIcon.innerHTML = `<span style="color: var(--odoo-success);">✓ -$${data.discount_amount.toFixed(2)}</span>`;
    }

    // Inject animated green discount line in order lines table
    if (linesTbody) {
      const discountRow = document.createElement("tr");
      discountRow.className = "o_discount_tr";
      discountRow.innerHTML = `
        <td style="font-weight: 700; color: #166534;">🏷️ Coupon: ${data.code}</td>
        <td><span class="o_tag o_tag_green">Promotion (-${data.value}${data.discount_type === 'PERCENTAGE' ? '%' : '$'})</span></td>
        <td>1.00</td>
        <td>-$${data.discount_amount.toFixed(2)}</td>
        <td>Exempt</td>
        <td style="text-align: right; font-weight: 700; color: #16A34A;">-$${data.discount_amount.toFixed(2)}</td>
      `;
      linesTbody.appendChild(discountRow);
    }

    // Animate subtotal and total balance rolling down
    const newUntaxed = Math.max(0, untaxedTotal - data.discount_amount);
    const newTax = newUntaxed * 0.18;
    const newTotal = newUntaxed + newTax;

    const oldSub = parseFloat(subEl ? subEl.textContent.replace(/[^0-9.-]+/g, "") : 0) || untaxedTotal;
    const oldTot = parseFloat(totEl ? totEl.textContent.replace(/[^0-9.-]+/g, "") : 0) || (untaxedTotal * 1.18);

    if (subEl) animateNumber(subEl, oldSub, newUntaxed);
    if (taxEl) animateNumber(taxEl, oldSub * 0.18, newTax);
    if (totEl) animateNumber(totEl, oldTot, newTotal);

    showOdooToast(`✓ Promotion applied: ${data.code} (-$${data.discount_amount.toFixed(2)})`, "success");

  } catch (err) {
    currentDiscountData = null;
    if (statusIcon) {
      statusIcon.innerHTML = `<span style="color: var(--odoo-danger);">✕ Rejected</span>`;
    }
    const tax = untaxedTotal * 0.18;
    const total = untaxedTotal + tax;
    if (subEl) animateNumber(subEl, parseFloat(subEl.textContent.replace(/[^0-9.-]+/g, "")) || 0, untaxedTotal);
    if (taxEl) animateNumber(taxEl, parseFloat(taxEl.textContent.replace(/[^0-9.-]+/g, "")) || 0, tax);
    if (totEl) animateNumber(totEl, parseFloat(totEl.textContent.replace(/[^0-9.-]+/g, "")) || 0, total);

    showOdooToast(`HTTP 400: ${err.message}`, "error");
  }
}

// ----------------------------------------------------------------------------
// MODULE 2: PRODUCT CATALOG & DYNAMIC VARIANT SIMULATOR
// ----------------------------------------------------------------------------
let selectedCalcVariants = new Set();
let currentCalcProduct = null;

function renderProductsView() {
  const tbody = document.getElementById("odoo-products-tbody");
  if (!tbody) return;

  tbody.innerHTML = "";
  if (!liveProducts || liveProducts.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 20px; color: var(--odoo-text-muted);">No products found in catalog.</td></tr>`;
    return;
  }

  liveProducts.forEach(p => {
    const variants = p.variants || [];
    let varBadges = variants.map(v => {
      const isOdoo = v.attribute_value && v.attribute_value.toLowerCase().includes("odoo");
      const badgeClass = isOdoo ? "o_badge_odoo" : "o_tag o_tag_purple";
      const modStr = v.price_modifier >= 0 ? `+ $${v.price_modifier.toFixed(2)}` : `- $${Math.abs(v.price_modifier).toFixed(2)}`;
      const calcPrice = v.calculated_price !== undefined && v.calculated_price !== null ? v.calculated_price : (p.base_price + v.price_modifier);
      return `<div style="margin: 3px 0;">
        <span class="${badgeClass}">
          ${v.attribute_name}: ${v.attribute_value} (${modStr} = $${calcPrice.toFixed(2)})
        </span>
      </div>`;
    }).join("");

    if (!varBadges) {
      varBadges = `<span style="color: var(--odoo-text-muted); font-size: 0.8rem;">No custom variants</span>`;
    }

    const typeTag = p.type === "Service" ? "o_tag_teal" : "o_tag_purple";

    tbody.innerHTML += `
      <tr>
        <td style="font-weight: 700; color: var(--odoo-primary); font-size: 0.95rem;">
          ${p.name}
          ${p.notes ? `<div style="font-size: 0.75rem; color: var(--odoo-text-muted); font-weight: 400;">${p.notes}</div>` : ''}
        </td>
        <td><span class="o_tag ${typeTag}">${p.type || 'Service'}</span></td>
        <td style="font-weight: 700;">$${(p.sales_price || p.base_price || 0).toFixed(2)}</td>
        <td style="color: var(--odoo-text-muted);">$${(p.cost_price || 0).toFixed(2)}</td>
        <td>${varBadges}</td>
        <td style="text-align: right;">
          <button class="btn btn-secondary" style="font-size: 0.75rem; padding: 4px 10px;" onclick="openAddVariantModal('${p.id}')">
            ➕ Add Variant
          </button>
        </td>
      </tr>
    `;
  });

  populateCalcProductDropdown();
}

function populateCalcProductDropdown() {
  const select = document.getElementById("calc-product-select");
  const targetProductSelect = document.getElementById("var-target-product");

  if (select) {
    const currentVal = select.value;
    select.innerHTML = "";
    liveProducts.forEach(p => {
      select.innerHTML += `<option value="${p.id}">${p.name} ($${(p.sales_price || p.base_price).toFixed(2)})</option>`;
    });
    if (currentVal && liveProducts.some(p => p.id === currentVal)) {
      select.value = currentVal;
    } else if (liveProducts.length > 0) {
      select.value = liveProducts[0].id;
    }
  }

  if (targetProductSelect) {
    targetProductSelect.innerHTML = "";
    liveProducts.forEach(p => {
      targetProductSelect.innerHTML += `<option value="${p.id}">${p.name}</option>`;
    });
  }

  handleCalcProductChange();
}

function handleCalcProductChange() {
  const select = document.getElementById("calc-product-select");
  if (!select) return;
  const pId = select.value;
  currentCalcProduct = liveProducts.find(p => p.id === pId) || liveProducts[0];
  selectedCalcVariants.clear();

  if (!currentCalcProduct) return;

  // Auto-select Odoo variant if available
  if (currentCalcProduct.variants && currentCalcProduct.variants.length > 0) {
    const odooVar = currentCalcProduct.variants.find(v => v.attribute_value && v.attribute_value.toLowerCase().includes("odoo"));
    if (odooVar) {
      selectedCalcVariants.add(odooVar.id);
    } else {
      selectedCalcVariants.add(currentCalcProduct.variants[0].id);
    }
  }

  renderVariantCalculatorPills();
}

function renderVariantCalculatorPills() {
  const pillsContainer = document.getElementById("calc-variant-pills");
  const basePriceEl = document.getElementById("calc-base-price");
  const modifierSumEl = document.getElementById("calc-modifier-sum");
  const totalPriceEl = document.getElementById("calc-total-price");

  if (!pillsContainer || !currentCalcProduct) return;

  pillsContainer.innerHTML = "";
  const variants = currentCalcProduct.variants || [];

  if (variants.length === 0) {
    pillsContainer.innerHTML = `<span style="font-size: 0.8rem; color: var(--odoo-text-muted);">No variants available for this template. Use "+ Add Variant" to add one.</span>`;
  } else {
    variants.forEach(v => {
      const isSelected = selectedCalcVariants.has(v.id);
      const isOdoo = v.attribute_value && v.attribute_value.toLowerCase().includes("odoo");
      const modSign = v.price_modifier >= 0 ? `+ $${v.price_modifier.toFixed(2)}` : `- $${Math.abs(v.price_modifier).toFixed(2)}`;

      const pill = document.createElement("div");
      pill.className = `o_variant_pill ${isSelected ? 'active' : ''}`;
      pill.innerHTML = `
        <span>${isOdoo ? '★ ' : ''}${v.attribute_name}: ${v.attribute_value}</span>
        <span class="o_pill_mod">(${modSign})</span>
      `;
      pill.onclick = () => {
        if (selectedCalcVariants.has(v.id)) {
          selectedCalcVariants.delete(v.id);
        } else {
          selectedCalcVariants.add(v.id);
        }
        renderVariantCalculatorPills();
      };
      pillsContainer.appendChild(pill);
    });
  }

  const basePrice = currentCalcProduct.sales_price || currentCalcProduct.base_price || 0;
  let modifierSum = 0;
  selectedCalcVariants.forEach(vId => {
    const v = variants.find(vr => vr.id === vId);
    if (v) modifierSum += v.price_modifier;
  });

  const totalCalculated = Math.max(0, basePrice + modifierSum);

  if (basePriceEl) basePriceEl.textContent = `$${basePrice.toFixed(2)}`;
  if (modifierSumEl) {
    modifierSumEl.textContent = `${modifierSum >= 0 ? '+' : '-'}$${Math.abs(modifierSum).toFixed(2)}`;
    modifierSumEl.style.color = modifierSum >= 0 ? "var(--odoo-teal)" : "var(--odoo-danger)";
  }
  if (totalPriceEl) {
    const oldVal = parseFloat(totalPriceEl.textContent.replace(/[^0-9.-]+/g, "")) || basePrice;
    animateNumber(totalPriceEl, oldVal, totalCalculated, 250);
  }
}

// Modals: Product Creation
function openCreateProductModal() {
  const modal = document.getElementById("modal-create-product");
  if (modal) modal.style.display = "flex";
}

function closeCreateProductModal() {
  const modal = document.getElementById("modal-create-product");
  if (modal) modal.style.display = "none";
}

async function submitCreateProduct() {
  const nameInput = document.getElementById("prod-new-name");
  const typeInput = document.getElementById("prod-new-type");
  const salesPriceInput = document.getElementById("prod-new-sales-price");
  const costPriceInput = document.getElementById("prod-new-cost-price");
  const notesInput = document.getElementById("prod-new-notes");
  const attrInput = document.getElementById("prod-new-var-attr");
  const valInput = document.getElementById("prod-new-var-val");
  const modInput = document.getElementById("prod-new-var-mod");
  const btn = document.getElementById("btn-save-product");

  const name = nameInput ? nameInput.value.trim() : "";
  if (!name) {
    showOdooToast("Product name is required.", "warning");
    return;
  }

  const salesPrice = parseFloat(salesPriceInput ? salesPriceInput.value : 0) || 0;
  const costPrice = parseFloat(costPriceInput ? costPriceInput.value : 0) || 0;
  const prodType = typeInput ? typeInput.value : "Service";
  const notes = notesInput ? notesInput.value.trim() : "";

  const variants = [];
  if (attrInput && valInput && attrInput.value.trim() && valInput.value.trim()) {
    variants.push({
      attribute_name: attrInput.value.trim(),
      attribute_value: valInput.value.trim(),
      price_modifier: parseFloat(modInput ? modInput.value : 0) || 0
    });
  }

  const origText = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-inline"></span> Saving...`;
  }

  try {
    const res = await authFetch(`${API_BASE}/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        type: prodType,
        sales_price: salesPrice,
        base_price: salesPrice,
        cost_price: costPrice,
        notes: notes || null,
        description: notes || null,
        variants
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Failed to create product.");

    closeCreateProductModal();
    if (nameInput) nameInput.value = "";
    await fetchLiveProducts();
    showOdooToast(`✓ Product '${data.name}' created successfully!`, "success");
  } catch (err) {
    showOdooToast(`Product Error: ${err.message}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText || "Save Product";
    }
  }
}

// Modals: Add Variant
function openAddVariantModal(productId) {
  const modal = document.getElementById("modal-add-variant");
  const targetSelect = document.getElementById("var-target-product");
  if (modal) modal.style.display = "flex";
  if (targetSelect && productId) targetSelect.value = productId;
}

function closeAddVariantModal() {
  const modal = document.getElementById("modal-add-variant");
  if (modal) modal.style.display = "none";
}

async function submitAddVariant() {
  const targetSelect = document.getElementById("var-target-product");
  const attrInput = document.getElementById("var-attr-name");
  const valInput = document.getElementById("var-attr-value");
  const modInput = document.getElementById("var-price-mod");
  const btn = document.getElementById("btn-save-variant");

  const productId = targetSelect ? targetSelect.value : null;
  const attrName = attrInput ? attrInput.value.trim() : "";
  const attrValue = valInput ? valInput.value.trim() : "";
  const priceMod = parseFloat(modInput ? modInput.value : 0) || 0;

  if (!productId || !attrName || !attrValue) {
    showOdooToast("Product, Attribute Name, and Attribute Value are required.", "warning");
    return;
  }

  const origText = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-inline"></span> Adding...`;
  }

  try {
    const res = await authFetch(`${API_BASE}/products/${productId}/variants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        attribute_name: attrName,
        attribute_value: attrValue,
        price_modifier: priceMod
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Failed to add variant.");

    closeAddVariantModal();
    if (attrInput) attrInput.value = "";
    if (valInput) valInput.value = "";
    await fetchLiveProducts();
    showOdooToast(`✓ Variant '${data.attribute_name}: ${data.attribute_value}' added (+ $${data.price_modifier.toFixed(2)})!`, "success");
  } catch (err) {
    showOdooToast(`Variant Error: ${err.message}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText || "Save Variant";
    }
  }
}

// ----------------------------------------------------------------------------
// TOAST NOTIFICATION & NUMBER ROLLER UTILITIES
// ----------------------------------------------------------------------------
function showOdooToast(message, type = "info", duration = 3500) {
  const container = document.getElementById("odoo-toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `o_toast ${type}`;

  const icons = {
    success: "✓",
    error: "✕",
    warning: "⚠️",
    info: "ℹ"
  };

  toast.innerHTML = `
    <span class="o_toast_icon" style="color: ${type === 'success' ? 'var(--odoo-success)' : (type === 'error' ? 'var(--odoo-danger)' : (type === 'warning' ? 'var(--odoo-warning)' : 'var(--odoo-teal)'))}; font-weight: 700;">
      ${icons[type] || 'ℹ'}
    </span>
    <span class="o_toast_body">${message}</span>
    <button class="o_toast_close" onclick="this.parentElement.remove()">✕</button>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("o_toast_dismissing");
    setTimeout(() => {
      if (toast.parentElement) toast.remove();
    }, 200);
  }, duration);
}

function animateNumber(element, startVal, endVal, durationMs = 280, prefix = "$", decimals = 2) {
  if (!element) return;
  const startTime = performance.now();
  const diff = endVal - startVal;

  function step(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / durationMs, 1);
    const ease = 1 - Math.pow(1 - progress, 3);
    const current = startVal + (diff * ease);
    element.textContent = `${prefix}${current.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
    if (progress < 1) {
      requestAnimationFrame(step);
    } else {
      element.textContent = `${prefix}${endVal.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
    }
  }
  requestAnimationFrame(step);
}

async function createSingleInvoice() {
  if (!currentSubscription) return;

  try {
    const res = await authFetch(`${API_BASE}/billing/run-billing-day`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_date: currentSubscription.next_billing_date })
    });

    const result = await res.json();
    await fetchLiveInvoices();
    await fetchLiveSubscriptions();

    alert(`✓ Billing engine executed! Generated ${result.invoices_generated} invoices in ${result.execution_time_ms.toFixed(1)}ms.`);
    navigateTo("invoices");
  } catch (err) {
    alert(`Invoice Generation Error: ${err.message}`);
  }
}

// ----------------------------------------------------------------------------
// 7. PHASE 4: PARTIAL PAYMENTS & ACCOUNTS RECEIVABLE RECONCILIATION
// ----------------------------------------------------------------------------
function openPaymentModalForActiveInvoice() {
  if (!currentInvoice) return;
  openPaymentModal(currentInvoice.id, currentInvoice.invoice_number, currentInvoice.amount_residual);
}

function openPaymentModal(invId, invNumber, outstandingAmount) {
  // Store invoice reference
  currentInvoice = liveInvoices.find(i => i.id === invId) || {
    id: invId,
    invoice_number: invNumber,
    amount_residual: outstandingAmount
  };

  const refEl = document.getElementById("modal-invoice-ref");
  const amtEl = document.getElementById("modal-invoice-amt");
  const inputAmt = document.getElementById("modal-payment-amount");
  const modal = document.getElementById("odoo-payment-modal");
  const errBox = document.getElementById("modal-payment-error");

  if (refEl) refEl.textContent = invNumber;
  if (amtEl) amtEl.textContent = `$${outstandingAmount.toFixed(2)}`;
  if (inputAmt) {
    inputAmt.value = outstandingAmount.toFixed(2);
    inputAmt.max = outstandingAmount;
  }
  if (errBox) errBox.style.display = "none";

  updateModalResidualPreview();
  if (modal) modal.style.display = "flex";
}

function closePaymentModal() {
  const modal = document.getElementById("odoo-payment-modal");
  if (modal) modal.style.display = "none";
}

function updateModalResidualPreview() {
  if (!currentInvoice) return;

  const inputAmt = document.getElementById("modal-payment-amount");
  const previewEl = document.getElementById("modal-residual-preview");
  if (!inputAmt || !previewEl) return;

  const payAmt = parseFloat(inputAmt.value) || 0.0;
  const residual = currentInvoice.amount_residual || 0.0;
  const newResidual = Math.max(0.0, residual - payAmt);

  previewEl.textContent = `$${newResidual.toFixed(2)}`;
}

async function confirmPaymentSettlement() {
  if (!currentInvoice) return;

  const inputAmt = document.getElementById("modal-payment-amount");
  const journalSelect = document.getElementById("modal-journal-select");
  const dateInput = document.getElementById("modal-payment-date");
  const notesInput = document.getElementById("modal-payment-notes");
  const errBox = document.getElementById("modal-payment-error");
  const btn = document.getElementById("btn-confirm-payment");

  const amount = parseFloat(inputAmt.value);
  const method = journalSelect ? journalSelect.value : "Bank";
  const pDate = dateInput ? dateInput.value : new Date().toISOString().split("T")[0];
  const notes = notesInput ? notesInput.value.trim() : null;

  if (isNaN(amount) || amount <= 0) {
    if (errBox) {
      errBox.textContent = "Please enter a valid payment amount greater than $0.00.";
      errBox.style.display = "block";
    }
    return;
  }

  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Processing Ledger...";
    }
    if (errBox) errBox.style.display = "none";

    const res = await authFetch(`${API_BASE}/invoices/${currentInvoice.id}/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: amount,
        payment_method: method,
        payment_date: pDate,
        notes: notes
      })
    });

    const paymentResult = await res.json();
    if (!res.ok) {
      throw new Error(paymentResult.detail || "Payment failed to settle.");
    }

    // Refresh live records & metrics
    await fetchLiveInvoices();
    await fetchLiveMetrics();

    // Reload active invoice sheet if open
    const updatedInvoice = liveInvoices.find(i => i.id === currentInvoice.id);
    if (updatedInvoice) {
      currentInvoice = updatedInvoice;
      loadInvoiceToForm(updatedInvoice);
    }

    closePaymentModal();
    alert(`✓ Payment of $${amount.toFixed(2)} recorded on ${pDate} via ${method}!\nInvoice Status: ${currentInvoice.status}\nRemaining Residual: $${currentInvoice.amount_residual.toFixed(2)}`);
  } catch (err) {
    if (errBox) {
      errBox.textContent = err.message;
      errBox.style.display = "block";
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Register Payment";
    }
  }
}

function loadInvoiceToForm(inv) {
  if (!inv) return;
  currentInvoice = inv;

  const numEl = document.getElementById("inv-form-number");
  const custEl = document.getElementById("inv-form-customer");
  const dateEl = document.getElementById("inv-form-date");
  const dueEl = document.getElementById("inv-form-due");
  const untaxedEl = document.getElementById("inv-form-untaxed");
  const taxEl = document.getElementById("inv-form-tax");
  const totalEl = document.getElementById("inv-form-total");
  const residualEl = document.getElementById("inv-form-residual");
  const payWidget = document.getElementById("inv-form-payments-widget");

  if (numEl) numEl.textContent = inv.invoice_number;
  if (custEl) custEl.textContent = inv.customer_name || `Customer #${inv.customer_id.substring(0, 8)}`;
  if (dateEl) dateEl.textContent = inv.issue_date;
  if (dueEl) dueEl.textContent = inv.due_date;
  if (untaxedEl) untaxedEl.textContent = `$${inv.subtotal.toFixed(2)}`;
  if (taxEl) taxEl.textContent = `$${inv.tax_amount.toFixed(2)}`;
  if (totalEl) totalEl.textContent = `$${inv.total_amount.toFixed(2)}`;
  if (residualEl) residualEl.textContent = `$${inv.amount_residual.toFixed(2)}`;

  // Ribbon state: Draft, Posted, Partially Paid, Paid
  const ribbons = {
    DRAFT: document.getElementById("istatus-draft"),
    POSTED: document.getElementById("istatus-posted"),
    PARTIALLY_PAID: document.getElementById("istatus-partially-paid"),
    PAID: document.getElementById("istatus-paid")
  };

  Object.values(ribbons).forEach(r => { if (r) r.className = "o_arrow_button"; });
  if (ribbons[inv.status]) ribbons[inv.status].className = "o_arrow_button current";

  // Register payment button state
  const regBtn = document.getElementById("btn-invoice-register-payment");
  if (regBtn) {
    if (inv.status === "PAID" || inv.amount_residual <= 0) {
      regBtn.disabled = true;
      regBtn.textContent = "✓ Paid";
    } else {
      regBtn.disabled = false;
      regBtn.textContent = "Register Payment";
    }
  }

  // Invoice lines
  const linesTbody = document.getElementById("inv-form-lines-tbody");
  if (linesTbody) {
    linesTbody.innerHTML = `
      <tr>
        <td style="font-weight: 600; color: var(--odoo-primary);">Brightloop Enterprise Subscription Service</td>
        <td>1.00</td>
        <td>$${inv.subtotal.toFixed(2)}</td>
        <td>18.00% GST/VAT</td>
        <td style="text-align: right; font-weight: 700;">$${inv.subtotal.toFixed(2)}</td>
      </tr>
    `;
  }

  // Odoo-style payment widget under total
  if (payWidget) {
    const paidAmt = inv.total_amount - inv.amount_residual;
    if (paidAmt > 0) {
      payWidget.style.display = "block";
      payWidget.innerHTML = `
        <div class="o_payment_widget_item">
          <strong>Paid on ${inv.issue_date} via Bank/Direct:</strong>
          <span>$${paidAmt.toFixed(2)}</span>
        </div>
        <div style="font-size: 0.75rem; color: #1B5E20;">
          Remaining Amount Due: <strong>$${inv.amount_residual.toFixed(2)}</strong>
        </div>
      `;
    } else {
      payWidget.style.display = "none";
    }
  }
}

// ----------------------------------------------------------------------------
// 8. LIST & KANBAN VIEWS (Subscriptions & Invoices)
// ----------------------------------------------------------------------------
function renderSubscriptionsList(filterStatus = "ALL") {
  const tbody = document.getElementById("subs-list-tbody");
  const countEl = document.getElementById("list-total-count");
  if (!tbody) return;

  tbody.innerHTML = "";
  const filtered = filterStatus === "ALL" 
    ? liveSubscriptions 
    : liveSubscriptions.filter(s => s.status === filterStatus);

  if (countEl) countEl.textContent = filtered.length;

  // Render top 100 for crisp rendering performance
  const displaySlice = filtered.slice(0, 100);

  displaySlice.forEach(sub => {
    const isActive = sub.status === "ACTIVE";
    const isQuotation = sub.status === "QUOTATION";
    const isClosed = sub.status === "CLOSED";
    const tagClass = isActive ? "o_tag_green" : (isQuotation ? "o_tag_teal" : (isClosed ? "o_tag_red" : "o_tag_purple"));

    tbody.innerHTML += `
      <tr onclick="loadSubscriptionToForm(liveSubscriptions.find(s => s.id === '${sub.id}')); navigateTo('form');">
        <td onclick="event.stopPropagation()"><input type="checkbox"></td>
        <td style="font-family: var(--font-mono); font-weight: 700; color: var(--odoo-primary);">${sub.subscription_number}</td>
        <td><strong>${sub.customer_name || 'Enterprise Customer'}</strong></td>
        <td>${sub.next_billing_date}</td>
        <td>${sub.plan_name || 'Standard Plan'}</td>
        <td style="font-weight: 700; color: var(--odoo-teal);">$${sub.total_recurring_amount.toFixed(2)}</td>
        <td><span class="o_tag ${tagClass}">${sub.status}</span></td>
      </tr>
    `;
  });
}

function filterListStatus(status) {
  renderSubscriptionsList(status);
}

function renderKanbanView() {
  const groups = {
    DRAFT: document.getElementById("kcards-draft"),
    QUOTATION: document.getElementById("kcards-quotation"),
    ACTIVE: document.getElementById("kcards-active"),
    CLOSED: document.getElementById("kcards-closed")
  };

  const counts = { DRAFT: 0, QUOTATION: 0, ACTIVE: 0, CLOSED: 0 };
  Object.values(groups).forEach(g => { if (g) g.innerHTML = ""; });

  liveSubscriptions.forEach((sub, idx) => {
    counts[sub.status] = (counts[sub.status] || 0) + 1;
    const targetGroup = (sub.status === "CONFIRMED") ? groups.QUOTATION : groups[sub.status];
    if (!targetGroup || targetGroup.children.length >= 25) return; // Cap kanban cards per column for crisp UI speed

    const record = document.createElement("div");
    record.className = "o_kanban_record";
    record.onclick = () => {
      currentSubscription = sub;
      loadSubscriptionToForm(sub);
      navigateTo("form");
    };

    const statusTagClass = sub.status === 'ACTIVE' ? 'o_tag_green' : (sub.status === 'CONFIRMED' ? 'o_tag_purple' : (sub.status === 'QUOTATION' ? 'o_tag_teal' : 'o_tag_purple'));
    const statusLabel = sub.status === 'CONFIRMED' ? 'CONFIRMED' : (sub.plan_name || 'Standard');

    record.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
        <span class="o_kanban_ref">${sub.subscription_number}</span>
        <span class="o_tag ${statusTagClass}">
          ${statusLabel}
        </span>
      </div>
      <div class="o_kanban_title">${sub.customer_name || 'ClientCorp Account'}</div>
      <div style="font-size: 0.8rem; color: var(--odoo-text-muted); margin-bottom: 8px;">
        Brightloop Enterprise ERP
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px dashed var(--odoo-border); padding-top: 8px; margin-top: 6px;">
        <span style="font-size: 0.75rem; color: var(--odoo-text-muted);">Next: ${sub.next_billing_date}</span>
        <span class="o_kanban_price">$${sub.total_recurring_amount.toFixed(2)}/mo</span>
      </div>
    `;

    targetGroup.appendChild(record);
  });

  if (document.getElementById("kcount-draft")) document.getElementById("kcount-draft").textContent = counts.DRAFT;
  if (document.getElementById("kcount-quotation")) document.getElementById("kcount-quotation").textContent = counts.QUOTATION;
  if (document.getElementById("kcount-active")) document.getElementById("kcount-active").textContent = counts.ACTIVE;
  if (document.getElementById("kcount-closed")) document.getElementById("kcount-closed").textContent = counts.CLOSED;
}

function renderInvoicesList(filterStatus = "ALL") {
  const tbody = document.getElementById("invoices-list-tbody");
  const countBadge = document.getElementById("invoices-count-badge");
  if (!tbody) return;

  tbody.innerHTML = "";
  const filtered = filterStatus === "ALL"
    ? liveInvoices
    : liveInvoices.filter(i => i.status === filterStatus);

  if (countBadge) countBadge.textContent = `${filtered.length} Invoices`;

  const displaySlice = filtered.slice(0, 100);

  displaySlice.forEach(inv => {
    const isPaid = inv.status === "PAID";
    const isPartiallyPaid = inv.status === "PARTIALLY_PAID";
    const isOverdue = inv.status === "OVERDUE";
    const badgeClass = isPaid ? "o_status_paid" : (isPartiallyPaid ? "o_tag_teal" : (isOverdue ? "o_status_overdue" : "o_status_posted"));

    tbody.innerHTML += `
      <tr onclick="openInvoiceDetail('${inv.id}')">
        <td style="font-family: var(--font-mono); font-weight: 700; color: var(--odoo-primary);">${inv.invoice_number}</td>
        <td><strong>${inv.customer_name || 'ClientCorp Account'}</strong></td>
        <td>${inv.issue_date}</td>
        <td>${inv.due_date}</td>
        <td style="color: var(--odoo-text-muted);">$${inv.tax_amount.toFixed(2)}</td>
        <td style="font-weight: 800; color: var(--odoo-teal); font-size: 0.95rem;">$${inv.total_amount.toFixed(2)}</td>
        <td><span class="o_status_badge ${badgeClass}">${inv.status}</span></td>
        <td>
          <button class="btn btn-secondary" style="font-size: 0.72rem; padding: 4px 8px;" onclick="event.stopPropagation(); openInvoiceDetail('${inv.id}')">
            View Sheet →
          </button>
        </td>
      </tr>
    `;
  });
}

function filterInvoicesStatus(status) {
  renderInvoicesList(status);
}

function openInvoiceDetail(invId) {
  const inv = liveInvoices.find(i => i.id === invId);
  if (!inv) return;

  currentInvoice = inv;
  loadInvoiceToForm(inv);
  navigateTo("invoice-form");
}

function simulatePrintInvoice() {
  window.print();
}

// ----------------------------------------------------------------------------
// 9. BATCH BILLING ENGINE EXECUTION
// ----------------------------------------------------------------------------
async function executeBatchBillingRun() {
  const targetDateInput = document.getElementById("billing-target-date");
  const targetDate = targetDateInput ? targetDateInput.value : new Date().toISOString().split("T")[0];
  const btn = document.getElementById("btn-trigger-billing");
  const log = document.getElementById("odoo-billing-log");

  if (!btn || !log) return;

  btn.disabled = true;
  btn.textContent = "⏳ Running Idempotent Engine...";

  const timestamp = new Date().toISOString().split("T")[1].substring(0, 8);
  log.innerHTML += `<div>[${timestamp}] ⚡ Evaluating active subscriptions matching next_billing_date &lt;= ${targetDate}...</div>`;

  try {
    const res = await authFetch(`${API_BASE}/billing/run-billing-day`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_date: targetDate })
    });

    const result = await res.json();
    if (!res.ok) throw new Error(result.detail || "Batch billing failed.");

    const billDue = document.getElementById("bill-due");
    const billGen = document.getElementById("bill-gen");
    const billSkip = document.getElementById("bill-skip");
    const billTime = document.getElementById("bill-time");

    if (billDue) billDue.textContent = result.subscriptions_evaluated.toLocaleString();
    if (billGen) billGen.textContent = result.invoices_generated.toLocaleString();
    if (billSkip) billSkip.textContent = result.duplicates_skipped.toLocaleString();
    if (billTime) billTime.textContent = `${result.execution_time_ms.toFixed(1)} ms`;

    log.innerHTML += `<div>[${timestamp}] ✓ Batch Billing Completed: ${result.invoices_generated} invoices generated in ${result.execution_time_ms.toFixed(1)}ms.</div>`;
    log.innerHTML += `<div>[${timestamp}] ✓ SHA-256 Idempotency Check: ${result.duplicates_skipped} duplicates skipped. All active cycles advanced.</div>`;
    log.scrollTop = log.scrollHeight;

    await refreshAllLiveERPData();
  } catch (err) {
    log.innerHTML += `<div style="color: #F87171;">[${timestamp}] ✕ Engine Error: ${err.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "🚀 Run Billing Day Batch";
  }
}

// ----------------------------------------------------------------------------
// 10. PRODUCTS & PRICING CATALOG VIEW
// ----------------------------------------------------------------------------
function renderProductsView() {
  const tbody = document.getElementById("odoo-products-tbody");
  if (!tbody) return;

  tbody.innerHTML = "";

  liveProducts.forEach(p => {
    if (!p.variants || p.variants.length === 0) {
      tbody.innerHTML += `
        <tr>
          <td style="font-weight: 600; color: var(--odoo-primary);">${p.name}</td>
          <td>$${p.base_price.toFixed(2)}</td>
          <td style="color: var(--odoo-text-muted);">&mdash; (Standard)</td>
          <td>&mdash;</td>
          <td style="font-weight: 700; color: var(--odoo-teal);">$${p.base_price.toFixed(2)}</td>
        </tr>
      `;
    } else {
      p.variants.forEach((v, idx) => {
        const isOdoo = v.attribute_value.includes("Odoo");
        const finalPrice = p.base_price + v.price_modifier;

        tbody.innerHTML += `
          <tr style="${isOdoo ? 'background: #FAF5F9;' : ''}">
            <td style="font-weight: 600; color: var(--odoo-primary);">${idx === 0 ? p.name : ''}</td>
            <td>${idx === 0 ? `$${p.base_price.toFixed(2)}` : ''}</td>
            <td>
              <span class="o_tag ${isOdoo ? 'o_tag_purple' : 'o_tag_teal'}" style="font-weight: 700;">
                ${v.attribute_name}: ${v.attribute_value}
              </span>
              ${isOdoo ? '<strong style="color: var(--odoo-primary); margin-left: 6px;">(Challenge Highlight +$560)</strong>' : ''}
            </td>
            <td style="font-weight: 700; color: ${v.price_modifier > 0 ? 'var(--odoo-primary)' : 'var(--odoo-text-muted)'};">
              ${v.price_modifier > 0 ? `+ $${v.price_modifier.toFixed(2)}` : '$0.00'}
            </td>
            <td style="font-weight: 700; color: var(--odoo-teal); font-size: 0.95rem;">
              $${finalPrice.toFixed(2)}
            </td>
          </tr>
        `;
      });
    }
  });
}

// ----------------------------------------------------------------------------
// 11. DASHBOARD & A/R AGING CHARTS
// ----------------------------------------------------------------------------
function renderDashboardWithData(metrics) {
  if (!metrics) return;

  const mrrEl = document.getElementById("dash-mrr-val");
  const arrEl = document.getElementById("dash-arr-val");
  const subsEl = document.getElementById("dash-subs-val");
  const churnEl = document.getElementById("dash-churn-val");
  const arEl = document.getElementById("dash-ar-val");
  const slaEl = document.getElementById("dash-sla-val");

  if (mrrEl) mrrEl.textContent = `$${metrics.mrr.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  if (arrEl) arrEl.textContent = `$${metrics.arr.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  if (subsEl) subsEl.textContent = metrics.active_subscribers_count.toLocaleString();
  if (churnEl) churnEl.textContent = `${metrics.net_churn.toFixed(1)}%`;
  if (arEl) arEl.textContent = `$${metrics.total_outstanding_ar.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  if (slaEl) slaEl.textContent = `${metrics.sla_query_latency_ms.toFixed(2)} ms`;

  const pivotMrr = document.getElementById("pivot-mrr-text");
  const pivotArr = document.getElementById("pivot-arr-text");
  const pivotSla = document.getElementById("pivot-sla-ms");
  if (pivotMrr) pivotMrr.textContent = `$${metrics.mrr.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  if (pivotArr) pivotArr.textContent = `$${metrics.arr.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  if (pivotSla) pivotSla.textContent = `${metrics.sla_query_latency_ms.toFixed(2)} ms`;

  // Render MRR Line Chart
  renderDashboardCharts(metrics);
  renderOdooAgingChart();
}

function renderDashboardCharts(metrics) {
  const mrrCtx = document.getElementById("dashMrrChart");
  const plansCtx = document.getElementById("dashPlansChart");

  if (mrrCtx) {
    if (dashMrrChartInstance) dashMrrChartInstance.destroy();
    const baseMrr = metrics.mrr;
    const history = [baseMrr * 0.85, baseMrr * 0.88, baseMrr * 0.92, baseMrr * 0.96, baseMrr * 0.98, baseMrr];

    dashMrrChartInstance = new Chart(mrrCtx, {
      type: "line",
      data: {
        labels: ["May", "Jun", "Jul", "Aug", "Sep", "Oct"],
        datasets: [{
          label: "MRR ($)",
          data: history,
          borderColor: "#714B67",
          backgroundColor: "rgba(113, 75, 103, 0.08)",
          fill: true,
          tension: 0.35,
          borderWidth: 2.5,
          pointBackgroundColor: "#00A09D",
          pointRadius: 3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false } },
          y: { grid: { color: "#F0F2F5" }, ticks: { callback: v => `$${(v / 1000).toFixed(0)}k` } }
        }
      }
    });
  }

  if (plansCtx) {
    if (dashPlansChartInstance) dashPlansChartInstance.destroy();
    dashPlansChartInstance = new Chart(plansCtx, {
      type: "doughnut",
      data: {
        labels: ["Enterprise ERP", "SLA Support", "Invoicing Engine", "Copilot Addon"],
        datasets: [{
          data: [2850, 1120, 710, 320],
          backgroundColor: ["#714B67", "#00A09D", "#339AF0", "#FD7E14"],
          borderWidth: 2,
          borderColor: "#FFFFFF"
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } } }
      }
    });
  }
}

function renderOdooAgingChart() {
  const ctx = document.getElementById("odooAgingCanvas");
  if (!ctx) return;

  if (odooChartInstance) odooChartInstance.destroy();

  const buckets = (liveMetrics && liveMetrics.aging_buckets) ? liveMetrics.aging_buckets : [
    { bucket: "Current (0-30d)", total_amount: 3929.55 },
    { bucket: "31-60d Overdue", total_amount: 1990.08 },
    { bucket: "61-90d Overdue", total_amount: 376.42 },
    { bucket: "90d+ Delinquent", total_amount: 0.00 }
  ];

  const labels = buckets.map(b => b.bucket);
  const data = buckets.map(b => b.total_amount);

  odooChartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels: labels,
      datasets: [{
        label: "Outstanding AR Balance ($)",
        data: data,
        backgroundColor: ["#00A09D", "#714B67", "#F59E0B", "#DC3545"],
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#495057", font: { family: "Roboto", weight: "500" } }, grid: { display: false } },
        y: {
          ticks: { color: "#6C757D", font: { family: "Roboto" }, callback: (val) => `$${val.toLocaleString()}` },
          grid: { color: "#E9ECEF" }
        }
      }
    }
  });
}

function retestOdooSLA() {
  const latencyEl = document.getElementById("pivot-sla-ms");
  const btnTime = document.getElementById("pivot-btn-time");
  if (latencyEl) latencyEl.textContent = "...";
  fetchLiveMetrics().then(() => {
    if (latencyEl && liveMetrics) {
      latencyEl.textContent = `${liveMetrics.sla_query_latency_ms.toFixed(2)} ms`;
      if (btnTime) btnTime.textContent = `${Math.round(liveMetrics.sla_query_latency_ms)}ms`;
    }
  });
}

// ----------------------------------------------------------------------------
// 12. CUSTOMER SELF-SERVICE PORTAL (/my/subscriptions & /my/invoices)
// ----------------------------------------------------------------------------
async function renderCustomerPortalView() {
  try {
    const [subsRes, invsRes] = await Promise.all([
      authFetch(`${API_BASE}/customer/my-subscriptions`),
      authFetch(`${API_BASE}/customer/my-invoices`)
    ]);

    const mySubs = subsRes.ok ? await subsRes.json() : [];
    const myInvs = invsRes.ok ? await invsRes.json() : [];

    // Render Portal Subscriptions
    const subsContainer = document.querySelector("#view-portal .o_table") ? document.querySelector("#view-portal") : null;
    if (subsContainer) {
      const activeSubBox = subsContainer.querySelector("div[style*='background: #F8F9FA']");
      if (activeSubBox && mySubs.length > 0) {
        const sub = mySubs[0];
        activeSubBox.innerHTML = `
          <div style="display: flex; justify-content: space-between; font-weight: 700; font-size: 1rem;">
            <span>Brightloop Enterprise ERP</span>
            <span style="color: var(--odoo-teal);">$${sub.total_recurring_amount.toFixed(2)} / cycle</span>
          </div>
          <div style="font-size: 0.85rem; color: var(--odoo-primary); font-weight: 600; margin-top: 4px;">
            Contract: <strong>${sub.subscription_number}</strong> &bull; Status: <span class="o_tag o_tag_green">${sub.status}</span>
          </div>
          <div style="font-size: 0.75rem; color: var(--odoo-text-muted); margin-top: 6px;">
            Start Date: ${sub.start_date} &bull; Next Renewal: <strong>${sub.next_billing_date}</strong>
          </div>
        `;
      }

      // Render Portal Invoices
      const tbody = subsContainer.querySelector("tbody");
      if (tbody) {
        tbody.innerHTML = "";
        myInvs.forEach(inv => {
          const isPaid = inv.status === "PAID";
          const isPartiallyPaid = inv.status === "PARTIALLY_PAID";
          const tagClass = isPaid ? "o_tag_green" : (isPartiallyPaid ? "o_tag_teal" : "o_tag_purple");

          tbody.innerHTML += `
            <tr>
              <td style="font-family: var(--font-mono); font-weight: 700; color: var(--odoo-primary);">${inv.invoice_number}</td>
              <td>${inv.due_date}</td>
              <td style="font-weight: 700;">$${inv.total_amount.toFixed(2)} (Due: $${inv.amount_residual.toFixed(2)})</td>
              <td>
                <span class="o_tag ${tagClass}">${inv.status}</span>
                ${!isPaid ? `
                  <button class="btn btn-teal" style="font-size: 0.72rem; padding: 3px 8px; margin-left: 6px;" onclick="openPaymentModal('${inv.id}', '${inv.invoice_number}', ${inv.amount_residual})">
                    💳 Pay
                  </button>
                ` : ''}
              </td>
            </tr>
          `;
        });
      }
    }
  } catch (err) {
    console.error("Failed to load customer portal data", err);
  }
}

// ----------------------------------------------------------------------------
// 13. SEARCH FILTER
// ----------------------------------------------------------------------------
function handleSearch(query) {
  query = query.toLowerCase();
  const records = document.querySelectorAll(".o_kanban_record");
  records.forEach(r => {
    const text = r.textContent.toLowerCase();
    r.style.display = text.includes(query) ? "block" : "none";
  });
}
