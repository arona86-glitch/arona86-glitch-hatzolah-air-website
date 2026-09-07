import { WorkerMailer } from "worker-mailer";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_LENGTHS = { name: 200, email: 200, message: 5000 };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/contact") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed." }, 405);
      }
      return handleContact(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleContact(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request body." }, 400);
  }

  const name = String(body.name ?? "").trim();
  const email = String(body.email ?? "").trim();
  const message = String(body.message ?? "").trim();

  if (!name || !email || !message) {
    return jsonResponse({ error: "Name, email, and message are required." }, 400);
  }
  if (!EMAIL_RE.test(email)) {
    return jsonResponse({ error: "Please enter a valid email address." }, 400);
  }
  if (name.length > MAX_LENGTHS.name || email.length > MAX_LENGTHS.email || message.length > MAX_LENGTHS.message) {
    return jsonResponse({ error: "One of the fields is too long." }, 400);
  }

  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    console.error("Contact form: GMAIL_USER/GMAIL_APP_PASSWORD secrets are not configured.");
    return jsonResponse({ error: "The contact form isn't set up yet. Please try again later." }, 500);
  }

  const to = env.CONTACT_TO_EMAIL || env.GMAIL_USER;

  try {
    const mailer = await WorkerMailer.connect({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      startTls: true,
      authType: "plain",
      credentials: {
        username: env.GMAIL_USER,
        password: env.GMAIL_APP_PASSWORD,
      },
    });

    await mailer.send({
      from: { name: "Hatzolah Air Website", email: env.GMAIL_USER },
      to: { email: to },
      replyTo: { name, email },
      subject: `Website contact form: ${name}`,
      text: `From: ${name} <${email}>\n\n${message}`,
      html: `<p><strong>From:</strong> ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;</p><p>${escapeHtml(message).replace(/\n/g, "<br>")}</p>`,
    });
  } catch (err) {
    console.error("Contact form send failed:", err);
    return jsonResponse({ error: "Couldn't send your message right now. Please try again later." }, 502);
  }

  return jsonResponse({ ok: true });
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
