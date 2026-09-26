/*
 * Jerusalem Flight Day — donor flight registration.
 *
 *   GET  /api/flight-day/slots     seats left per time slot
 *   POST /api/flight-day/register  multipart form: contact + passengers + passport files
 *   GET  /api/flight-day/manifest  CSV of active bookings (needs ?key=FLIGHT_DAY_ADMIN_KEY)
 *   GET  /api/flight-day/admin/bookings       all bookings (x-admin-key header)
 *   POST /api/flight-day/admin/bookings/:id   { action: confirm | cancel | move, slot?, notify? }
 *
 * A new signup is "pending": it holds its seats straight away and the guest is told
 * we'll confirm. Staff confirm, cancel or move it from /flight-day-admin; cancelled
 * bookings free their seats.
 *
 * Passports and a booking summary go to Google Drive (one subfolder per booking)
 * using the same OAuth refresh-token setup as the CRM's Drive uploads. Seat counts
 * live in the FLIGHT_DAY KV namespace. KV is eventually consistent, so two groups
 * booking the last seats of one slot in the same minute can both get through —
 * the admin page shows the overbooking and staff can move one group.
 */

import { sendMail } from "./mail.js";

export const EVENT = {
  name: "Hatzolah Air Jerusalem Flight Day",
  date: "2026-10-01",
  dateLabel: "Thursday, 1 October 2026",
  location: "Herzog Medical Center helipad, Jerusalem",
  seatsPerFlight: 8,
};

// Three flights an hour, 10:00 → 17:40, with the 14:20 slot left out as a break.
export const SLOTS = (() => {
  const out = [];
  for (let m = 10 * 60; m <= 17 * 60 + 40; m += 20) {
    const t = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    if (t !== "14:20") out.push(t);
  }
  return out;
})();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const FILE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
};

export async function handleFlightDay(request, env, url) {
  const route = url.pathname.replace(/^\/api\/flight-day\/?/, "");

  if (route === "slots" && request.method === "GET") return slotsResponse(env);
  if (route === "register" && request.method === "POST") return register(request, env);
  if (route === "manifest" && request.method === "GET") return manifest(env, url);

  if (route.startsWith("admin/")) {
    if (!isAdmin(env, request.headers.get("x-admin-key"))) return json({ error: "Not authorized." }, 401);
    if (route === "admin/bookings" && request.method === "GET") return adminList(env);
    const m = route.match(/^admin\/bookings\/([\w-]+)$/);
    if (m && request.method === "POST") return adminUpdate(request, env, m[1]);
  }

  return json({ error: "Not found." }, 404);
}

/* ---------- Seats ---------- */

