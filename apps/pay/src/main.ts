import "./style.css";
import { checkoutOptions, checkoutReady, quantityReset, readConfig, stripeSessionRequest, validEmail, type Plan } from "./config.ts";

declare global { interface Window { Paddle?: { Environment: { set(e: string): void }; Initialize(o: { token: string; eventCallback?: (ev: any) => void }): void; Checkout: { open(o: unknown): void; updateItems(i: unknown): void } } } }

const cfg = readConfig(import.meta.env as Record<string, string>);
const note = document.getElementById("buy-note")!;
const emailEl = document.getElementById("buyer-email") as HTMLInputElement;
const emailNote = document.getElementById("email-note")!;
const buy = document.getElementById("buy") as HTMLButtonElement;
const planChoices = Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-plan-choice]"));
const paddleLifetime = document.querySelector<HTMLButtonElement>("button[data-paddle-lifetime]");
let selectedPlan: Plan = "monthly";
let openPriceId: string | null = null;
let paddleReady = false;

const planCopy: Record<Plan, { price: string; interval: string; description: string; button: string }> = {
  monthly: { price: "$12", interval: "USD per month", description: "A recurring plan for one license across 3 sites, with customer billing management.", button: "Choose monthly" },
  yearly: { price: "$99", interval: "USD per year", description: "Annual billing for one license across 3 sites, with customer billing management.", button: "Choose yearly · $99" },
  lifetime: { price: "$69", interval: "USD, one time", description: "One payment for one license on one site, with all future Bridgistic updates included.", button: "Choose Lifetime · $69" },
};

function setPlan(plan: Plan): void {
  selectedPlan = plan;
  const copy = planCopy[plan];
  document.getElementById("pro-price")!.textContent = copy.price;
  document.getElementById("pro-interval")!.textContent = copy.interval;
  document.getElementById("pro-description")!.textContent = copy.description;
  buy.textContent = copy.button;
  buy.dataset.plan = plan;
  for (const button of planChoices) {
    const active = button.dataset.planChoice === plan;
    button.classList.toggle("bg-navy", active);
    button.classList.toggle("text-ivory", active);
    button.setAttribute("aria-selected", String(active));
  }
}

async function openStripe(email: string, plan: Plan): Promise<void> {
  note.textContent = "Opening secure Stripe checkout…";
  try {
    const r = await fetch(cfg.stripeSessionUrl || "/api/stripe-checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(stripeSessionRequest(email, plan, location.origin)) });
    const j = (await r.json().catch(() => null)) as { checkout_url?: string; url?: string; message?: string } | null;
    const checkoutUrl = j?.checkout_url ?? j?.url;
    if (!r.ok || !checkoutUrl) throw new Error(j?.message ?? "Stripe checkout is not available right now.");
    location.assign(checkoutUrl);
  } catch (e) {
    note.textContent = `${e instanceof Error ? e.message : String(e)} You can also pay with Paddle.`;
  }
}

function emailOrFocus(): string | null {
  const email = emailEl.value.trim().toLowerCase();
  if (validEmail(email)) return email;
  emailNote.textContent = "Enter the email for your license key, then continue.";
  emailEl.focus();
  return null;
}

function openPaddle(email: string, plan: Plan): void {
  if (!paddleReady || !window.Paddle || !checkoutReady(cfg, plan)) {
    note.textContent = "Paddle is still loading. You can continue with Stripe, the default checkout.";
    return;
  }
  openPriceId = cfg.prices[plan];
  window.Paddle.Checkout.open(checkoutOptions(cfg, email, plan));
}

setPlan("monthly");
for (const button of planChoices) button.addEventListener("click", () => setPlan((button.dataset.planChoice ?? "monthly") as Plan));
buy.addEventListener("click", async () => {
  const email = emailOrFocus();
  if (!email) return;
  await openStripe(email, selectedPlan);
});
paddleLifetime?.addEventListener("click", () => {
  const email = emailOrFocus();
  if (email) openPaddle(email, "lifetime");
});

if (cfg.token && checkoutReady(cfg, "lifetime")) {
  const s = document.createElement("script");
  s.src = "https://cdn.paddle.com/paddle/v2/paddle.js";
  s.onload = () => {
    if (!window.Paddle) return;
    if (cfg.env === "sandbox") window.Paddle.Environment.set("sandbox");
    window.Paddle.Initialize({ token: cfg.token, eventCallback: (ev) => { const fix = quantityReset(ev, openPriceId); if (fix) window.Paddle?.Checkout.updateItems(fix); } });
    paddleReady = true;
  };
  s.onerror = () => { if (paddleLifetime) paddleLifetime.disabled = true; };
  document.head.appendChild(s);
}
for (const d of document.querySelectorAll("details")) d.addEventListener("toggle", () => d.classList.toggle("open", d.open));
