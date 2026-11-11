import "./style.css";
import { readConfig, stripeSessionRequest, type Plan } from "./config.ts";

const cfg = readConfig(import.meta.env as Record<string, string>);
const note = document.getElementById("buy-note")!;
const buy = document.getElementById("buy") as HTMLButtonElement;
const planChoices = Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-plan-choice]"));
let selectedPlan: Plan = "monthly";

const planCopy: Record<Plan, { price: string; interval: string; description: string; button: string }> = {
  monthly: { price: "$12", interval: "USD per month", description: "A recurring plan for one license across 3 sites, with customer billing management.", button: "Continue to secure checkout" },
  yearly: { price: "$99", interval: "USD per year", description: "Annual billing for one license across 3 sites, with customer billing management.", button: "Continue to secure checkout · $99" },
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

async function openStripe(plan: Plan): Promise<void> {
  note.textContent = "Opening secure Stripe checkout…";
  try {
    const r = await fetch(cfg.stripeSessionUrl || "/api/stripe-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(stripeSessionRequest(plan, location.origin)),
    });
    const j = (await r.json().catch(() => null)) as { checkout_url?: string; url?: string; message?: string } | null;
    const checkoutUrl = j?.checkout_url ?? j?.url;
    if (!r.ok || !checkoutUrl) throw new Error(j?.message ?? "Stripe checkout is not available right now.");
    location.assign(checkoutUrl);
  } catch (e) {
    note.textContent = e instanceof Error ? e.message : String(e);
  }
}

const requested = new URLSearchParams(location.search).get("plan");
setPlan(requested === "yearly" ? "yearly" : "monthly");
for (const button of planChoices) button.addEventListener("click", () => setPlan((button.dataset.planChoice ?? "monthly") as Plan));
buy.addEventListener("click", async () => {
  if (!cfg.stripe) {
    note.textContent = "Checkout is temporarily unavailable. Email support@bridgistic.app.";
    return;
  }
  await openStripe(selectedPlan);
});
if (new URLSearchParams(location.search).get("thanks") === "1") {
  document.getElementById("thanks")?.removeAttribute("hidden");
  note.textContent = "Payment received. Check your email for account setup instructions.";
}
for (const d of document.querySelectorAll("details")) d.addEventListener("toggle", () => d.classList.toggle("open", d.open));
