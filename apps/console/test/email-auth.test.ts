import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { makeD1 } from "./d1.ts";
import { handlePasswordForgot, handlePasswordReset, handleVerifyConfirm, handleVerifyResend, isEmailVerified, sendVerification } from "../functions/lib/email-auth.ts";
import { verifyPassword } from "../functions/lib/crypto.ts";

const sent: { to: string[]; subject: string; text: string }[] = [];
let env: { DB: D1Database; HOSTINGER_MAIL_TOKEN: string; HOSTINGER_MAILBOX_ID: string };
const post = (body: unknown) => new Request("https://admin.bridgistic.app/x", { method: "POST", body: JSON.stringify(body) });
const tokenFrom = (text: string) => /token=([a-f0-9]{64})/.exec(text)?.[1] ?? "";

beforeEach(async () => {
  sent.length = 0;
  env = { DB: await makeD1(), HOSTINGER_MAIL_TOKEN: "t", HOSTINGER_MAILBOX_ID: "AC1" };
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role) VALUES ('u1', 'buyer@example.com', 'B', 'x', 'member')").run();
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }); }));
});
afterEach(() => vi.unstubAllGlobals());

const user = async () => (await env.DB.prepare("SELECT * FROM users WHERE id = 'u1'").first<any>())!;

describe("email verification", () => {
  it("a new password account is unverified until it clicks the link", async () => {
    expect(isEmailVerified(await user())).toBe(false);
    expect((await sendVerification(env, { id: "u1", email: "buyer@example.com" })).sent).toBe(true);
    expect(sent[0].to).toEqual(["buyer@example.com"]);
    const token = tokenFrom(sent[0].text);
    expect((await handleVerifyConfirm(env, post({ token }))).status).toBe(200);
    expect(isEmailVerified(await user())).toBe(true);
    expect((await handleVerifyConfirm(env, post({ token }))).status).toBe(400); // single use
  });
  it("rejects garbage tokens and rate limits resends", async () => {
    expect((await handleVerifyConfirm(env, post({ token: "nope" }))).status).toBe(400);
    for (let i = 0; i < 3; i++) expect((await handleVerifyResend(env, await user())).status).toBe(200);
    expect((await handleVerifyResend(env, await user())).status).toBe(429);
  });
  it("staff count as verified", () => {
    expect(isEmailVerified({ role: "owner", email_verified_at: null })).toBe(true);
  });
});

describe("password reset", () => {
  it("answers the same for unknown emails and sends nothing", async () => {
    const r = await handlePasswordForgot(env, post({ email: "ghost@example.com" }));
    expect(r.status).toBe(200);
    expect(sent.length).toBe(0);
  });
  it("resets the password, verifies the email and signs out every session", async () => {
    await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES ('s1', 'u1', '2999-01-01')").run();
    await handlePasswordForgot(env, post({ email: "buyer@example.com" }));
    const token = tokenFrom(sent[0].text);
    expect((await handlePasswordReset(env, post({ token, password: "short" }))).status).toBe(400);
    expect((await handlePasswordReset(env, post({ token, password: "a-new-password" }))).status).toBe(200);
    const u = await user();
    expect(await verifyPassword("a-new-password", u.password_hash)).toBe(true);
    expect(isEmailVerified(u)).toBe(true);
    expect(await env.DB.prepare("SELECT id FROM sessions WHERE user_id = 'u1'").first()).toBeNull();
    expect((await handlePasswordReset(env, post({ token, password: "another-password" }))).status).toBe(400);
  });
});
