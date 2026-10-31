// IAM behavior adapted from teammate commit 3026801 to the shared app/session.
let resetToken = "";
function showAuthPanel(panel) {
  for (const name of ["login", "signup", "code", "forgot", "reset"])
    $("auth-" + name + "-form").hidden = name !== panel;
  document.querySelector(".o_quick_login_section").hidden = panel !== "login";
  text("auth-message", "");
  if (panel !== "code") $("auth-code").value = "";
  if (panel !== "login") $("login-password").value = "";
  if (panel !== "reset") {
    $("reset-password").value = "";
    $("reset-confirm").value = "";
  }
}
async function handleManualLogin() {
  const button = $("auth-login-submit");
  button.disabled = true;
  try {
    const data = await post("/auth/login", {
      email: $("login-email").value.trim(),
      password: $("login-password").value,
    });
    $("login-password").value = "";
    showAuthPanel("code");
    text("auth-code-help", data.message);
    text(
      "auth-message",
      data.delivery_status === "LOCAL_MAILBOX"
        ? "Code saved in the local development mailbox."
        : data.method === "EMAIL"
          ? "Code sent to your email."
          : "Use your enrolled authenticator app.",
    );
    $("auth-code").focus();
  } catch (e) {
    text("auth-message", e.message);
  } finally {
    button.disabled = false;
  }
}
async function verifySignIn() {
  const button = $("auth-code-submit");
  button.disabled = true;
  try {
    currentUser = await post("/auth/verify-2fa", {
      token: $("auth-code").value,
    });
    loginSuccess();
  } catch (e) {
    text("auth-message", e.message);
  } finally {
    button.disabled = false;
  }
}
async function cancelSignIn() {
  try {
    await post("/auth/logout", {});
    showAuthPanel("login");
  } catch (e) {
    text("auth-message", e.message);
  }
}
async function registerCustomer() {
  try {
    const email = $("signup-email").value.trim();
    await post("/auth/signup", {
      name: $("signup-name").value.trim(),
      email,
      password: $("signup-password").value,
    });
    $("signup-password").value = "";
    $("login-email").value = email;
    showAuthPanel("login");
    text(
      "auth-message",
      "Account created. Sign in and verify your email code.",
    );
  } catch (e) {
    text("auth-message", e.message);
  }
}
async function requestPasswordReset() {
  try {
    const data = await post("/auth/forgot-password", {
      email: $("forgot-email").value.trim(),
    });
    text("auth-message", data.message);
  } catch (e) {
    text("auth-message", e.message);
  }
}
async function completePasswordReset() {
  try {
    if ($("reset-password").value !== $("reset-confirm").value)
      throw new Error("Passwords do not match.");
    const data = await post("/auth/reset-password", {
      token: resetToken,
      password: $("reset-password").value,
    });
    resetToken = "";
    currentUser = null;
    showAuthPanel("login");
    text("auth-message", data.message);
  } catch (e) {
    text("auth-message", e.message);
  }
}
async function renderAccountSettings() {
  currentUser = await api("/auth/me");
  text(
    "security-account",
    `${currentUser.name} · ${currentUser.email} · ${currentUser.role}`,
  );
  $("factor-start-form").hidden = currentUser.two_factor_enabled;
  $("factor-disable-form").hidden = !currentUser.two_factor_enabled;
  $("factor-enrollment").hidden = true;
  $("factor-key").textContent = "";
  $("factor-qr").removeAttribute("src");
  $("admin-access-panel").hidden = currentUser.role !== "ADMIN";
  if (currentUser.role === "ADMIN") {
    const users = await api("/users");
    $("staff-users").innerHTML =
      '<table class="o_list_table"><thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead><tbody>' +
      users
        .map(
          (u) =>
            `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td></tr>`,
        )
        .join("") +
      "</tbody></table>";
  }
}
async function beginAuthenticator() {
  try {
    const data = await post("/auth/2fa/setup", {
      password: $("factor-password").value,
    });
    $("factor-password").value = "";
    $("factor-qr").src = data.qr_code;
    text("factor-key", data.secret);
    $("factor-enrollment").hidden = false;
  } catch (e) {
    notify(e);
  }
}
async function enableAuthenticator() {
  try {
    const data = await post("/auth/2fa/enable", {
      token: $("factor-code").value,
    });
    $("factor-code").value = "";
    await renderAccountSettings();
    notify(data.message);
  } catch (e) {
    notify(e);
  }
}
async function disableAuthenticator() {
  try {
    const data = await post("/auth/2fa/disable", {
      password: $("factor-disable-password").value,
      token: $("factor-disable-code").value,
    });
    $("factor-disable-password").value = "";
    $("factor-disable-code").value = "";
    await renderAccountSettings();
    notify(data.message);
  } catch (e) {
    notify(e);
  }
}
async function provisionStaff() {
  const form = $("staff-create-form");
  try {
    await post("/users/staff", {
      name: $("staff-name").value.trim(),
      email: $("staff-email").value.trim(),
      password: $("staff-password").value,
    });
    form.reset();
    await renderAccountSettings();
    notify(
      "Staff account provisioned. The staff member must verify a sign-in code.",
    );
  } catch (e) {
    notify(e);
  }
}
async function renderPaymentPreferences() {
  const items = await api("/payment-methods");
  $("portal-methods").innerHTML =
    "<h3>Payment preferences</h3><p>Save a label and optional last four digits for your billing team. No card numbers, CVV, bank credentials, or online charges are handled here.</p>" +
    items
      .map(
        (m) =>
          `<p>${esc(m.kind)} · ${esc(m.label)}${m.last_four ? " · ending " + esc(m.last_four) : ""} <button class="record-link" onclick="removePaymentPreference('${esc(m.id)}')">Remove</button></p>`,
      )
      .join("") +
    `<form class="identity-grid" onsubmit="event.preventDefault();addPaymentPreference()"><label>Method<select id="preference-kind" class="o_field_input"><option>BANK</option><option>CARD</option><option>UPI</option><option>CASH</option><option>OTHER</option></select></label><label>Label<input id="preference-label" class="o_field_input" maxlength="120" required placeholder="Company card"></label><label>Last four digits (optional)<input id="preference-last-four" class="o_field_input" inputmode="numeric" pattern="[0-9]{0,4}" maxlength="4"></label><button class="btn btn-primary">Save preference</button></form>`;
}
async function addPaymentPreference() {
  try {
    await post("/payment-methods", {
      kind: $("preference-kind").value,
      label: $("preference-label").value,
      last_four: $("preference-last-four").value,
    });
    await renderPaymentPreferences();
  } catch (e) {
    notify(e);
  }
}
async function removePaymentPreference(id) {
  try {
    await api("/payment-methods/" + id, { method: "DELETE" });
    await renderPaymentPreferences();
  } catch (e) {
    notify(e);
  }
}
