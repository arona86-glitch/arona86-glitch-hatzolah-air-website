/* Jerusalem Flight Day — registration form. Talks to /api/flight-day/* in worker.js. */
(() => {
  const SEATS = 8;
  const LB_PER_KG = 2.20462;
  const MAX_FILE = 10 * 1024 * 1024;

  // Same schedule as src/flight-day.js; used until /api/flight-day/slots answers.
  const DEFAULT_SLOTS = [];
  for (let m = 600; m <= 1060; m += 20) {
    const t = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    if (t !== "14:20") DEFAULT_SLOTS.push({ time: t, remaining: SEATS });
  }

  const $ = (s, el = document) => el.querySelector(s);
  const form = $("#fd-form");
  const paxList = $("#fd-passengers");
  const tpl = $("#fd-passenger-tpl");
  const addBtn = $("#fd-add");
  const submitBtn = $("#fd-submit");
  const status = $("#fd-status");
  const progress = $("#fd-progress");

  let slots = DEFAULT_SLOTS;
  let selected = null;
  let unit = "kg";

  /* ---------- Slots ---------- */

  function remainingFor(time) {
    return slots.find((s) => s.time === time)?.remaining ?? 0;
  }

  function renderSlots() {
    const am = $("#fd-slots-am");
    const pm = $("#fd-slots-pm");
    am.innerHTML = pm.innerHTML = "";
    const pax = paxCount();

    for (const s of slots) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "fd-slot";
      b.setAttribute("role", "radio");
      b.dataset.time = s.time;
      const full = s.remaining === 0;
      const tooSmall = !full && s.remaining < pax;
      b.disabled = full;
      if (!full && s.remaining <= 3) b.classList.add("low");
      b.setAttribute("aria-checked", String(s.time === selected));
      b.innerHTML = `<b>${s.time}</b><small>${full ? "Full" : `${s.remaining} seat${s.remaining === 1 ? "" : "s"} left`}</small>`;
      if (tooSmall) b.title = `Only ${s.remaining} seats left — fewer than your group`;
      b.addEventListener("click", () => selectSlot(s.time));
      (s.time < "14:20" ? am : pm).appendChild(b);
    }
    updateSummary();
  }

  function selectSlot(time) {
    selected = time;
    document.querySelectorAll(".fd-slot").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.time === time)));
    updateSummary();
  }

  async function loadSlots() {
    try {
      const res = await fetch("/api/flight-day/slots", { cache: "no-store" });
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (Array.isArray(data.slots) && data.slots.length) slots = data.slots;
    } catch {
      /* keep defaults — the server re-checks seats on submit anyway */
    }
    if (selected && remainingFor(selected) === 0) selected = null;
    renderSlots();
  }

  /* ---------- Passengers ---------- */

  function paxCount() {
    return paxList.children.length;
  }

  function addPassenger() {
    if (paxCount() >= SEATS) return;
    const node = tpl.content.firstElementChild.cloneNode(true);
    const file = $('[data-f="passport"]', node);
    const idx = paxCount();
    // Give every input a unique id so labels are clickable and accessible.
    node.querySelectorAll(".form-row").forEach((row) => {
      const input = $("input", row);
      const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}-${input.dataset.f}`;
      input.id = id;
      $("label", row).htmlFor = id;
    });
    $(".fd-unit-label", node).textContent = `(${unit})`;
    $(".fd-remove", node).addEventListener("click", () => {
      node.remove();
      renumber();
    });
    file.addEventListener("change", () => onFile(node, file));
    node.addEventListener("input", (e) => {
      e.target.removeAttribute("aria-invalid");
      updateSummary();
    });
    paxList.appendChild(node);
    renumber();
    if (idx > 0) $('[data-f="name"]', node).focus();
  }

  function renumber() {
    [...paxList.children].forEach((n, i) => {
      $(".fd-pax-title", n).textContent = `Passenger ${i + 1}`;
    });
    addBtn.disabled = paxCount() >= SEATS;
    addBtn.textContent = paxCount() >= SEATS ? `Maximum ${SEATS} passengers per flight` : "+ Add passenger";
    renderSlots();
  }

  function onFile(node, input) {
    const label = input.closest(".fd-file");
    const f = input.files[0];
    const thumb = $(".fd-file-thumb", label);
    label.classList.remove("invalid", "done");
    if (!f) return updateSummary();

    if (f.size > MAX_FILE && !/^image\/(jpeg|png|webp)$/.test(f.type)) {
      input.value = "";
      label.classList.add("invalid");
      $(".fd-file-text small", label).textContent = "That file is over 10 MB — please choose a smaller one.";
      return updateSummary();
    }
    label.classList.add("done");
    $(".fd-file-text b", label).textContent = f.name;
    $(".fd-file-text small", label).textContent = `Attached · ${(f.size / 1024 / 1024).toFixed(1)} MB`;
    $(".fd-file-btn", label).textContent = "Change";
    if (f.type.startsWith("image/")) {
      const img = new Image();
      img.alt = "";
      img.src = URL.createObjectURL(f);
      img.onerror = () => img.remove(); // e.g. HEIC on non-Safari: keep the icon
      thumb.replaceChildren(img);
    }
    updateSummary();
  }

  /* ---------- Units ---------- */

  document.querySelectorAll(".fd-units button").forEach((btn) =>
    btn.addEventListener("click", () => {
      const next = btn.dataset.unit;
      if (next === unit) return;
      document.querySelectorAll('[data-f="weight"]').forEach((i) => {
        if (i.value === "") return;
        const v = Number(i.value);
        i.value = (next === "lb" ? v * LB_PER_KG : v / LB_PER_KG).toFixed(next === "lb" ? 0 : 1).replace(/\.0$/, "");
      });
      unit = next;
      document.querySelectorAll(".fd-units button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.unit === unit)));
      document.querySelectorAll(".fd-unit-label").forEach((l) => (l.textContent = `(${unit})`));
    })
  );

  /* ---------- Summary ---------- */

  function updateSummary() {
    const pax = paxCount();
    const docs = [...paxList.querySelectorAll('[data-f="passport"]')].filter((i) => i.files.length).length;
    $("#fd-sum-time").textContent = selected ?? "—";
    $("#fd-sum-pax").textContent = pax;
    $("#fd-sum-docs").textContent = `${docs} / ${pax}`;
    $("#fd-sum-left").textContent = selected ? remainingFor(selected) : "—";

    const note = $("#fd-slot-note");
    if (selected && remainingFor(selected) < pax) {
      note.textContent = `The ${selected} flight has ${remainingFor(selected)} seat${remainingFor(selected) === 1 ? "" : "s"} left — pick another time or split your group across two flights.`;
      note.style.color = "#b45309";
    } else {
      note.textContent = selected ? `${selected} selected.` : "";
      note.style.color = "";
    }
  }

  /* ---------- Submit ---------- */

  function fail(msg, el) {
    status.textContent = msg;
    if (el) {
      if (el.matches?.("input")) el.setAttribute("aria-invalid", "true");
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.focus?.({ preventScroll: true });
    }
    return false;
  }

  function validate() {
    status.textContent = "";
    if (!selected) return fail("Please choose a flight time.", $(".fd-slot:not(:disabled)"));
    if (remainingFor(selected) < paxCount()) return fail(`Only ${remainingFor(selected)} seat${remainingFor(selected) === 1 ? " is" : "s are"} left on the ${selected} flight.`, $(`.fd-slot[data-time="${selected}"]`));

    for (const [i, node] of [...paxList.children].entries()) {
      const n = i + 1;
      const name = $('[data-f="name"]', node);
      const age = $('[data-f="age"]', node);
      const weight = $('[data-f="weight"]', node);
      const file = $('[data-f="passport"]', node);
      if (!name.value.trim()) return fail(`Passenger ${n}: please enter their full name.`, name);
      if (age.value === "" || !Number.isInteger(Number(age.value)) || age.value < 0 || age.value > 110) return fail(`Passenger ${n}: please enter a valid age.`, age);
      const kg = unit === "lb" ? Number(weight.value) / LB_PER_KG : Number(weight.value);
      if (weight.value === "" || !(kg >= 3 && kg <= 250)) return fail(`Passenger ${n}: please enter a valid weight in ${unit}.`, weight);
      if (!file.files.length) {
        file.closest(".fd-file").classList.add("invalid");
        return fail(`Passenger ${n}: please attach a copy of their passport.`, file.closest(".fd-file"));
      }
    }

    for (const id of ["contactName", "contactPhone", "contactEmail"]) {
      const el = $(`#${id}`);
      if (!el.value.trim() || (el.type === "email" && !el.checkValidity())) {
        return fail(id === "contactEmail" ? "Please enter a valid email address." : "Please complete the contact details.", el);
      }
    }
    if (!$("#consent").checked) return fail("Please tick the confirmation box.", $("#consent"));
    return true;
  }

  // Phone photos are often 4–8 MB; shrink big images so the upload is quick on mobile data.
  async function prepareFile(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1.5 * 1024 * 1024) return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
      if (!blob) return file;
      return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
    } catch {
      return file;
    }
  }

  function post(fd) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/flight-day/register");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) $("i", progress).style.width = `${Math.round((e.loaded / e.total) * 90)}%`;
      };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch {}
        resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
      };
      xhr.onerror = () => reject(new Error("Network error — please check your connection and try again."));
      xhr.send(fd);
    });
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validate()) return;

    submitBtn.disabled = true;
    submitBtn.textContent = "Uploading…";
    progress.hidden = false;
    $("i", progress).style.width = "4%";

    try {
      const fd = new FormData();
      fd.append("slot", selected);
      for (const k of ["contactName", "contactPhone", "contactEmail", "notes", "company"]) fd.append(k, $(`#${k}`).value.trim());
      fd.append("consent", "yes");

      const passengers = [];
      for (const [i, node] of [...paxList.children].entries()) {
        const w = Number($('[data-f="weight"]', node).value);
        passengers.push({
          name: $('[data-f="name"]', node).value.trim(),
          age: Number($('[data-f="age"]', node).value),
          weightKg: Math.round((unit === "lb" ? w / LB_PER_KG : w) * 10) / 10,
        });
        const file = await prepareFile($('[data-f="passport"]', node).files[0]);
        if (file.size > MAX_FILE) throw new Error(`Passenger ${i + 1}: the passport file is over 10 MB.`);
        fd.append(`passport_${i}`, file, file.name);
      }
      fd.append("passengers", JSON.stringify(passengers));

      const res = await post(fd);
      if (!res.ok) {
        if (res.data.code === "slot_full") loadSlots();
        throw new Error(res.data.error || "Something went wrong. Please try again.");
      }
      $("i", progress).style.width = "100%";
      showDone(passengers, $("#contactEmail").value.trim());
    } catch (err) {
      status.textContent = err.message;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Request seats";
      setTimeout(() => { progress.hidden = true; $("i", progress).style.width = "0"; }, 600);
    }
  });

  function showDone(passengers, email) {
    form.hidden = true;
    const done = $("#fd-done");
    $("#fd-done-title").textContent = `Seats held on the ${selected} flight`;
    $("#fd-done-body").textContent = `Thursday, 1 October 2026 · Herzog Medical Center helipad, Jerusalem. We've emailed ${email} — you'll hear from us again once your booking is confirmed.`;
    $("#fd-done-list").replaceChildren(...passengers.map((p) => Object.assign(document.createElement("li"), { textContent: p.name })));
    done.hidden = false;
    done.focus();
    done.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  $("#fd-another").addEventListener("click", () => {
    form.reset();
    paxList.replaceChildren();
    selected = null;
    addPassenger();
    $("#fd-done").hidden = true;
    form.hidden = false;
    loadSlots();
    $("#register").scrollIntoView({ behavior: "smooth" });
  });

  addBtn.addEventListener("click", addPassenger);
  addPassenger();
  renderSlots();
  loadSlots();
})();
