/* Flight Day admin — review, confirm, move and cancel bookings via /api/flight-day/admin/*. */
(() => {
  const SEATS = 8;
  const KEY_STORE = "fd-admin-key";
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let key = "";
  let data = { slots: [], bookings: [] };
  let filter = "all";

  try { key = sessionStorage.getItem(KEY_STORE) || ""; } catch {}

  async function api(path, opts = {}) {
    const res = await fetch(`/api/flight-day/${path}`, {
      ...opts,
      headers: { "x-admin-key": key, ...(opts.body ? { "content-type": "application/json" } : {}) },
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) {
      signOut("That password didn't work.");
      throw new Error("Not authorized.");
    }
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
    return body;
  }

  /* ---------- Sign in ---------- */

  $("#fda-login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    key = $("#fda-key").value.trim();
    $("#fda-login-error").textContent = "";
    if (await load()) {
      try { sessionStorage.setItem(KEY_STORE, key); } catch {}
    }
  });

  function signOut(msg = "") {
    key = "";
    try { sessionStorage.removeItem(KEY_STORE); } catch {}
    $("#fda-dash").hidden = true;
    $("#fda-signout").hidden = true;
    $("#fda-login").hidden = false;
    $("#fda-login-error").textContent = msg;
    $("#fda-key").value = "";
  }
  $("#fda-signout").addEventListener("click", () => signOut());

  async function load() {
    try {
      data = await api("admin/bookings");
    } catch (err) {
      if (key) $("#fda-login-error").textContent = err.message;
      return false;
    }
    $("#fda-login").hidden = true;
    $("#fda-dash").hidden = false;
    $("#fda-signout").hidden = false;
    $("#fda-csv").href = `/api/flight-day/manifest?key=${encodeURIComponent(key)}`;
    render();
    return true;
  }

  /* ---------- Render ---------- */

  function active(b) {
    return b.status !== "cancelled";
  }

  function matches(b) {
    if (filter !== "all" && b.status !== filter) return false;
    const q = $("#fda-search").value.trim().toLowerCase();
    if (!q) return true;
    const hay = [b.id, b.contact.name, b.contact.email, b.contact.phone, ...b.passengers.map((p) => p.name)].join(" ").toLowerCase();
    return hay.includes(q);
  }

  function render() {
    const { slots, bookings } = data;
    const act = bookings.filter(active);
    $("#st-pending").textContent = bookings.filter((b) => b.status === "pending").length;
    $("#st-confirmed").textContent = bookings.filter((b) => b.status === "confirmed").length;
    const pax = act.reduce((s, b) => s + b.passengers.length, 0);
    $("#st-pax").textContent = pax;
    $("#st-seats").textContent = `${pax} / ${slots.length * SEATS}`;

    const searching = filter !== "all" || $("#fda-search").value.trim();
    const out = [];
    for (const time of slots) {
      if (time === "14:40") out.push(`<div class="fda-break">Break · 14:00 – 14:40</div>`);
      const inSlot = bookings.filter((b) => b.slot === time);
      const shown = inSlot.filter(matches);
      if (searching && !shown.length) continue;
      out.push(slotHtml(time, inSlot, shown));
    }
    $("#fda-timeline").innerHTML = out.length
      ? out.join("")
      : `<div class="fda-empty-state">No bookings match.</div>`;
  }

  function slotHtml(time, inSlot, shown) {
    const conf = inSlot.filter((b) => b.status === "confirmed").reduce((s, b) => s + b.passengers.length, 0);
    const pend = inSlot.filter((b) => b.status === "pending").reduce((s, b) => s + b.passengers.length, 0);
    const kg = inSlot.filter(active).reduce((s, b) => s + b.passengers.reduce((t, p) => t + p.weightKg, 0), 0);
    const used = conf + pend;
    const over = used > SEATS;
    const empty = !inSlot.length;
    const pct = (n) => `${Math.min(100, (n / SEATS) * 100)}%`;
    return `
      <section class="fda-slot${over ? " over" : ""}${empty ? " empty" : ""}">
        <div class="fda-slot-head">
          <div class="fda-slot-time">${time}</div>
          <div class="fda-bar" title="${conf} confirmed, ${pend} pending"><i class="c" style="width:${pct(conf)}"></i><i class="p" style="width:${pct(pend)}"></i></div>
          <div class="fda-slot-meta">${empty ? "No bookings" : `<b>${used}/${SEATS}</b> seats${over ? " · OVERBOOKED" : ""} · ${Math.round(kg)} kg`}</div>
        </div>
        ${shown.map(bookingHtml).join("")}
      </section>`;
  }

  function bookingHtml(b) {
    const totalKg = b.passengers.reduce((s, p) => s + p.weightKg, 0);
    const wa = b.contact.phone.replace(/[^\d]/g, "");
    const options = data.slots
      .filter((t) => t !== b.slot)
      .map((t) => {
        const free = SEATS - data.bookings.filter((x) => x.slot === t && active(x)).reduce((s, x) => s + x.passengers.length, 0);
        const fits = free >= b.passengers.length;
        return `<option value="${t}"${fits ? "" : " disabled"}>${t} · ${free} free</option>`;
      })
      .join("");
    const history = (b.history ?? []).map((h) => `moved ${esc(h.from)} → ${esc(h.to)}`).join(", ");
    return `
      <article class="fda-bk ${esc(b.status)}" data-id="${esc(b.id)}">
        <div class="fda-bk-main">
          <div class="fda-bk-top">
            <span class="fda-chip ${esc(b.status)}">${esc(b.status)}</span>
            <span class="fda-bk-name">${esc(b.contact.name)}</span>
            <span class="fda-bk-contact">${b.passengers.length} pax · ref ${esc(b.id)} · ${new Date(b.createdAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
          </div>
          <div class="fda-bk-contact">
            <a href="tel:${esc(b.contact.phone)}">${esc(b.contact.phone)}</a>
            ${wa ? `<a href="https://wa.me/${wa}" target="_blank" rel="noopener">WhatsApp</a>` : ""}
            <a href="mailto:${esc(b.contact.email)}">${esc(b.contact.email)}</a>
          </div>
          <table class="fda-pax">
            <thead><tr><th>#</th><th>Passenger</th><th class="num">Age</th><th class="num">Weight</th></tr></thead>
            <tbody>${b.passengers.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.name)}</td><td class="num">${esc(p.age)}</td><td class="num">${esc(p.weightKg)} kg</td></tr>`).join("")}</tbody>
            <tfoot><tr><td></td><td>Total</td><td></td><td class="num">${Math.round(totalKg * 10) / 10} kg</td></tr></tfoot>
          </table>
          ${b.contact.notes ? `<p class="fda-notes"><b>Notes:</b> ${esc(b.contact.notes)}</p>` : ""}
          ${history ? `<p class="fda-history">History: ${history}</p>` : ""}
        </div>
        <div class="fda-actions">
          ${b.status !== "confirmed" ? `<button type="button" class="fda-confirm" data-act="confirm">${b.status === "cancelled" ? "↺ Reinstate &amp; confirm" : "✓ Confirm"}</button>` : ""}
          <div class="fda-move">
            <select aria-label="Move to flight"><option value="">Move to…</option>${options}</select>
            <button type="button" data-act="move">Move</button>
          </div>
          ${b.status !== "cancelled" ? `<button type="button" class="fda-cancel" data-act="cancel">Cancel booking</button>` : ""}
          ${b.driveFolderUrl ? `<a class="fda-drive" href="${esc(b.driveFolderUrl)}" target="_blank" rel="noopener">Passports in Drive ↗</a>` : ""}
        </div>
      </article>`;
  }

  /* ---------- Actions ---------- */

  $("#fda-timeline").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const card = btn.closest(".fda-bk");
    const b = data.bookings.find((x) => x.id === card.dataset.id);
    const action = btn.dataset.act;
    const notify = $("#fda-notify").checked;
    const body = { action, notify };

    if (action === "move") {
      body.slot = $("select", card).value;
      if (!body.slot) return flash("Choose a flight time to move to first.", "err");
      if (!confirm(`Move ${b.contact.name} (${b.passengers.length} pax) from ${b.slot} to ${body.slot}?${notify ? "\n\nThe guest will be emailed the new time." : ""}`)) return;
    }
    if (action === "cancel" && !confirm(`Cancel the booking for ${b.contact.name} (${b.passengers.length} pax, ${b.slot})? Their seats will be released.${notify ? "\n\nThe guest will be emailed." : ""}`)) return;

    card.querySelectorAll("button").forEach((x) => (x.disabled = true));
    try {
      const res = await api(`admin/bookings/${encodeURIComponent(b.id)}`, { method: "POST", body: JSON.stringify(body) });
      Object.assign(b, res.booking);
      flash(`${b.contact.name}: ${action === "move" ? `moved to ${b.slot}` : action === "confirm" ? "confirmed" : "cancelled"}${notify ? " · guest emailed" : ""}.`, "ok");
      render();
    } catch (err) {
      flash(err.message, "err");
      card.querySelectorAll("button").forEach((x) => (x.disabled = false));
    }
  });

  let flashTimer;
  function flash(msg, kind) {
    const el = $("#fda-msg");
    el.textContent = msg;
    el.className = `fda-msg ${kind}`;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (el.textContent = ""), 6000);
  }

  function setFilter(f) {
    filter = f;
    document.querySelectorAll(".fda-filters button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.filter === f)));
    render();
  }
  document.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => setFilter(b.dataset.filter)));
  $("#fda-search").addEventListener("input", render);
  $("#fda-refresh").addEventListener("click", async () => {
    if (await load()) flash("Refreshed.", "ok");
  });

  if (key) load();
})();