async function listBookings(env) {
  if (!env.FLIGHT_DAY) return [];
  const out = [];
  let cursor;
  do {
    const page = await env.FLIGHT_DAY.list({ prefix: "booking:", cursor });
    out.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

async function seatsTaken(env) {
  const taken = Object.fromEntries(SLOTS.map((s) => [s, 0]));
  for (const key of await listBookings(env)) {
    const slot = key.metadata?.slot;
    if (key.metadata?.status === "cancelled") continue;
    if (slot in taken) taken[slot] += Number(key.metadata?.pax) || 0;
  }
  return taken;
}

async function slotsResponse(env) {
  const taken = await seatsTaken(env);
  return json(
    {
      event: EVENT,
      slots: SLOTS.map((time) => ({
        time,
        remaining: Math.max(0, EVENT.seatsPerFlight - taken[time]),
      })),
    },
    200,
    { "cache-control": "no-store" }
  );
}

/* ---------- Registration ---------- */

async function register(request, env) {
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET || !env.GOOGLE_OAUTH_REFRESH_TOKEN || !env.FLIGHT_DAY_DRIVE_FOLDER_ID) {
    console.error("Flight day: Google Drive secrets are not configured.");
    return json({ error: "Registration isn't open yet. Please try again later." }, 500);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }

  if (String(form.get("company") ?? "")) return json({ ok: true }); // honeypot

  const contact = {
    name: clean(form.get("contactName"), 120),
    phone: clean(form.get("contactPhone"), 40),
    email: clean(form.get("contactEmail"), 200),
    notes: clean(form.get("notes"), 1000),
  };
  const slot = String(form.get("slot") ?? "");

  if (!SLOTS.includes(slot)) return json({ error: "Please choose a flight time." }, 400);
  if (!contact.name || !contact.phone || !contact.email) {
    return json({ error: "Contact name, phone and email are required." }, 400);
  }
  if (!EMAIL_RE.test(contact.email)) return json({ error: "Please enter a valid email address." }, 400);
  if (form.get("consent") !== "yes") return json({ error: "Please confirm the declaration at the bottom of the form." }, 400);

  let rawPassengers;
  try {
    rawPassengers = JSON.parse(String(form.get("passengers") ?? "[]"));
  } catch {
    return json({ error: "Invalid passenger list." }, 400);
  }
  if (!Array.isArray(rawPassengers) || rawPassengers.length < 1) {
    return json({ error: "Please add at least one passenger." }, 400);
  }
  if (rawPassengers.length > EVENT.seatsPerFlight) {
    return json({ error: `A flight seats up to ${EVENT.seatsPerFlight} passengers. Larger groups, please register a second flight.` }, 400);
  }

  const passengers = [];
  for (let i = 0; i < rawPassengers.length; i++) {
    const p = rawPassengers[i] ?? {};
    const n = i + 1;
    const name = clean(p.name, 120);
    const age = Number(p.age);
    const weightKg = Number(p.weightKg);
    const file = form.get(`passport_${i}`);

    if (!name) return json({ error: `Passenger ${n}: full name is required.` }, 400);
    if (!Number.isInteger(age) || age < 0 || age > 110) return json({ error: `Passenger ${n}: please enter a valid age.` }, 400);
    if (!Number.isFinite(weightKg) || weightKg < 3 || weightKg > 250) return json({ error: `Passenger ${n}: please enter a valid weight.` }, 400);
    if (!(file instanceof File) || file.size === 0) return json({ error: `Passenger ${n}: please attach a passport copy.` }, 400);
    if (file.size > MAX_FILE_BYTES) return json({ error: `Passenger ${n}: the passport file is larger than 10 MB.` }, 400);
    if (!FILE_TYPES[file.type]) return json({ error: `Passenger ${n}: passport must be a photo (JPG/PNG/HEIC) or PDF.` }, 400);

    passengers.push({ name, age, weightKg: Math.round(weightKg * 10) / 10, file });
  }

  const taken = await seatsTaken(env);
  const remaining = EVENT.seatsPerFlight - taken[slot];
  if (passengers.length > remaining) {
    return json(
      {
        error: remaining > 0
          ? `Only ${remaining} seat${remaining === 1 ? "" : "s"} left on the ${slot} flight. Please pick another time or split your group.`
          : `The ${slot} flight is now full. Please pick another time.`,
        code: "slot_full",
      },
      409
    );
  }

  const id = crypto.randomUUID().slice(0, 8);
  const surname = contact.name.split(/\s+/).pop();
  const totalKg = passengers.reduce((s, p) => s + p.weightKg, 0);

  let folder;
  try {
    const token = await googleAccessToken(env);
    folder = await driveCreateFolder(
      token,
      `${slot.replace(":", "")} · ${surname} · ${passengers.length} pax · ${id}`,
      env.FLIGHT_DAY_DRIVE_FOLDER_ID
    );
    for (const p of passengers) {
      const ext = FILE_TYPES[p.file.type];
      await driveUploadFile(token, `Passport – ${p.name}.${ext}`, p.file.type, new Uint8Array(await p.file.arrayBuffer()), folder.id);
    }
    await driveUploadFile(
      token,
      `Booking summary – ${slot} – ${contact.name}`,
      "text/html",
      new TextEncoder().encode(summaryHtml({ id, slot, contact, passengers, totalKg })),
      folder.id,
      "application/vnd.google-apps.document"
    );
  } catch (err) {
    console.error("Flight day: Drive upload failed:", err);
    return json({ error: "We couldn't save your registration right now. Please try again in a few minutes." }, 502);
  }

  const record = {
    id,
    slot,
    status: "pending",
    createdAt: new Date().toISOString(),
    contact,
    passengers: passengers.map(({ name, age, weightKg }) => ({ name, age, weightKg })),
    totalKg,
    driveFolderId: folder.id,
    driveFolderUrl: folder.webViewLink,
  };
  if (env.FLIGHT_DAY) await saveBooking(env, record);

  await notifyNew(env, record, new URL(request.url).origin).catch((err) => console.error("Flight day: email failed:", err));

  return json({ ok: true, id, slot, status: "pending", passengers: passengers.length });
}

/* ---------- Manifest (ops) ---------- */

async function manifest(env, url) {
  if (!isAdmin(env, url.searchParams.get("key"))) return json({ error: "Not authorized." }, 401);

  const rows = [["Flight", "Status", "Booking", "Passenger", "Age", "Weight (kg)", "Contact", "Phone", "Email", "Drive folder", "Registered"]];
  const keys = (await listBookings(env)).sort((a, b) => a.name.localeCompare(b.name));
  for (const key of keys) {
    const b = JSON.parse((await env.FLIGHT_DAY.get(key.name)) ?? "null");
    if (!b || b.status === "cancelled") continue;
    for (const p of b.passengers) {
      rows.push([b.slot, b.status ?? "pending", b.id, p.name, p.age, p.weightKg, b.contact.name, b.contact.phone, b.contact.email, b.driveFolderUrl, b.createdAt]);
    }
  }
  const csv = "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="flight-day-manifest-${EVENT.date}.csv"`,
      "cache-control": "no-store",
    },
  });
}

