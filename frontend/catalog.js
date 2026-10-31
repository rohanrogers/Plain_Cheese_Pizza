// Canonical paise/BPS API integration for teammate catalog and lifecycle UI.
let catalogData = { products: [], plans: [], templates: [] };
async function loadCatalog() {
  catalogData = await api("/catalog");
  return catalogData;
}
function paise(value) {
  if (!/^\d+(\.\d{1,2})?$/.test(String(value)))
    throw new Error(
      "Enter a nonnegative amount with at most two decimal places.",
    );
  const [whole, fraction = ""] = String(value).split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result) || result > 100000000000)
    throw new Error("Amount is too large.");
  return result;
}
function options(items, label) {
  return items
    .map((x) => `<option value="${esc(x.id)}">${esc(label(x))}</option>`)
    .join("");
}
async function renderProductsView() {
  await loadCatalog();
  $("odoo-products-tbody").innerHTML = catalogData.products
    .map(
      (p) =>
        `<tr><td>${esc(p.name)}${p.active ? "" : " (Archived)"}</td><td>${esc(p.kind)}</td><td>${money(p.price)}</td><td>${money(p.cost)}</td><td>${p.variants.map((v) => `${esc(v.name)}: +${money(v.modifier)}`).join("<br>") || "Base configuration"}</td><td>${currentUser.role === "ADMIN" ? `<button class="btn btn-secondary" onclick="openCreateProductModal('${esc(p.id)}')">Edit</button> <button class="btn btn-secondary" onclick="openAddVariantModal('${esc(p.id)}')">Add variant</button>` : "View only"}</td></tr>`,
    )
    .join("");
  document
    .querySelectorAll("#view-products .o_catalog_toolbar button")
    .forEach((x) => (x.hidden = currentUser.role !== "ADMIN"));
  $("calc-product-select").innerHTML = options(
    catalogData.products,
    (p) => p.name,
  );
  handleCalcProductChange();
}
function handleCalcProductChange() {
  const p = catalogData.products.find(
    (x) => x.id === $("calc-product-select").value,
  );
  $("calc-variant-pills").innerHTML = p
    ? `<label><input type="radio" name="calc-variant" checked onchange="displayVariantPrice('')">Base</label>` +
      p.variants
        .map(
          (v) =>
            `<label class="o_variant_pill"><input type="radio" name="calc-variant" onchange="displayVariantPrice('${esc(v.id)}')">${esc(v.name)} +${money(v.modifier)}</label>`,
        )
        .join("")
    : "";
  displayVariantPrice("");
}
function displayVariantPrice(id) {
  const p = catalogData.products.find(
    (x) => x.id === $("calc-product-select").value,
  );
  const v = p?.variants.find((x) => x.id === id);
  text("calc-base-price", money(p?.price));
  text("calc-modifier-sum", money(v?.modifier));
  text("calc-total-price", money((p?.price || 0) + (v?.modifier || 0)));
}
function openCreateProductModal(id = null) {
  const item = catalogData.products.find((p) => p.id === id);
  $("product-edit-id").value = item?.id || "";
  $("prod-new-name").value = item?.name || "";
  $("prod-new-type").value = item?.kind || "SOFTWARE";
  $("prod-new-sales-price").value = ((item?.price || 0) / 100).toFixed(2);
  $("prod-new-cost-price").value = ((item?.cost || 0) / 100).toFixed(2);
  $("prod-new-notes").value = item?.notes || "";
  $("product-active").checked = item?.active ?? true;
  for (const field of ["prod-new-var-attr", "prod-new-var-val"])
    $(field).value = "";
  $("prod-new-var-mod").value = "0.00";
  text("product-editor-title", item ? "Edit product" : "Create product");
  text("product-error", "");
  $("prod-new-tax").innerHTML =
    '<option value="">No tax</option>' +
    options(catalogData.taxes || [], (x) => `${x.name} (${x.rate_bps / 100}%)`);
  $("prod-new-tax").value = item?.tax_id || "";
  $("modal-create-product").style.display = "flex";
}
function closeCreateProductModal() {
  $("modal-create-product").style.display = "none";
}
async function submitCreateProduct() {
  const btn = $("btn-save-product");
  btn.disabled = true;
  try {
    const attr = $("prod-new-var-attr").value.trim(),
      value = $("prod-new-var-val").value.trim();
    if (Boolean(attr) !== Boolean(value))
      throw new Error("Enter both variant attribute and value.");
    const variants =
      attr && value
        ? [
            {
              name: attr + ": " + value,
              modifier: paise($("prod-new-var-mod").value),
            },
          ]
        : [];
    const productId = $("product-edit-id").value;
    await api("/products" + (productId ? "/" + productId : ""), {
      method: productId ? "PUT" : "POST",
      body: JSON.stringify({
        name: $("prod-new-name").value.trim(),
        kind: $("prod-new-type").value,
        price: paise($("prod-new-sales-price").value),
        cost: paise($("prod-new-cost-price").value),
        notes: $("prod-new-notes").value,
        tax_id: $("prod-new-tax").value || null,
        variants,
        active: $("product-active").checked,
      }),
    });
    closeCreateProductModal();
    await renderProductsView();
  } catch (e) {
    text("product-error", e.message);
  } finally {
    btn.disabled = false;
  }
}
function openAddVariantModal(id) {
  $("var-target-product").innerHTML = options(
    catalogData.products,
    (p) => p.name,
  );
  if (id) $("var-target-product").value = id;
  $("modal-add-variant").style.display = "flex";
}
function closeAddVariantModal() {
  $("modal-add-variant").style.display = "none";
}
async function submitAddVariant() {
  const btn = $("btn-save-variant");
  btn.disabled = true;
  try {
    if (!$("var-attr-name").value.trim() || !$("var-attr-value").value.trim())
      throw new Error("Enter the variant attribute and value.");
    await post(`/products/${$("var-target-product").value}/variants`, {
      name:
        $("var-attr-name").value.trim() +
        ": " +
        $("var-attr-value").value.trim(),
      modifier: paise($("var-price-mod").value),
    });
    closeAddVariantModal();
    await renderProductsView();
  } catch (e) {
    notify(e);
  } finally {
    btn.disabled = false;
  }
}
let editingSubscriptionId = null;
let quoteLineSequence = 0;
let quoteReturnId = null;
async function openQuotationBuilder(id = null) {
  try {
    await loadCatalog();
    const customers = (await api("/users")).filter(
      (x) => x.role === "CUSTOMER",
    );
    const saved = id ? await api("/subscriptions/" + id) : null;
    if (saved && !["DRAFT", "QUOTATION"].includes(saved.state))
      throw new Error("Confirmed contract prices cannot be edited.");
    editingSubscriptionId = id;
    quoteReturnId = id;
    $("quote-form").reset();
    $("quote-customer").innerHTML = options(customers, (x) => x.name);
    $("quote-plan").innerHTML = options(
      catalogData.plans,
      (x) => `${x.name} · ${money(x.price)} base / ${x.interval.toLowerCase()}`,
    );
    $("quote-template").innerHTML =
      '<option value="">No template</option>' +
      options(catalogData.templates, (x) => x.name);
    $("quote-coupons").innerHTML = catalogData.discounts
      .map((d) => `<option value="${esc(d.name)}"></option>`)
      .join("");
    $("quote-start").value = saved?.starts_on || today();
    $("quote-expiry").value = saved?.expires_on || "";
    $("quote-payment-days").value = saved?.payment_days ?? 14;
    $("quote-validity").value = saved
      ? Math.max(
          1,
          Math.ceil(
            (Date.parse(saved.quote_expires_on) - Date.parse(today())) /
              86400000,
          ),
        )
      : 7;
    $("quote-coupon").value = saved?.discount_id
      ? catalogData.discounts.find((d) => d.id === saved.discount_id)?.name ||
        ""
      : "";
    if (saved) {
      $("quote-customer").value = saved.customer_id;
      $("quote-plan").value = saved.plan_id;
    }
    $("quote-lines").innerHTML = "";
    const lines = saved?.lines.filter((l) => l.product_id) || [{}];
    for (const line of lines) addQuoteLine(line);
    currentSubscription = { number: saved?.number || "New quotation" };
    text(
      "quote-heading",
      saved ? "Edit quotation " + saved.number : "New quotation",
    );
    text("quote-save", saved ? "Save quotation" : "Create draft");
    text("quote-error", "");
    text("quote-totals", "");
    $("contract-coupon-card").hidden = true;
    $("renewal-form").hidden = true;
    navigateTo("form");
    $("quotation-builder").hidden = false;
    document
      .querySelectorAll(
        "#view-form .o_form_sheet_bg,#view-form .o_form_statusbar",
      )
      .forEach((x) => (x.hidden = true));
  } catch (e) {
    notify(e);
  }
}
function addQuoteLine(line = {}) {
  if ($("quote-lines").children.length >= 50)
    return text(
      "quote-error",
      "A quotation can contain at most 50 product lines.",
    );
  const key = ++quoteLineSequence;
  const row = document.createElement("tr");
  row.dataset.key = String(key);
  row.innerHTML = `<td><select aria-label="Product line ${key}" class="o_field_input line-product" required onchange="quoteProductChanged(${key})">${options(
    catalogData.products.filter((p) => p.active),
    (p) => p.name,
  )}</select></td><td><select aria-label="Variant line ${key}" class="o_field_input line-variant" onchange="updateQuoteLine(${key})"></select></td><td><input aria-label="Quantity line ${key}" class="o_field_input line-quantity" type="number" min="1" max="100000" value="${Number(line.quantity || 1)}" required oninput="updateQuoteLine(${key})"></td><td class="line-price"></td><td class="line-subtotal"></td><td><button type="button" class="btn btn-secondary" aria-label="Remove line ${key}" onclick="removeQuoteLine(${key})">Remove</button></td>`;
  $("quote-lines").append(row);
  if (line.product_id)
    row.querySelector(".line-product").value = line.product_id;
  quoteProductChanged(key, line.variant_id);
}
function quoteRow(key) {
  return $("quote-lines").querySelector(`[data-key="${Number(key)}"]`);
}
function quoteProductChanged(key, variant = null) {
  const row = quoteRow(key);
  const p = catalogData.products.find(
    (x) => x.id === row.querySelector(".line-product").value,
  );
  row.querySelector(".line-variant").innerHTML =
    '<option value="">Base configuration</option>' +
    options(p?.variants || [], (x) => `${x.name} +${money(x.modifier)}`);
  if (variant) row.querySelector(".line-variant").value = variant;
  updateQuoteLine(key);
}
function updateQuoteLine(key) {
  const row = quoteRow(key),
    p = catalogData.products.find(
      (x) => x.id === row.querySelector(".line-product").value,
    );
  const variant = p?.variants.find(
    (x) => x.id === row.querySelector(".line-variant").value,
  );
  const price = (p?.price || 0) + (variant?.modifier || 0);
  row.querySelector(".line-price").textContent = money(price);
  row.querySelector(".line-subtotal").textContent = money(
    price * Number(row.querySelector(".line-quantity").value),
  );
  text("quote-totals", "Preview totals again after changes.");
}
function removeQuoteLine(key) {
  if ($("quote-lines").children.length <= 1)
    return text("quote-error", "Keep at least one product line.");
  quoteRow(key).remove();
  text("quote-totals", "Preview totals again after changes.");
}
function quoteLines() {
  const rows = Array.from($("quote-lines").children);
  if (!rows.length) throw new Error("Add a product line.");
  return rows.map((row) => ({
    product_id: row.querySelector(".line-product").value,
    variant_id: row.querySelector(".line-variant").value || null,
    quantity: Number(row.querySelector(".line-quantity").value),
  }));
}
function applyQuotationTemplate() {
  const template = catalogData.templates.find(
    (x) => x.id === $("quote-template").value,
  );
  if (!template) return;
  $("quote-plan").value = template.plan_id;
  $("quote-validity").value = template.validity_days;
  $("quote-lines").innerHTML = "";
  for (const line of template.lines) if (line.product_id) addQuoteLine(line);
  text(
    "quote-error",
    "Template applied. You can edit its lines and terms before saving.",
  );
}
function quotationPayload() {
  return {
    customer_id: $("quote-customer").value,
    plan_id: $("quote-plan").value,
    starts_on: $("quote-start").value,
    expires_on: $("quote-expiry").value || null,
    payment_days: Number($("quote-payment-days").value),
    validity_days: Number($("quote-validity").value),
    lines: quoteLines(),
  };
}
async function previewQuotation() {
  if (!$("quote-form").reportValidity()) return;
  try {
    const payload = quotationPayload();
    const d = await post("/subscriptions/preview", {
      ...payload,
      discount_id: await draftDiscount(payload.lines),
    });
    text(
      "quote-totals",
      `Subtotal ${money(d.subtotal)} · Discount −${money(d.discount)} · Tax ${money(d.tax)} · Total ${money(d.total)}`,
    );
    text("quote-error", "");
  } catch (e) {
    text("quote-error", e.message);
  }
}
async function draftDiscount(lines) {
  const code = $("quote-coupon").value.trim();
  if (!code) return null;
  const data = await post("/discounts/validate", {
    code,
    lines,
    target_date: $("quote-start").value,
    plan_id: $("quote-plan").value,
  });
  return data.discount_id;
}
async function saveQuotation() {
  const button = $("quote-save");
  if (button.disabled) return;
  button.disabled = true;
  try {
    const payload = quotationPayload();
    payload.discount_id = await draftDiscount(payload.lines);
    const data = await api(
      "/subscriptions" +
        (editingSubscriptionId ? "/" + editingSubscriptionId : ""),
      {
        method: editingSubscriptionId ? "PUT" : "POST",
        body: JSON.stringify(payload),
      },
    );
    editingSubscriptionId = null;
    await openSubscription(data.id);
  } catch (e) {
    text("quote-error", e.message);
  } finally {
    button.disabled = false;
  }
}
function cancelQuotationBuilder() {
  $("quotation-builder").hidden = true;
  if (quoteReturnId) openSubscription(quoteReturnId);
  else {
    currentSubscription = null;
    navigateTo("list");
  }
}
async function saveQuotationTemplate() {
  const button = $("quote-template-save");
  if (button.disabled) return;
  if (!$("quote-form").reportValidity()) return;
  button.disabled = true;
  try {
    await post("/quotation-templates", {
      name: $("quote-template-name").value.trim(),
      plan_id: $("quote-plan").value,
      validity_days: Number($("quote-validity").value),
      lines: quoteLines(),
    });
    await loadCatalog();
    $("quote-template").innerHTML =
      '<option value="">No template</option>' +
      options(catalogData.templates, (x) => x.name);
    text("quote-error", "Template saved.");
  } catch (e) {
    text("quote-error", e.message);
  } finally {
    button.disabled = false;
  }
}

