/**
 * Transactional email for the console (verification and password reset).
 *
 * Primary: Cloudflare Email Service REST API, sending as
 * "Bridgistic" <noreply@bridgistic.app> with Reply-To support@bridgistic.app.
 * bridgistic.app is onboarded for Email Sending (DKIM d=bridgistic.app on the
 * cf-bounce selector, SPF on the cf-bounce return path), so DMARC aligns.
 * Secrets: CF_EMAIL_API_TOKEN (Email Sending: Edit) and CF_EMAIL_ACCOUNT_ID.
 *
 * Fallback: the Hostinger Mail API (HOSTINGER_MAIL_TOKEN + HOSTINGER_MAILBOX_ID),
 * used only when Cloudflare is not configured or rejects the send.
 *
 * Never logs addresses, tokens or message links.
 */
export interface MailEnv {
  CF_EMAIL_API_TOKEN?: string;
  CF_EMAIL_ACCOUNT_ID?: string;
  MAIL_FROM?: string;
  MAIL_FROM_NAME?: string;
  MAIL_REPLY_TO?: string;
  HOSTINGER_MAIL_TOKEN?: string;
  HOSTINGER_MAILBOX_ID?: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export const DEFAULT_FROM = "noreply@bridgistic.app";
export const DEFAULT_FROM_NAME = "Bridgistic";
export const DEFAULT_REPLY_TO = "support@bridgistic.app";

export function cloudflareMailConfigured(env: MailEnv): boolean {
  return Boolean(env.CF_EMAIL_API_TOKEN && env.CF_EMAIL_ACCOUNT_ID);
}

export function hostingerMailConfigured(env: MailEnv): boolean {
  return Boolean(env.HOSTINGER_MAIL_TOKEN && env.HOSTINGER_MAILBOX_ID);
}

export function mailConfigured(env: MailEnv): boolean {
  return cloudflareMailConfigured(env) || hostingerMailConfigured(env);
}

/** The JSON body Cloudflare's /email/sending/send expects (snake_case, from.address). */
export function cloudflareMailBody(env: MailEnv, message: MailMessage): Record<string, unknown> {
  return {
    to: message.to,
    from: { address: env.MAIL_FROM || DEFAULT_FROM, name: env.MAIL_FROM_NAME || DEFAULT_FROM_NAME },
    reply_to: env.MAIL_REPLY_TO || DEFAULT_REPLY_TO,
    subject: message.subject,
    text: message.text,
    html: message.html,
  };
}

async function sendViaCloudflare(env: MailEnv, message: MailMessage): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(String(env.CF_EMAIL_ACCOUNT_ID))}/email/sending/send`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.CF_EMAIL_API_TOKEN}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(cloudflareMailBody(env, message)),
      }
    );
    const data = (await response.json().catch(() => ({}))) as { success?: boolean; result?: { permanent_bounces?: unknown[]; suppressed_recipients?: unknown[] } };
    const bounced = (data.result?.permanent_bounces?.length ?? 0) + (data.result?.suppressed_recipients?.length ?? 0) > 0;
    const ok = response.ok && data.success !== false && !bounced;
    if (!ok) console.error(JSON.stringify({ event: "mail_rejected", provider: "cloudflare", status: response.status, bounced }));
    return ok;
  } catch {
    console.error(JSON.stringify({ event: "mail_failed", provider: "cloudflare" }));
    return false;
  }
}

async function sendViaHostinger(env: MailEnv, message: MailMessage): Promise<boolean> {
  try {
    const response = await fetch(`https://api.mail.hostinger.com/api/v1/mailboxes/${encodeURIComponent(String(env.HOSTINGER_MAILBOX_ID))}/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.HOSTINGER_MAIL_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "bridgistic-console/1.0",
      },
      body: JSON.stringify({ to: [message.to], displayName: env.MAIL_FROM_NAME || DEFAULT_FROM_NAME, subject: message.subject, text: message.text, html: message.html }),
    });
    if (!response.ok) console.error(JSON.stringify({ event: "mail_rejected", provider: "hostinger", status: response.status }));
    return response.ok;
  } catch {
    console.error(JSON.stringify({ event: "mail_failed", provider: "hostinger" }));
    return false;
  }
}

export async function sendMail(env: MailEnv, message: MailMessage): Promise<boolean> {
  if (cloudflareMailConfigured(env)) {
    if (await sendViaCloudflare(env, message)) return true;
    if (!hostingerMailConfigured(env)) return false;
  }
  if (hostingerMailConfigured(env)) return sendViaHostinger(env, message);
  return false;
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
    <p style="color:#6f8299;font-size:12px;margin:18px 0 0">Bridgistic · WordPressistic LLC · Need help? Write to <a href="mailto:support@bridgistic.app" style="color:#C6A15B">support@bridgistic.app</a></p>
  </div>
</div>`;
  const text = `${opts.heading}\n\n${opts.intro}\n\n${opts.cta}: ${opts.link}\n\n${opts.footnote}\n\nBridgistic · WordPressistic LLC\nNeed help? Write to support@bridgistic.app`;
  return { html, text };
}
