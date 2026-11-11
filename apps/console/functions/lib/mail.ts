/**
 * Transactional email for the console (verification and password reset),
 * sent through the Hostinger Mail API. Secrets: HOSTINGER_MAIL_TOKEN and
 * HOSTINGER_MAILBOX_ID. Never logs addresses' tokens or message links.
 */
export interface MailEnv {
  HOSTINGER_MAIL_TOKEN?: string;
  HOSTINGER_MAILBOX_ID?: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export function mailConfigured(env: MailEnv): boolean {
  return Boolean(env.HOSTINGER_MAIL_TOKEN && env.HOSTINGER_MAILBOX_ID);
}

export async function sendMail(env: MailEnv, message: MailMessage): Promise<boolean> {
  if (!mailConfigured(env)) return false;
  try {
    const response = await fetch(`https://api.mail.hostinger.com/api/v1/mailboxes/${encodeURIComponent(String(env.HOSTINGER_MAILBOX_ID))}/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.HOSTINGER_MAIL_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "bridgistic-console/1.0",
      },
      body: JSON.stringify({ to: [message.to], displayName: "Bridgistic", subject: message.subject, text: message.text, html: message.html }),
    });
    if (!response.ok) console.error(JSON.stringify({ event: "mail_rejected", status: response.status }));
    return response.ok;
  } catch {
    console.error(JSON.stringify({ event: "mail_failed" }));
    return false;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** One branded layout for every console email. */
export function brandedEmail(opts: { heading: string; intro: string; cta: string; link: string; footnote: string }): { html: string; text: string } {
  const html = `<div style="background:#0B1F3A;padding:32px;font-family:'Segoe UI',system-ui,sans-serif;color:#F4F1EA">
  <div style="max-width:520px;margin:0 auto;background:#10294a;border:1px solid #23406b;border-radius:16px;padding:32px">
    <table role="presentation" style="border-collapse:collapse"><tr><td style="padding:0 10px 0 0;vertical-align:middle"><img src="https://bridgistic.app/assets/bridgistic-icon-240.png" width="36" height="36" alt="Bridgistic" style="display:block;border:0;border-radius:8px"></td><td style="vertical-align:middle;font-size:22px;font-weight:700;color:#fff">Bridg<span style="color:#C6A15B">istic</span></td></tr></table>
    <h1 style="font-size:20px;color:#fff;margin:22px 0 8px">${escapeHtml(opts.heading)}</h1>
    <p style="color:#c9d2de;font-size:14px;line-height:1.55;margin:0 0 22px">${escapeHtml(opts.intro)}</p>
    <a href="${escapeHtml(opts.link)}" style="display:inline-block;background:#C6A15B;color:#0B1F3A;font-weight:700;font-size:15px;padding:12px 26px;border-radius:10px;text-decoration:none">${escapeHtml(opts.cta)}</a>
    <p style="color:#8fa0b5;font-size:12px;line-height:1.5;margin:22px 0 0">${escapeHtml(opts.footnote)}<br>If the button does not work, open this link: ${escapeHtml(opts.link)}</p>
    <p style="color:#6f8299;font-size:12px;margin:18px 0 0">Bridgistic · WordPressistic LLC</p>
  </div>
</div>`;
  const text = `${opts.heading}\n\n${opts.intro}\n\n${opts.cta}: ${opts.link}\n\n${opts.footnote}\n\nBridgistic · WordPressistic LLC`;
  return { html, text };
}
