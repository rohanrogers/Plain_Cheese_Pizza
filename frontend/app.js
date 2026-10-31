// Existing teammate layout, connected to same-origin APIs. Money is integer paise.
const API_BASE = "/api";
let currentUser = null,
  currentSubscription = null,
  currentInvoice = null;
let currentActiveView = "login",
  dashMrrChartInstance,
  dashPlansChartInstance,
  odooChartInstance;
let invoicePage = 1,
  subscriptionPage = 1,
  invoiceFilter = "ALL",
  subscriptionFilter = "ALL";
let reportRange = "",
  searchQuery = "",
  searchTimer;
const $ = (id) => document.getElementById(id);
const text = (id, value) => {
  if ($(id)) $(id).textContent = value;
};
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const money = (value) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(
    (value || 0) / 100,
  );
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
function notify(error) {
  const el = $("workspace-message");
  el.textContent = error?.message || String(error);
  el.hidden = false;
}
async function api(path, options = {}) {
  const response = await fetch(API_BASE + path, {
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      currentUser = null;
      navigateTo("login");
    }
    throw new Error(
      Array.isArray(data.detail)
        ? data.detail.map((x) => `${x.loc.at(-1)}: ${x.msg}`).join("; ")
        : data.detail || "Request failed",
    );
  }
  return data;
}
const post = (path, data) =>
  api(path, { method: "POST", body: JSON.stringify(data) });