function updateContractControls(s) {
  $("customer-back-to-portal").hidden = currentUser.role !== "CUSTOMER";
  $("renewal-form").hidden = true;
  $("subscription-edit").hidden =
    currentUser.role === "CUSTOMER" ||
    !["DRAFT", "QUOTATION"].includes(s.state);
  $("contract-coupon-card").hidden = currentUser.role === "CUSTOMER";
  $("subscription-billing").hidden = currentUser.role === "CUSTOMER";
  text("contract-coupon-result", "");
  document
    .querySelectorAll(
      "#view-form .o_form_sheet_bg,#view-form .o_form_statusbar",
    )
    .forEach((x) => (x.hidden = false));
  for (const state of [
    "draft",
    "quotation",
    "confirmed",
    "active",
    "paused",
    "closed",
  ])
    $("status-step-" + state)?.classList.toggle(
      "o_arrow_active",
      s.state === state.toUpperCase(),
    );
  const allowed = {
    QUOTE: currentUser.role !== "CUSTOMER" && s.state === "DRAFT",
    CONFIRM: s.state === "QUOTATION",
    ACTIVATE: currentUser.role !== "CUSTOMER" && s.state === "CONFIRMED",
    RENEW:
      ["ACTIVE", "PAUSED", "CLOSED"].includes(s.state) &&
      s.policies?.allow_renew,
    PAUSE: s.state === "ACTIVE" && s.policies?.allow_pause,
    RESUME: s.state === "PAUSED" && s.policies?.allow_pause,
    CLOSE: ["ACTIVE", "PAUSED"].includes(s.state) && s.policies?.allow_close,
  };
  for (const [action, visible] of Object.entries(allowed))
    $("subscription-" + action.toLowerCase()).hidden = !visible;
}
async function transitionContract(action, extra = {}) {
  try {
    await post("/subscriptions/" + currentSubscription.id + "/transition", {
      action,
      ...extra,
    });
    await openSubscription(currentSubscription.id);
  } catch (e) {
    notify(e);
  }
}
async function previewContractCoupon() {
  try {
    if (!currentSubscription?.id)
      throw new Error("Choose a saved subscription first.");
    const data = await post("/discounts/validate", {
      code: $("contract-coupon").value.trim(),
      subscription_id: currentSubscription.id,
    });
    text(
      "contract-coupon-result",
      `Eligible discount: ${money(data.discount_amount)}. Billing revalidates the saved rule.`,
    );
  } catch (e) {
    text("contract-coupon-result", e.message);
  }
}

