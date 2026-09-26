import { WorkerMailer } from "worker-mailer";

/** Sends one email through the org's Gmail account (GMAIL_USER / GMAIL_APP_PASSWORD). */
export async function sendMail(env, { to, replyTo, subject, text, html, fromName = "Hatzolah Air" }) {
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

  try {
    await mailer.send({
      from: { name: fromName, email: env.GMAIL_USER },
      to: { email: to },
      ...(replyTo ? { reply: replyTo } : {}), // worker-mailer calls the Reply-To field `reply`
      subject,
      text,
      ...(html ? { html } : {}),
    });
  } finally {
    await mailer.close();
  }
}