async function verifyBackendConnectivity() {
  try {
    const h = await api("/health");
    text("backend-status-badge", `${h.database} connected · INR`);
  } catch (e) {
    text("backend-status-badge", "Database unavailable");
    notify(e);
  }
}
document.addEventListener("DOMContentLoaded", async () => {
  $("billing-target-date").value = today();
  $("modal-payment-date").value = today();
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".o_user_pill"))
      $("o-user-menu")?.classList.remove("show");
  });
  await verifyBackendConnectivity();
  const reset =
    new URLSearchParams(location.hash.replace(/^#/, "")).get("reset") ||
    new URLSearchParams(location.search).get("reset");
  if (reset) {
    resetToken = reset;
    history.replaceState(null, "", location.pathname);
    navigateTo("login");
    showAuthPanel("reset");
    return;
  }
  try {
    currentUser = await api("/auth/me");
    loginSuccess();
  } catch {
    navigateTo("login");
  }
});
function navigateTo(viewName) {
  if (!currentUser && viewName !== "login") viewName = "login";
  if (
    currentUser?.role === "CUSTOMER" &&
    !["portal", "form", "invoice-form", "login", "settings"].includes(viewName)
  )
    viewName = "portal";
  if (viewName === "form" && !currentSubscription)
    return notify("Choose a subscription first.");
  currentActiveView = viewName;
  if (viewName === "settings") renderSettingsView().catch(notify);
  const allViews = [
    "login",
    "dashboard",
    "kanban",
    "list",
    "form",
    "invoices",
    "invoice-form",
    "billing",
    "products",
    "pivot",
    "settings",
    "portal",
  ];

  allViews.forEach((v) => {
    const el = document.getElementById(`view-${v}`);
    if (el)
      el.style.display =
        v !== viewName ? "none" : v === "login" ? "flex" : "block";
  });

  // Top Navbar & Control Panel Visibility
  const topNav = document.getElementById("odoo-top-navbar");
  const cp = document.getElementById("odoo-control-panel");
  const appTitle = document.getElementById("o-current-app-name");

  if (viewName === "login") {
    if (topNav) topNav.style.display = "none";
    if (cp) cp.style.display = "none";
    return;
  }

  if (topNav) topNav.style.display = "flex";

  if (viewName === "portal") {
    if (cp) cp.style.display = "none";
    if (appTitle) appTitle.textContent = "Customer Portal";
  } else {
    if (cp) cp.style.display = "flex";
  }

  if (viewName === "kanban") renderKanbanView().catch(notify);
  if (viewName === "products") renderProductsView().catch(notify);
  if (viewName === "portal") renderPortal().catch(notify);
  if (currentUser?.role === "CUSTOMER" && cp) cp.style.display = "none";
  // Update Navbar Tabs
  document.querySelectorAll(".o_nav_tab").forEach((tab) => {
    tab.classList.toggle(
      "active",
      tab.id === `nav-${viewName}` ||
        (viewName === "list" && tab.id === "nav-subscriptions"),
    );
  });

  // Update Breadcrumbs & App Title
  const parentBreadcrumb = document.getElementById("cp-parent-view");
  const breadcrumbText = document.getElementById("cp-current-view");

  if (viewName === "dashboard") {
    if (appTitle) appTitle.textContent = "Subscriptions Dashboard";
    if (parentBreadcrumb) parentBreadcrumb.textContent = "Dashboard";
    if (breadcrumbText) breadcrumbText.textContent = "Executive Overview";
    renderDashboard().catch(notify);
  } else if (viewName === "kanban") {
    if (appTitle) appTitle.textContent = "Subscriptions";
    if (parentBreadcrumb) parentBreadcrumb.textContent = "Subscriptions";
    if (breadcrumbText) breadcrumbText.textContent = "Kanban Pipeline";
  } else if (viewName === "list") {
    if (appTitle) appTitle.textContent = "Subscriptions";
    if (parentBreadcrumb) parentBreadcrumb.textContent = "Subscriptions";
    if (breadcrumbText) breadcrumbText.textContent = "All Records";
    renderSubscriptionsList().catch(notify);
  } else if (viewName === "form") {
    if (appTitle) appTitle.textContent = "Subscriptions";
    if (parentBreadcrumb) parentBreadcrumb.textContent = "Subscriptions";
    if (breadcrumbText)
      breadcrumbText.textContent = currentSubscription
        ? currentSubscription.number
        : "New Quotation";
  } else if (viewName === "invoices") {
    if (appTitle) appTitle.textContent = "Invoicing";
    if (parentBreadcrumb) parentBreadcrumb.textContent = "Accounting";
    if (breadcrumbText) breadcrumbText.textContent = "Customer Invoices";
    renderInvoicesList().catch(notify);
  } else if (viewName === "invoice-form") {
    if (appTitle) appTitle.textContent = "Invoicing";
    if (parentBreadcrumb) parentBreadcrumb.textContent = "Invoices";
    if (breadcrumbText)
      breadcrumbText.textContent = currentInvoice
        ? currentInvoice.number
        : "New Invoice";
  } else if (viewName === "billing") {
    if (appTitle) appTitle.textContent = "Batch Operations";
    if (parentBreadcrumb) parentBreadcrumb.textContent = "Operations";
    if (breadcrumbText) breadcrumbText.textContent = "Automated Batch Billing";
  } else if (viewName === "products") {
    if (appTitle) appTitle.textContent = "Products & Catalog";
    if (parentBreadcrumb) parentBreadcrumb.textContent = "Catalog";
    if (breadcrumbText)
      breadcrumbText.textContent = "Products & Pricing Variants";
  } else if (viewName === "pivot") {
    if (appTitle) appTitle.textContent = "Financial Reporting";
    if (parentBreadcrumb) parentBreadcrumb.textContent = "Reporting";
    if (breadcrumbText)
      breadcrumbText.textContent = "Pivot & A/R Aging Analysis";
    renderOdooAgingChart().catch(notify);
  } else if (viewName === "settings") {
    if (appTitle) appTitle.textContent = "Configuration";
    if (parentBreadcrumb) parentBreadcrumb.textContent = "Settings";
    if (breadcrumbText)
      breadcrumbText.textContent = "System & Fiscal Parameters";
  }
}

