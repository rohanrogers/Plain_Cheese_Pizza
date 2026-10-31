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
        `<tr><td>${esc(p.name)}</td><td>${esc(p.kind)}</td><td>${money(p.price)}</td><td>${money(p.cost)}</td><td>${p.variants.map((v) => `${esc(v.name)}: +${money(v.modifier)}`).join("<br>") || "Base configuration"}</td><td>${currentUser.role === "ADMIN" ? `<button class="btn btn-secondary" onclick="openAddVariantModal('${esc(p.id)}')">Add variant</button>` : "View only"}</td></tr>`,
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
function openCreateProductModal() {
  $("prod-new-tax").innerHTML =
    '<option value="">No tax</option>' +
    options(catalogData.taxes || [], (x) => `${x.name} (${x.rate_bps / 100}%)`);
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
    await post("/products", {
      name: $("prod-new-name").value.trim(),
      kind: $("prod-new-type").value,
      price: paise($("prod-new-sales-price").value),
      cost: paise($("prod-new-cost-price").value),
      notes: $("prod-new-notes").value,
      tax_id: $("prod-new-tax").value || null,
      variants,
    });
    closeCreateProductModal();
    await renderProductsView();
  } catch (e) {
    notify(e);
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
async function openQuotationBuilder() {
  try {
    await loadCatalog();
    const customers = (await api("/users")).filter(
      (x) => x.role === "CUSTOMER",
    );
    $("quote-customer").innerHTML = options(customers, (x) => x.name);
    $("quote-plan").innerHTML = options(catalogData.plans, (x) => x.name);
    $("quote-product").innerHTML = options(
      catalogData.products.filter((x) => x.active),
      (x) => x.name,
    );
    $("quote-template").innerHTML =
      '<option value="">No template</option>' +
      options(catalogData.templates, (x) => x.name);
    $("quote-start").value = today();
    populateQuoteVariants();
    currentSubscription = { number: "New quotation" };
    text("quote-error", "");
    $("contract-coupon-card").hidden = true;
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
function populateQuoteVariants() {
  const p = catalogData.products.find((x) => x.id === $("quote-product").value);
  $("quote-variant").innerHTML =
    '<option value="">Base configuration</option>' +
    options(p?.variants || [], (x) => x.name + " +" + money(x.modifier));
}
function quoteLines() {
  return [
    {
      product_id: $("quote-product").value,
      variant_id: $("quote-variant").value || null,
      quantity: Number($("quote-quantity").value),
    },
  ];
}
async function draftDiscount(lines) {
  const code = $("quote-coupon").value.trim();
  if (!code) return null;
  const data = await post("/discounts/validate", {
    code,
    lines,
    target_date: $("quote-start").value,
  });
  return data.discount_id;
}
async function saveQuotation() {
  const button = $("quote-save");
  if (button.disabled) return;
  button.disabled = true;
  try {
    let data;
    const template = $("quote-template").value;
    const selected = catalogData.templates.find((x) => x.id === template);
    const lines = selected
      ? selected.lines.map((l) => ({
          product_id: l.product_id,
          variant_id: l.variant_id || null,
          quantity: l.quantity,
        }))
      : quoteLines();
    const discount_id = await draftDiscount(lines);
    const shared = {
      customer_id: $("quote-customer").value,
      starts_on: $("quote-start").value,
      discount_id,
    };
    data = template
      ? await post("/subscriptions/from-template/" + template, shared)
      : await post("/subscriptions", {
          ...shared,
          plan_id: $("quote-plan").value,
          validity_days: Number($("quote-validity").value),
          lines,
        });
    document
      .querySelectorAll(
        "#view-form .o_form_sheet_bg,#view-form .o_form_statusbar",
      )
      .forEach((x) => (x.hidden = false));
    await openSubscription(data.id);
  } catch (e) {
    text("quote-error", e.message);
  } finally {
    button.disabled = false;
  }
}
async function saveQuotationTemplate() {
  const button = $("quote-template-save");
  if (button.disabled) return;
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
  $("contract-coupon-card").hidden = false;
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
    QUOTE: s.state === "DRAFT",
    CONFIRM: s.state === "QUOTATION",
    ACTIVATE: s.state === "CONFIRMED",
    PAUSE: s.state === "ACTIVE" && s.policies?.allow_pause,
    RESUME: s.state === "PAUSED" && s.policies?.allow_pause,
    CLOSE: ["ACTIVE", "PAUSED"].includes(s.state) && s.policies?.allow_close,
  };
  for (const [action, visible] of Object.entries(allowed))
    $("subscription-" + action.toLowerCase()).hidden = !visible;
}
async function transitionContract(action) {
  try {
    await post("/subscriptions/" + currentSubscription.id + "/transition", {
      action,
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