function showContractTab(name) {
  $("contract-lines").hidden = name !== "lines";
  $("contract-info").hidden = name !== "info";
  for (const tab of ["lines", "info"])
    $("contract-tab-" + tab).classList.toggle("active", name === tab);
}
function renderContractInfo(s) {
  const policies = Object.entries(s.policies || {})
    .map(
      ([key, value]) =>
        `${key.replaceAll("_", " ")}: ${value ? "Allowed" : "Disabled"}`,
    )
    .join(" · ");
  $("contract-info").innerHTML =
    `<h3>Contract details</h3><p>Quotation valid until ${esc(s.quote_expires_on)} · Payment terms: ${esc(s.payment_days)} days</p><p>Billing: every ${esc(s.interval_count)} ${esc(s.interval.toLowerCase())} period(s) · Term ends: ${esc(s.expires_on || "Open ended")}</p><p>${esc(policies)}</p><h3>Activity</h3>${s.events.map((e) => `<p>${esc(e.created_at)} · ${esc(e.action)} · ${esc(e.detail)}</p>`).join("") || "<p>No activity recorded.</p>"}`;
}

function openRenewal() {
  const s = currentSubscription;
  if (!s?.id) return;
  const minimum = [today(), s.expires_on || today()].sort().at(-1);
  const day = new Date(minimum + "T12:00:00");
  day.setDate(day.getDate() + 1);
  const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  $("renewal-expiry").min = date;
  $("renewal-expiry").value = "";
  text("renewal-error", "");
  $("renewal-form").hidden = false;
  $("renewal-expiry").focus();
}
function closeRenewal() {
  $("renewal-form").hidden = true;
}
async function renewSubscription() {
  const button = $("renewal-save");
  if (button.disabled) return;
  button.disabled = true;
  try {
    await post("/subscriptions/" + currentSubscription.id + "/transition", {
      action: "RENEW",
      expires_on: $("renewal-expiry").value,
    });
    await openSubscription(currentSubscription.id);
  } catch (e) {
    text("renewal-error", e.message);
  } finally {
    button.disabled = false;
  }
}
