import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudflareMailBody, mailConfigured, sendMail } from "../functions/lib/mail.ts";

const msg = { to: "buyer@example.com", subject: "Confirm your Bridgistic email", text: "t", html: "<p>t</p>" };
const calls: { url: string; body: any; auth: string }[] = [];
const stub = (status: number, json: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).Authorization) });
    return new Response(JSON.stringify(json), { status });
  }));
afterEach(() => { vi.unstubAllGlobals(); calls.length = 0; });

describe("console mail", () => {
  it("sends from Bridgistic <noreply@bridgistic.app> with Reply-To support@ via Cloudflare", async () => {
    stub(200, { success: true, result: { delivered: ["buyer@example.com"], permanent_bounces: [], suppressed_recipients: [] } });
    const ok = await sendMail({ CF_EMAIL_API_TOKEN: "cf", CF_EMAIL_ACCOUNT_ID: "acc" }, msg);
    expect(ok).toBe(true);
    expect(calls[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/email/sending/send");
    expect(calls[0].body.from).toEqual({ address: "noreply@bridgistic.app", name: "Bridgistic" });
    expect(calls[0].body.reply_to).toBe("support@bridgistic.app");
    expect(calls[0].auth).toBe("Bearer cf");
  });
  it("falls back to Hostinger when Cloudflare rejects", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: "" });
      n++;
      return n === 1 ? new Response(JSON.stringify({ success: false }), { status: 403 }) : new Response(null, { status: 204 });
    }));
    const ok = await sendMail({ CF_EMAIL_API_TOKEN: "cf", CF_EMAIL_ACCOUNT_ID: "acc", HOSTINGER_MAIL_TOKEN: "h", HOSTINGER_MAILBOX_ID: "m" }, msg);
    expect(ok).toBe(true);
    expect(calls[1].url).toContain("api.mail.hostinger.com");
    expect(calls[1].body.displayName).toBe("Bridgistic");
  });
  it("treats a permanent bounce as not sent", async () => {
    stub(200, { success: true, result: { delivered: [], permanent_bounces: ["buyer@example.com"] } });
    expect(await sendMail({ CF_EMAIL_API_TOKEN: "cf", CF_EMAIL_ACCOUNT_ID: "acc" }, msg)).toBe(false);
  });
  it("is configured by either provider and overrides are honoured", () => {
    expect(mailConfigured({})).toBe(false);
    expect(mailConfigured({ CF_EMAIL_API_TOKEN: "a", CF_EMAIL_ACCOUNT_ID: "b" })).toBe(true);
    expect(mailConfigured({ HOSTINGER_MAIL_TOKEN: "a", HOSTINGER_MAILBOX_ID: "b" })).toBe(true);
    const body = cloudflareMailBody({ MAIL_FROM: "hello@bridgistic.app", MAIL_FROM_NAME: "B", MAIL_REPLY_TO: "x@bridgistic.app" }, msg);
    expect(body.from).toEqual({ address: "hello@bridgistic.app", name: "B" });
    expect(body.reply_to).toBe("x@bridgistic.app");
  });
});