// Shared IAM session is used by every finance and portal request.
function toggleUserMenu(e) {
  e.stopPropagation();
  $("o-user-menu").classList.toggle("show");
}
function toggleAppDrawer(e) {
  e?.stopPropagation();
  $("o-app-drawer-overlay").classList.toggle("show");
}
function openAppFromDrawer(view) {
  $("o-app-drawer-overlay").classList.remove("show");
  navigateTo(view);
}
function quickLogin(type) {
  $("login-email").value =
    { admin: "admin", billing: "staff", customer: "customer1" }[type] +
    "@brightloop.local";
  notify("Local fixture account selected. Enter its password to sign in.");
}
function loginSuccess() {
  text("user-display-name", currentUser.name);
  text("user-avatar-initials", currentUser.name.slice(0, 2).toUpperCase());
  $("workspace-message").hidden = true;
  showAuthPanel("login");
  document.querySelectorAll(".o_nav_tab").forEach((el) => {
    el.hidden = currentUser.role === "CUSTOMER" && el.id !== "nav-settings";
  });
  navigateTo(
    currentUser.role === "CUSTOMER"
      ? "portal"
      : currentUser.role === "STAFF"
        ? "invoices"
        : "dashboard",
  );
}
async function logoutUser() {
  try {
    await post("/auth/logout", {});
    currentUser = null;
    currentInvoice = null;
    currentSubscription = null;
    showAuthPanel("login");
    navigateTo("login");
  } catch (e) {
    notify(e);
  }
}
function togglePortalMode() {
  navigateTo(
    currentActiveView === "portal" && currentUser.role !== "CUSTOMER"
      ? "dashboard"
      : "portal",
  );
}
function badge(inv) {
  return `<span class="o_status_badge ${inv.state === "PAID" ? "o_status_paid" : inv.overdue ? "o_status_overdue" : "o_status_posted"}">${esc(inv.state)}${inv.overdue ? " · OVERDUE" : ""}</span>`;
}
function invoiceRows(items, compact = false) {
  return (
    items
      .map(
        (i) =>
          `<tr><td><button class="record-link" onclick="openInvoiceDetail('${esc(i.id)}')">${esc(i.number)}</button></td><td>${esc(i.customer_name)}</td>${compact ? "" : `<td>${esc(i.period_start)}</td>`}<td>${esc(i.due_date)}</td>${compact ? "" : `<td>${money(i.tax)}</td>`}<td>${money(i.total)}</td><td>${badge(i)}</td><td><button class="btn btn-secondary" onclick="openInvoiceDetail('${esc(i.id)}')">Open</button></td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="8">No saved invoices match this view.</td></tr>'
  );
}
async function renderDashboard() {
  const started = performance.now();
  const [d, invoices] = await Promise.all([
    api("/dashboard" + reportRange),
    api("/invoices"),
  ]);
  text("dash-mrr-val", money(d.mrr));
  text("dash-arr-val", money(d.arr));
  text("dash-subs-val", d.active_subscriptions);
  text("dash-churn-val", d.closed_subscriptions);
  text("dash-ar-val", money(d.outstanding));
  text("dash-sla-val", `${Math.round(performance.now() - started)} ms`);
  $("dash-recent-invoices-tbody").innerHTML = invoiceRows(
    invoices.items.slice(0, 5),
    true,
  );
  text(
    "finance-summary",
    `Collected ${money(d.collected)} · Invoiced ${money(d.billed)} · Overdue ${money(d.overdue)} · Draft invoices ${d.draft_invoices}`,
  );
  text("report-definition", d.mrr_definition + " " + d.note);
  chart(
    "dash-mrr-chart",
    "line",
    d.revenue_trend.map((x) => x.month),
    d.revenue_trend.map((x) => x.net / 100),
    "Net invoiced (INR)",
  );
  chart(
    "dash-plans-chart",
    "doughnut",
    d.plan_counts.map((x) => x.name),
    d.plan_counts.map((x) => x.count),
    "Active subscriptions",
  );
}
const charts = {};
function chart(id, type, labels, values, label) {
  if (typeof Chart === "undefined") return;
  charts[id]?.destroy();
  charts[id] = new Chart($(id), {
    type,
    data: {
      labels,
      datasets: [
        {
          label,
          data: values,
          backgroundColor:
            type === "doughnut"
              ? ["#714B67", "#00A09D", "#339AF0", "#FD7E14"]
              : "#714B67",
          borderColor: "#714B67",
          borderWidth: 2,
          tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: type === "doughnut", position: "bottom" } },
    },
  });
}
function updateDashboardRange(range) {
  const d = new Date(),
    year = d.getFullYear();
  let start = "";
  if (range === "current")
    start = `${year}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  if (range === "q4") start = `${year}-10-01`;
  if (range === "ytd") start = `${year}-01-01`;
  reportRange = start ? `?start=${start}&end=${today()}` : "";
  renderDashboard().catch(notify);
}
function pager(id, page, total, callback) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = `<button class="btn btn-secondary" ${page <= 1 ? "disabled" : ""} onclick="${callback}(-1)">Previous</button> <span>Page ${page} · ${total} records</span> <button class="btn btn-secondary" ${page * 25 >= total ? "disabled" : ""} onclick="${callback}(1)">Next</button>`;
}
async function renderInvoicesList() {
  const params = new URLSearchParams({ page: invoicePage, q: searchQuery });
  if (invoiceFilter === "OVERDUE") params.set("overdue", "true");
  else if (invoiceFilter !== "ALL")
    params.set(
      "state",
      invoiceFilter === "POSTED" ? "CONFIRMED" : invoiceFilter,
    );
  const data = await api("/invoices?" + params);
  $("invoices-list-tbody").innerHTML = invoiceRows(data.items);
  text("invoices-count-badge", `${data.total} invoices`);
  pager("invoice-pager", invoicePage, data.total, "changeInvoicePage");
}
function filterInvoicesStatus(status) {
  invoiceFilter = status;
  invoicePage = 1;
  renderInvoicesList().catch(notify);
}
function changeInvoicePage(delta) {
  invoicePage += delta;
  renderInvoicesList().catch(notify);
}
async function openInvoiceDetail(id) {
  try {
    currentInvoice = await api("/invoices/" + id);
    loadInvoiceToForm(currentInvoice);
    navigateTo("invoice-form");
  } catch (e) {
    notify(e);
  }
}
function loadInvoiceToForm(i) {
  text("inv-form-number", i.number);
  text("inv-form-customer", i.customer_name);
  text("inv-form-date", i.period_start);
  text("inv-form-due", i.due_date);
  text("inv-form-untaxed", money(i.subtotal));
  text("inv-form-tax", money(i.tax));
  text("inv-form-total", money(i.total));
  text("inv-discount", money(i.discount));
  text("inv-paid", money(i.paid));
  text("inv-balance", money(i.balance));
  text("inv-discount-reason", i.discount_reason);
  $("inv-form-lines-tbody").innerHTML =
    i.lines
      .map(
        (l) =>
          `<tr><td>${esc(l.description)}</td><td>${l.quantity}</td><td>${money(l.unit_price)}</td><td>${l.tax_rate_bps / 100}% · ${money(l.tax)}</td><td>${money(l.total)}</td></tr>`,
      )
      .join("") +
    (i.discount
      ? `<tr><td colspan="4">Discount (allocated before line taxes)</td><td>−${money(i.discount)}</td></tr>`
      : "");
  ["draft", "posted", "paid"].forEach((s, index) =>
    $("istatus-" + s).classList.toggle(
      "current",
      i.state === ["DRAFT", "CONFIRMED", "PAID"][index],
    ),
  );
  text("invoice-state", i.state);
  const staff = currentUser.role !== "CUSTOMER";
  $("invoice-confirm").hidden = !staff || i.state !== "DRAFT";
  $("invoice-cancel").hidden =
    !staff || !["DRAFT", "CONFIRMED"].includes(i.state) || i.paid > 0;
  $("invoice-send").hidden = !staff || !["CONFIRMED", "PAID"].includes(i.state);
  $("btn-invoice-register-payment").hidden = !staff || i.state !== "CONFIRMED";
  $("invoice-payments").innerHTML =
    "<h3>Payment ledger</h3>" +
    ((i.payments || [])
      .map(
        (p) =>
          `<p>${esc(p.paid_on)} · ${money(p.amount)} · ${esc(p.method)} · ${esc(p.reference)} · ${esc(p.note)}</p>`,
      )
      .join("") || "<p>No payments recorded.</p>");
  $("invoice-audit").innerHTML =
    "<h3>Audit trail</h3>" +
    ((i.events || [])
      .map(
        (e) =>
          `<p>${esc(e.created_at)} · ${esc(e.action)} · ${esc(e.detail)}</p>`,
      )
      .join("") || "<p>No events recorded.</p>");
}
async function invoiceAction(action) {
  try {
    let note = "";
    if (action === "CANCEL") {
      note = prompt("Reason for cancellation");
      if (!note) return;
    }
    const data = await post(`/invoices/${currentInvoice.id}/action`, {
      action,
      note,
    });
    await openInvoiceDetail(currentInvoice.id);
    if (action === "SEND")
      notify(
        "Email status: " +
          data.delivery_status +
          " (local messages: http://127.0.0.1:8025)",
      );
  } catch (e) {
    notify(e);
  }
}
function simulatePrintInvoice() {
  if (currentInvoice)
    window.open(
      `${API_BASE}/invoices/${currentInvoice.id}/print`,
      "_blank",
      "noopener",
    );
}
function openPaymentModalForActiveInvoice() {
  if (!currentInvoice || currentInvoice.state !== "CONFIRMED") return;
  text("modal-invoice-ref", currentInvoice.number);
  text("modal-invoice-amt", money(currentInvoice.balance));
  $("payment-amount").value = (currentInvoice.balance / 100).toFixed(2);
  $("payment-reference").value = "";
  $("payment-note").value = "";
  $("payment-error").textContent = "";
  $("odoo-payment-modal").style.display = "flex";
}
function closePaymentModal() {
  $("odoo-payment-modal").style.display = "none";
}
async function confirmPaymentSettlement() {
  const btn = $("payment-submit");
  btn.disabled = true;
  try {
    const amount = $("payment-amount").value;
    if (!/^\d+(\.\d{1,2})?$/.test(amount))
      throw new Error(
        "Enter a positive amount with at most two decimal places.",
      );
    await post(`/invoices/${currentInvoice.id}/payments`, {
      amount: Math.round(Number(amount) * 100),
      method: $("modal-journal-select").value,
      paid_on: $("modal-payment-date").value,
      reference: $("payment-reference").value.trim(),
      note: $("payment-note").value.trim(),
    });
    closePaymentModal();
    await openInvoiceDetail(currentInvoice.id);
  } catch (e) {
    $("payment-error").textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}
async function executeBatchBillingRun(preview = false) {
  const btn = $("btn-trigger-billing");
  btn.disabled = true;
  try {
    const started = performance.now(),
      result = await post(preview ? "/billing/preview" : "/billing/run", {
        as_of: $("billing-target-date").value,
      });
    text("bill-due", result.periods_evaluated);
    text("bill-gen", result.invoices_created);
    text("bill-skip", result.duplicates_skipped);
    text("bill-time", `${Math.round(performance.now() - started)} ms`);
    text(
      "odoo-billing-log",
      `${preview ? "PREVIEW — no records changed" : "COMMITTED"}\n${result.invoices_created} ${preview ? "proposed" : "created"} draft invoices · ${money(result.total)}\n` +
        result.rows
          .map(
            (r) =>
              `${r.subscription} | ${r.period} | ${r.outcome} | ${money(r.total)} | ${r.reason}`,
          )
          .join("\n") +
        `\nShowing ${result.rows.length} of ${result.rows_total} rows.`,
    );
  } catch (e) {
    notify(e);
    text(
      "odoo-billing-log",
      "Failed: " + e.message + "\nThe transaction was rolled back.",
    );
  } finally {
    btn.disabled = false;
  }
}
async function renderOdooAgingChart() {
  const started = performance.now(),
    d = await api("/dashboard" + reportRange),
    ms = Math.round(performance.now() - started);
  text("pivot-sla-ms", `${ms} ms`);
  text("pivot-btn-time", `${ms} ms`);
  text("pivot-mrr-text", money(d.mrr));
  text("pivot-arr-text", money(d.arr));
  text("pivot-active", d.active_subscriptions);
  chart(
    "odooAgingCanvas",
    "bar",
    d.aging.map((x) => x.label),
    d.aging.map((x) => x.amount / 100),
    "Outstanding INR",
  );
  $("odoo-pivot-tbody").innerHTML = d.aging
    .map((x) => `<tr><td>${esc(x.label)}</td><td>${money(x.amount)}</td></tr>`)
    .join("");
  $("overdue-log").innerHTML =
    "<h3>Oldest overdue invoices</h3>" +
    d.attention
      .map(
        (i) =>
          `<p><button class="record-link" onclick="openInvoiceDetail('${esc(i.id)}')">${esc(i.number)}</button> · ${esc(i.customer_name)} · due ${esc(i.due_date)} · ${money(i.balance)}</p>`,
      )
      .join("");
}
function retestOdooSLA() {
  renderOdooAgingChart().catch(notify);
}

// Subscription views use the shared IAM, catalog, and finance API.
async function renderSubscriptionsList() {
  const p = new URLSearchParams({ page: subscriptionPage, q: searchQuery });
  if (subscriptionFilter !== "ALL") p.set("state", subscriptionFilter);
  const d = await api("/subscriptions?" + p);
  text("list-total-count", d.total);
  $("subs-list-tbody").innerHTML = d.items
    .map(
      (s) =>
        `<tr><td></td><td><button class="record-link" onclick="openSubscription('${esc(s.id)}')">${esc(s.number)}</button></td><td>${esc(s.customer_name)}</td><td>${esc(s.next_billing_date)}</td><td>${esc(s.plan_name)}</td><td>${money(s.estimate.total)}</td><td>${esc(s.state)}</td></tr>`,
    )
    .join("");
  pager(
    "subscription-pager",
    subscriptionPage,
    d.total,
    "changeSubscriptionPage",
  );
}
function filterListStatus(status) {
  subscriptionFilter = status;
  subscriptionPage = 1;
  renderSubscriptionsList().catch(notify);
}
function changeSubscriptionPage(delta) {
  subscriptionPage += delta;
  renderSubscriptionsList().catch(notify);
}
async function renderKanbanView() {
  const d = await api("/subscriptions?q=" + encodeURIComponent(searchQuery));
  for (const state of [
    "DRAFT",
    "QUOTATION",
    "CONFIRMED",
    "ACTIVE",
    "PAUSED",
    "CLOSED",
  ]) {
    const items = d.items.filter((s) => s.state === state);
    text("kcount-" + state.toLowerCase(), items.length);
    $("kcards-" + state.toLowerCase()).innerHTML = items
      .map(
        (s) =>
          `<button class="o_kanban_record" onclick="openSubscription('${esc(s.id)}')"><div class="o_kanban_ref">${esc(s.number)}</div><div class="o_kanban_title">${esc(s.customer_name)}</div><p>${esc(s.plan_name)} · ${esc(s.state)}</p><p>${money(s.estimate.total)} / ${esc(s.interval.toLowerCase())}</p></button>`,
      )
      .join("");
  }
  text(
    "kanban-page-note",
    `Showing first ${d.items.length} of ${d.total}; use list view for pagination and all states.`,
  );
}
async function openSubscription(id) {
  try {
    const s = (currentSubscription = await api("/subscriptions/" + id));
    text("form-doc-number", s.number);
    text("subscription-state", s.state);
    for (const state of ["draft", "quotation", "active", "closed"]) {
      $("status-step-" + state).classList.toggle(
        "o_arrow_active",
        s.state === state.toUpperCase(),
      );
    }
    text("form-customer-name", s.customer_name);
    text("form-plan-name", s.plan_name);
    text("form-start-date", s.starts_on);
    text("form-next-billing", s.next_billing_date);
    text("stat-renewal-date", s.next_billing_date);
    text("stat-invoices-count", s.invoices.length);
    text("stat-mrr-val", money(s.estimate.total));
    $("form-lines-tbody").innerHTML = s.estimate.lines
      .map(
        (l) =>
          `<tr><td>${esc(l.description)}</td><td>${l.quantity}</td><td>${money(l.unit_price)}</td><td>${money(l.tax)}</td><td>${money(l.total)}</td></tr>`,
      )
      .join("");
    text("form-subtotal", money(s.estimate.subtotal));
    text("form-tax", money(s.estimate.tax));
    text("form-discount", money(-s.estimate.discount));
    text("form-discount-reason", s.estimate.discount_reason);
    text("form-total", money(s.estimate.total));
    renderContractInfo(s);
    showContractTab("lines");
    $("quotation-builder").hidden = true;
    updateContractControls(s);
    navigateTo("form");
  } catch (e) {
    notify(e);
  }
}
function showInvoiceList() {
  navigateTo("invoices");
}
function createSingleInvoice() {
  navigateTo("billing");
  notify(
    "Preview and run billing for due subscriptions. A period can have one invoice.",
  );
}
async function createNewQuotation() {
  await openQuotationBuilder();
}
function confirmActiveSubscription() {
  if (currentSubscription)
    transitionContract(
      currentSubscription.state === "DRAFT" ? "QUOTE" : "CONFIRM",
    );
}
function cancelCurrentSubscription() {
  if (currentSubscription) transitionContract("CLOSE");
}
let portalInvoicePage = 1,
  portalSubscriptionPage = 1;
async function renderPortal() {
  const [d, inv, subs] = await Promise.all([
    api("/dashboard"),
    api("/invoices?page=" + portalInvoicePage),
    api("/subscriptions?page=" + portalSubscriptionPage),
  ]);
  $("portal-live").innerHTML =
    `<h2>${esc(currentUser.name)}</h2><p>Active subscriptions ${d.active_subscriptions} · Outstanding ${money(d.outstanding)}</p><p>Manual payments are recorded by staff. Contact your billing team to update payment details.</p><h3>Subscriptions</h3>${subs.items.map((s) => `<p><button class="record-link" onclick="openSubscription('${esc(s.id)}')">${esc(s.number)}</button> · ${esc(s.state)} · ${esc(s.plan_name)}</p>`).join("")}<div id="portal-subscription-pager" class="record-pager"></div><h3>Invoices</h3><table class="o_list_table"><tbody>${invoiceRows(inv.items, true)}</tbody></table><div id="portal-invoice-pager" class="record-pager"></div><button class="btn btn-secondary" onclick="navigateTo('settings')">Account security</button><div id="portal-methods"></div>`;
  pager(
    "portal-invoice-pager",
    portalInvoicePage,
    inv.total,
    "changePortalInvoicePage",
  );
  pager(
    "portal-subscription-pager",
    portalSubscriptionPage,
    subs.total,
    "changePortalSubscriptionPage",
  );
  await renderPaymentPreferences();
}
function changePortalInvoicePage(delta) {
  portalInvoicePage += delta;
  renderPortal().catch(notify);
}
function changePortalSubscriptionPage(delta) {
  portalSubscriptionPage += delta;
  renderPortal().catch(notify);
}
function handleSearch(value) {
  searchQuery = value;
  invoicePage = subscriptionPage = 1;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const fn = {
      invoices: renderInvoicesList,
      list: renderSubscriptionsList,
      kanban: renderKanbanView,
    }[currentActiveView];
    fn?.().catch(notify);
  }, 250);
}
