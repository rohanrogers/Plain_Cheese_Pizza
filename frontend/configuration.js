// Admin configuration uses the shared session and server-enforced role checks.
async function renderSettingsView() {
  await renderAccountSettings();
  $("admin-configuration").hidden = currentUser.role !== "ADMIN";
  if (currentUser.role !== "ADMIN") return;
  try {
    await renderConfigurationRecords();
    for (const kind of ["plan", "tax", "discount"]) resetConfiguration(kind);
    showConfigurationTab("plan");
    text("configuration-error", "");
  } catch (e) {
    text("configuration-error", e.message);
  }
}
function showConfigurationTab(kind) {
  for (const name of ["plan", "tax", "discount"]) {
    $("config-" + name).hidden = name !== kind;
    $("config-tab-" + name).setAttribute(
      "aria-selected",
      String(name === kind),
    );
    $("config-tab-" + name).classList.toggle("btn-primary", name === kind);
  }
}
function resetConfiguration(kind) {
  $(kind + "-form").reset();
  $(kind + "-id").value = "";
  text(kind + "-editing", "Create a new " + kind + ".");
  text(kind + "-result", "");
  if (kind === "discount") {
    $("discount-start").value = today();
    $("discount-end").value = today();
  }
}
function configTable(headers, rows) {
  return `<table class="o_list_table"><thead><tr>${headers.map((x) => `<th>${esc(x)}</th>`).join("")}<th>Action</th></tr></thead><tbody>${rows.join("") || `<tr><td colspan="${headers.length + 1}">No records yet.</td></tr>`}</tbody></table>`;
}
function configEditButton(kind, id) {
  return `<td><button type="button" class="btn btn-secondary" onclick="editConfiguration('${kind}','${esc(id)}')">Edit</button></td>`;
}
async function renderConfigurationRecords() {
  await loadCatalog();
  $("discount-product").innerHTML =
    '<option value="">Whole subscription</option>' +
    options(catalogData.products, (p) => p.name);
  $("plan-records").innerHTML = configTable(
    [
      "Plan",
      "Base fee",
      "Frequency",
      "Minimum units",
      "Availability",
      "Policies",
    ],
    catalogData.plans.map(
      (p) =>
        `<tr><td>${esc(p.name)}</td><td>${money(p.price)}</td><td>Every ${p.interval_count} ${esc(p.interval.toLowerCase())}</td><td>${p.min_quantity}</td><td>${esc(p.available_from || "Any date")} – ${esc(p.available_until || "No end")}</td><td>${[p.auto_close && "Auto-close", p.allow_close && "Early close", p.allow_pause && "Pause", p.allow_renew && "Renew"].filter(Boolean).join(" · ") || "Fixed term"}</td>${configEditButton("plan", p.id)}</tr>`,
    ),
  );
  $("tax-records").innerHTML = configTable(
    ["Tax", "Rate"],
    catalogData.taxes.map(
      (t) =>
        `<tr><td>${esc(t.name)}</td><td>${t.rate_bps / 100}%</td>${configEditButton("tax", t.id)}</tr>`,
    ),
  );
  $("discount-records").innerHTML = configTable(
    ["Code", "Value", "Thresholds", "Dates", "Usage", "Scope"],
    catalogData.discounts.map(
      (d) =>
        `<tr><td>${esc(d.name)}</td><td>${d.kind === "PERCENT" ? d.value / 100 + "%" : money(d.value)}</td><td>${money(d.min_amount)} · ${d.min_quantity} units</td><td>${esc(d.starts_on)} – ${esc(d.ends_on)}</td><td>${d.uses} / ${d.max_uses}</td><td>${esc(catalogData.products.find((p) => p.id === d.product_id)?.name || "Whole subscription")}</td>${configEditButton("discount", d.id)}</tr>`,
    ),
  );
}
function editConfiguration(kind, id) {
  const item = catalogData[
    { plan: "plans", tax: "taxes", discount: "discounts" }[kind]
  ].find((x) => x.id === id);
  if (!item) return;
  resetConfiguration(kind);
  $(kind + "-id").value = id;
  $(kind + "-name").value = item.name;
  text(kind + "-editing", "Editing " + item.name);
  if (kind === "plan") {
    $("plan-price").value = (item.price / 100).toFixed(2);
    $("plan-interval").value = item.interval;
    $("plan-count").value = item.interval_count;
    $("plan-min-quantity").value = item.min_quantity;
    $("plan-from").value = item.available_from || "";
    $("plan-until").value = item.available_until || "";
    for (const key of [
      "auto_close",
      "allow_close",
      "allow_pause",
      "allow_renew",
    ])
      $("plan-" + key.replaceAll("_", "-")).checked = item[key];
  } else if (kind === "tax") {
    $("tax-rate").value = (item.rate_bps / 100).toFixed(2);
  } else {
    $("discount-kind").value = item.kind;
    $("discount-value").value = (item.value / 100).toFixed(2);
    $("discount-min-amount").value = (item.min_amount / 100).toFixed(2);
    $("discount-min-quantity").value = item.min_quantity;
    $("discount-start").value = item.starts_on;
    $("discount-end").value = item.ends_on;
    $("discount-max-uses").value = item.max_uses;
    $("discount-product").value = item.product_id || "";
  }
  $(kind + "-name").focus();
}
async function saveConfiguration(kind) {
  const button = $(kind + "-save");
  if (button.disabled) return;
  if (currentUser.role !== "ADMIN")
    return notify("Administrator access required.");
  button.disabled = true;
  try {
    let payload = { name: $(kind + "-name").value.trim() };
    if (kind === "plan") {
      Object.assign(payload, {
        price: paise($("plan-price").value),
        interval: $("plan-interval").value,
        interval_count: Number($("plan-count").value),
        min_quantity: Number($("plan-min-quantity").value),
        available_from: $("plan-from").value || null,
        available_until: $("plan-until").value || null,
      });
      for (const key of [
        "auto_close",
        "allow_close",
        "allow_pause",
        "allow_renew",
      ])
        payload[key] = $("plan-" + key.replaceAll("_", "-")).checked;
    } else if (kind === "tax") {
      payload.rate_bps = paise($("tax-rate").value);
    } else {
      Object.assign(payload, {
        kind: $("discount-kind").value,
        value: paise($("discount-value").value),
        min_amount: paise($("discount-min-amount").value),
        min_quantity: Number($("discount-min-quantity").value),
        starts_on: $("discount-start").value,
        ends_on: $("discount-end").value,
        max_uses: Number($("discount-max-uses").value),
        product_id: $("discount-product").value || null,
      });
    }
    const id = $(kind + "-id").value;
    const route = { plan: "/plans", tax: "/taxes", discount: "/discounts" }[
      kind
    ];
    await api(route + (id ? "/" + id : ""), {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    await renderConfigurationRecords();
    resetConfiguration(kind);
    text(kind + "-result", "Saved. Existing issued invoices are unchanged.");
  } catch (e) {
    text(kind + "-result", e.message);
  } finally {
    button.disabled = false;
  }
}