/* ---------- Google Drive (REST) ---------- */

async function googleAccessToken(env) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: env.GOOGLE_OAUTH_REFRESH_TOKEN.trim(),
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`Google token error ${res.status}: ${data.error ?? ""}`);
  return data.access_token;
}

async function driveCreateFolder(token, name, parentId) {
  const res = await fetch("https://www.googleapis.com/drive/v3/files?fields=id,webViewLink&supportsAllDrives=true", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
  });
  if (!res.ok) throw new Error(`Drive folder create ${res.status}: ${await res.text()}`);
  return res.json();
}

async function driveUploadFile(token, name, contentType, bytes, parentId, convertTo) {
  const boundary = `fd-${crypto.randomUUID()}`;
  const meta = { name, parents: [parentId], ...(convertTo ? { mimeType: convertTo } : {}) };
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\ncontent-type: ${contentType}\r\n\r\n`
  );
  const tail = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);

  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Drive upload ${res.status}: ${await res.text()}`);
  return res.json();
}

/* ---------- Summary + email ---------- */

function summaryHtml({ id, slot, contact, passengers, totalKg }) {
  const rows = passengers
    .map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.name)}</td><td>${p.age}</td><td>${p.weightKg} kg</td></tr>`)
    .join("");
  return `<html><body style="font-family:Arial,sans-serif">
<h1>${esc(EVENT.name)}</h1>
<p><b>${esc(EVENT.dateLabel)}</b> · Flight <b>${slot}</b> · ${esc(EVENT.location)}</p>
<p>Booking ref: ${id}</p>
<h2>Contact</h2>
<p>${esc(contact.name)}<br>${esc(contact.phone)}<br>${esc(contact.email)}</p>
${contact.notes ? `<p><i>Notes:</i> ${esc(contact.notes).replace(/\n/g, "<br>")}</p>` : ""}
<h2>Passengers (${passengers.length})</h2>
<table border="1" cellpadding="6" style="border-collapse:collapse">
<tr><th>#</th><th>Full name</th><th>Age</th><th>Weight</th></tr>${rows}
<tr><td></td><td><b>Total</b></td><td></td><td><b>${Math.round(totalKg * 10) / 10} kg</b></td></tr>
</table>
</body></html>`;
}

async function notifyNew(env, b, origin) {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) return;

  await sendMail(env, {
    to: env.FLIGHT_DAY_NOTIFY_EMAIL || env.CONTACT_TO_EMAIL || env.GMAIL_USER,
    replyTo: { name: b.contact.name, email: b.contact.email },
    subject: `Flight Day request ${b.slot} — ${b.contact.name} (${b.passengers.length} pax) — needs approval`,
    text:
      `New Flight Day request (${b.id}) — pending your approval.\n\n` +
      `Flight: ${b.slot}\nContact: ${b.contact.name} · ${b.contact.phone} · ${b.contact.email}\n\n` +
      `Passengers:\n${b.passengers.map((p, i) => `${i + 1}. ${p.name} (${p.age}, ${p.weightKg} kg)`).join("\n")}\n` +
      `Total weight: ${Math.round(b.totalKg * 10) / 10} kg\n\n` +
      (b.contact.notes ? `Notes: ${b.contact.notes}\n\n` : "") +
      `Passports: ${b.driveFolderUrl}\n\nConfirm, move or cancel: ${origin}/flight-day-admin`,
  });

  await guestMail(env, b,
    `Request received — ${EVENT.name}, ${b.slot}`,
    `Thank you for registering for the ${EVENT.name}. We've received your request and are holding ` +
    `${b.passengers.length === 1 ? "a seat" : `${b.passengers.length} seats`} for you on the ${b.slot} flight.\n\n` +
    `Our team will review it and email you a confirmation shortly.`
  );
}

async function guestMail(env, b, subject, intro, extra = "") {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) return;
  await sendMail(env, {
    to: b.contact.email,
    subject,
    text:
      `Dear ${b.contact.name},\n\n${intro}\n\n` +
      `Date: ${EVENT.dateLabel}\nFlight time: ${b.slot}\nLocation: ${EVENT.location}\n\n` +
      `Passengers:\n${b.passengers.map((p, i) => `${i + 1}. ${p.name}`).join("\n")}\n\n` +
      extra +
      `Booking reference: ${b.id}\n\nWith thanks,\nHatzolah Air`,
  });
}

const CONFIRMED_NOTE =
  `Please arrive at least 20 minutes before your flight and bring the original passport or ID for every passenger.\n` +
  `Flights are subject to weather and operational conditions; our team will contact you if anything changes.\n\n`;

