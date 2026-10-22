#!/usr/bin/env node
/**
 * Sends correctly-signed Paddle-shaped webhook events to the deployed console
 * and verifies license issuance and cancellation handling end-to-end.
 * Usage: node scripts/webhook-test.mjs <webhook-url> <endpoint-secret> <buyer-email>
 */

import { createHmac } from "node:crypto";

const url = process.argv[2] ?? "https://admin.bridgistic.app/api/webhooks/paddle";
const secret = process.argv[3] ?? "";
const buyer = process.argv[4] ?? `paddle-buyer-${Date.now().toString(36)}@example.com`;

async function send(event) {
  const body = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const h1 = createHmac("sha256", secret).update(`${ts}:${body}`).digest("hex");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Paddle-Signature": `ts=${ts};h1=${h1}` },
    body,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

const stamp = Date.now().toString(36);

// 1. Tampered signature must be refused.
{
  const body = JSON.stringify({ event_type: "transaction.completed", data: {} });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Paddle-Signature": "ts=123;h1=deadbeef" },
    body,
  });
  check("tampered signature refused 403", res.status === 403);
}

// 2. A completed LTD transaction issues a lifetime license to the buyer email.
const txnId = `txn_01m5test${stamp}`;
const issued = await send({
  event_type: "transaction.completed",
  occurred_at: new Date().toISOString(),
  data: {
    id: txnId,
    status: "completed",
    customer_id: "ctm_01m5test",
    custom_data: { source: "pay.bridgistic.app", product: "bridgistic", offer: "welcome-lifetime", customer_email: buyer },
    items: [{ price: { id: "pri_01m58k6epsqzbr3qbab84t6p90" }, quantity: 1 }],
  },
});
check("transaction.completed issues a license", issued.status === 200 && issued.json?.ok === true && typeof issued.json?.license === "string", JSON.stringify(issued.json));

// 3. Redelivery of the same transaction is idempotent.
const replay = await send({
  event_type: "transaction.completed",
  occurred_at: new Date().toISOString(),
  data: {
    id: txnId,
    status: "completed",
    customer_id: "ctm_01m5test",
    custom_data: { customer_email: buyer },
    items: [{ price: { id: "pri_01m58k6epsqzbr3qbab84t6p90" }, quantity: 1 }],
  },
});
check("redelivery does not double-issue", replay.json?.duplicate === true, JSON.stringify(replay.json));

// 4. A monthly subscription transaction issues a monthly license with expiry.
const subBuyer = buyer.replace("@", `-sub@`);
const monthly = await send({
  event_type: "transaction.completed",
  occurred_at: new Date().toISOString(),
  data: {
    id: `txn_01m5sub${stamp}`,
    status: "completed",
    customer_id: "ctm_01m5sub",
    custom_data: { customer_email: subBuyer },
    items: [{ price: { id: "pri_01m1ykar8aq033865h68a4b9hh" }, quantity: 1 }],
  },
});
check("monthly transaction issues monthly license", monthly.json?.ok === true);

// 5. Subscription cancellation suspends the buyer's licenses.
const cancel = await send({
  event_type: "subscription.canceled",
  occurred_at: new Date().toISOString(),
  data: { id: `sub_01m5test${stamp}`, status: "canceled", customer_id: "ctm_01m5sub", custom_data: { customer_email: subBuyer } },
});
check("subscription.canceled suspends licenses", cancel.json?.ok === true && cancel.json?.suspended >= 1, JSON.stringify(cancel.json));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
