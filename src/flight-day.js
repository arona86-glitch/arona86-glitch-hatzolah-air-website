/*
 * Jerusalem Flight Day — donor flight registration.
 *
 *   GET  /api/flight-day/slots     seats left per time slot
 *   POST /api/flight-day/register  multipart form: contact + passengers + passport files
 *   GET  /api/flight-day/manifest  CSV of all bookings (needs ?key=FLIGHT_DAY_ADMIN_KEY)
 *
 * Passports and a booking summary go to Google Drive (one subfolder per booking)
 * using the same OAuth refresh-token setup as the CRM's Drive uploads. Seat counts
 * live in the FLIGHT_DAY KV namespace. KV is eventually consistent, so two groups
 * booking the last seats of one slot in the same minute can both get through —
 * the manifest shows it and ops can move one group.
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
    createdAt: new Date().toISOString(),
    contact,
    passengers: passengers.map(({ name, age, weightKg }) => ({ name, age, weightKg })),
    totalKg,
    driveFolderUrl: folder.webViewLink,
  };
  if (env.FLIGHT_DAY) {
    await env.FLIGHT_DAY.put(`booking:${slot}:${id}`, JSON.stringify(record), {
      metadata: { slot, pax: passengers.length },
    });
  }

  await notify(env, record).catch((err) => console.error("Flight day: email failed:", err));

  return json({ ok: true, id, slot, passengers: passengers.length });
}

/* ---------- Manifest (ops) ---------- */

async function manifest(env, url) {
  if (!env.FLIGHT_DAY_ADMIN_KEY || url.searchParams.get("key") !== env.FLIGHT_DAY_ADMIN_KEY) {
    return json({ error: "Not authorized." }, 401);
  }

  const rows = [["Flight", "Booking", "Passenger", "Age", "Weight (kg)", "Contact", "Phone", "Email", "Drive folder", "Registered"]];
  const keys = (await listBookings(env)).sort((a, b) => a.name.localeCompare(b.name));
  for (const key of keys) {
    const b = JSON.parse((await env.FLIGHT_DAY.get(key.name)) ?? "null");
    if (!b) continue;
    for (const p of b.passengers) {
      rows.push([b.slot, b.id, p.name, p.age, p.weightKg, b.contact.name, b.contact.phone, b.contact.email, b.driveFolderUrl, b.createdAt]);
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

async function notify(env, b) {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) return;

  const list = b.passengers.map((p) => `${p.name} (${p.age}, ${p.weightKg} kg)`);
  const opsTo = env.FLIGHT_DAY_NOTIFY_EMAIL || env.CONTACT_TO_EMAIL || env.GMAIL_USER;

  await sendMail(env, {
    to: opsTo,
    replyTo: { name: b.contact.name, email: b.contact.email },
    subject: `Flight Day ${b.slot} — ${b.contact.name} (${b.passengers.length} pax)`,
    text:
      `New Flight Day registration (${b.id})\n\nFlight: ${b.slot}\nContact: ${b.contact.name} · ${b.contact.phone} · ${b.contact.email}\n\n` +
      `Passengers:\n${list.map((l, i) => `${i + 1}. ${l}`).join("\n")}\nTotal weight: ${Math.round(b.totalKg * 10) / 10} kg\n\n` +
      (b.contact.notes ? `Notes: ${b.contact.notes}\n\n` : "") +
      `Passports: ${b.driveFolderUrl}`,
  });

  await sendMail(env, {
    to: b.contact.email,
    subject: `You're registered — ${EVENT.name}, ${b.slot}`,
    text:
      `Dear ${b.contact.name},\n\nThank you for registering for the ${EVENT.name}.\n\n` +
      `Date: ${EVENT.dateLabel}\nFlight time: ${b.slot}\nLocation: ${EVENT.location}\n\n` +
      `Passengers:\n${b.passengers.map((p, i) => `${i + 1}. ${p.name}`).join("\n")}\n\n` +
      `Please arrive at least 20 minutes before your flight and bring the original passport or ID for every passenger.\n` +
      `Flights are subject to weather and operational conditions; our team will contact you if anything changes.\n\n` +
      `Booking reference: ${b.id}\n\nWith thanks,\nHatzolah Air`,
  });
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