/* ---------- Admin ---------- */

function isAdmin(env, key) {
  const expected = env.FLIGHT_DAY_ADMIN_KEY;
  if (!expected || !key || key.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function saveBooking(env, b) {
  await env.FLIGHT_DAY.put(`booking:${b.slot}:${b.id}`, JSON.stringify(b), {
    metadata: { slot: b.slot, pax: b.passengers.length, status: b.status, id: b.id },
  });
}

async function findBooking(env, id) {
  const key = (await listBookings(env)).find((k) => k.metadata?.id === id || k.name.endsWith(`:${id}`));
  if (!key) return null;
  const b = JSON.parse((await env.FLIGHT_DAY.get(key.name)) ?? "null");
  return b && { key: key.name, booking: b };
}

async function adminList(env) {
  if (!env.FLIGHT_DAY) return json({ error: "Booking storage isn't configured." }, 500);
  const keys = await listBookings(env);
  const bookings = [];
  for (const k of keys) {
    const b = JSON.parse((await env.FLIGHT_DAY.get(k.name)) ?? "null");
    if (b) bookings.push({ status: "pending", ...b });
  }
  bookings.sort((a, b) => a.slot.localeCompare(b.slot) || a.createdAt.localeCompare(b.createdAt));
  return json({ event: EVENT, slots: SLOTS, bookings }, 200, { "cache-control": "no-store" });
}

async function adminUpdate(request, env, id) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  const found = await findBooking(env, id);
  if (!found) return json({ error: "Booking not found." }, 404);
  const { key, booking: b } = found;
  const notify = body.notify !== false;
  const now = new Date().toISOString();
  let mail = null;

  if (body.action === "confirm") {
    if (b.status === "cancelled") {
      const taken = await seatsTaken(env);
      if (b.passengers.length > EVENT.seatsPerFlight - taken[b.slot]) {
        return json({ error: `Not enough free seats on ${b.slot} to reinstate this booking. Move it instead.` }, 409);
      }
    }
    b.status = "confirmed";
    b.confirmedAt = now;
    mail = [`Confirmed — ${EVENT.name}, ${b.slot}`, `We're delighted to confirm your flight on the ${EVENT.name}.`, CONFIRMED_NOTE];
  } else if (body.action === "cancel") {
    b.status = "cancelled";
    b.cancelledAt = now;
    mail = [`Cancelled — ${EVENT.name}, ${b.slot}`, `Your booking for the ${b.slot} flight has been cancelled. If you weren't expecting this, just reply to this email.`];
  } else if (body.action === "move") {
    const to = String(body.slot ?? "");
    if (!SLOTS.includes(to)) return json({ error: "Please choose a valid flight time." }, 400);
    if (to === b.slot) return json({ error: "The booking is already on that flight." }, 400);
    const taken = await seatsTaken(env);
    const free = EVENT.seatsPerFlight - taken[to];
    if (b.passengers.length > free) return json({ error: `Only ${Math.max(0, free)} seats free on ${to}.` }, 409);
    const from = b.slot;
    b.slot = to;
    if (b.status === "cancelled") b.status = "pending";
    b.movedAt = now;
    b.history = [...(b.history ?? []), { from, to, at: now }];
    await env.FLIGHT_DAY.delete(key);
    await renameDriveFolder(env, b).catch((err) => console.error("Flight day: folder rename failed:", err));
    mail = [
      `New flight time ${to} — ${EVENT.name}`,
      `Your flight time has changed from ${from} to ${to}.` + (b.status === "pending" ? " Your booking is still awaiting final confirmation." : ""),
      b.status === "confirmed" ? CONFIRMED_NOTE : "",
    ];
  } else {
    return json({ error: "Unknown action." }, 400);
  }

  await saveBooking(env, b);
  if (notify && mail) await guestMail(env, b, ...mail).catch((err) => console.error("Flight day: email failed:", err));
  return json({ ok: true, booking: b });
}

async function renameDriveFolder(env, b) {
  if (!b.driveFolderId || !env.GOOGLE_OAUTH_REFRESH_TOKEN) return;
  const token = await googleAccessToken(env);
  const surname = b.contact.name.split(/\s+/).pop();
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${b.driveFolderId}?supportsAllDrives=true`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: `${b.slot.replace(":", "")} · ${surname} · ${b.passengers.length} pax · ${b.id}` }),
  });
  if (!res.ok) throw new Error(`Drive rename ${res.status}`);
}

/* ---------- helpers ---------- */

function clean(v, max) {
  return String(v ?? "").trim().slice(0, max);
}

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+\-@]/.test(s)) s = `'${s}`; // keep spreadsheet apps from treating a cell as a formula
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
