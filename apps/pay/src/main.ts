import "./style.css";
import { availableProviders, checkoutOptions, checkoutReady, offerOpen, quantityReset, readConfig, remainingLabel, stripeSessionRequest, validEmail, type Plan, type Provider } from "./config.ts";

declare global { interface Window { Paddle?: { Environment: { set(e: string): void }; Initialize(o: { token: string; eventCallback?: (ev: any) => void }): void; Checkout: { open(o: unknown): void; updateItems(i: unknown): void } } } }

const cfg = readConfig(import.meta.env as Record<string, string>);
const note = document.getElementById("buy-note")!;
const emailEl = document.getElementById("buyer-email") as HTMLInputElement;
const emailNote = document.getElementById("email-note")!;
const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-plan]"));
let lastStatus: { open?: unknown; source?: unknown; remaining?: unknown } | null = null;

function render() {
  const open = offerOpen(Date.now(), lastStatus);
  for (const el of document.querySelectorAll<HTMLElement>("[data-when]")) el.hidden = el.dataset.when !== (open ? "open" : "closed");
  const rem = document.getElementById("remaining");
  const label = open ? remainingLabel(lastStatus) : null;
  if (rem) { rem.hidden = !label; rem.textContent = label ?? ""; }
}

async function refreshStatus(): Promise<void> {
  if (!/^(\/|https:\/\/)/.test(cfg.statusUrl)) return;
  try {
    const r = await fetch(cfg.statusUrl, { cache: "no-store" });
    const j = r.ok ? await r.json() : null;
    if (j && typeof j.open === "boolean") lastStatus = j;
  } catch { /* keep the date-only decision */ }
  render();
}

if (new URLSearchParams(location.search).get("thanks") === "1") document.getElementById("thanks")?.removeAttribute("hidden");
render();
void refreshStatus();

const providers = availableProviders(cfg);
const choice = document.getElementById("provider-choice") as HTMLFieldSetElement | null;
const selectedProvider = (): Provider => {
  const picked = document.querySelector<HTMLInputElement>('input[name="provider"]:checked')?.value as Provider | undefined;
  return picked && providers.includes(picked) ? picked : providers[0] ?? "paddle";
};
const syncNote = () => { const n = note.dataset[`${selectedProvider()}Note`]; if (n) note.textContent = n; };
if (choice && providers.length > 1) {
  choice.hidden = false;
  for (const r of choice.querySelectorAll<HTMLInputElement>('input[name="provider"]')) r.addEventListener("change", syncNote);
} else if (providers[0] === "stripe") {
  document.querySelector<HTMLInputElement>('input[name="provider"][value="stripe"]')?.click();
}

async function openStripe(email: string, plan: Plan): Promise<void> {
  note.textContent = "Opening secure Stripe checkout…";
  try {
    const r = await fetch(cfg.stripeSessionUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(stripeSessionRequest(email, plan, location.origin)) });
    const j = (await r.json().catch(() => null)) as { checkout_url?: string; url?: string; message?: string } | null;
    const checkoutUrl = j?.checkout_url ?? j?.url;
    if (!r.ok || !checkoutUrl) throw new Error(j?.message ?? "Stripe checkout is not available right now.");
    location.assign(checkoutUrl);
  } catch (e) {
    note.textContent = `${e instanceof Error ? e.message : String(e)} You can also pay with Paddle.`;
  }
}

if (providers.length === 0) {
  for (const b of buttons) b.disabled = true;
  note.textContent = "Checkout is not open yet. It opens once the Paddle client token is configured.";
} else {
  let openPriceId: string | null = null;
  if (providers.includes("paddle")) {
    // Buttons wait for Paddle.js only while Paddle is the selected provider.
    let paddleReady = false;
    const gate = () => { for (const b of buttons) b.disabled = selectedProvider() === "paddle" && !paddleReady; };
    gate();
    for (const r of document.querySelectorAll<HTMLInputElement>('input[name="provider"]')) r.addEventListener("change", gate);
    const s = document.createElement("script");
    s.src = "https://cdn.paddle.com/paddle/v2/paddle.js";
    s.onload = () => {
      if (!window.Paddle) return;
      if (cfg.env === "sandbox") window.Paddle.Environment.set("sandbox");
      window.Paddle.Initialize({
        token: cfg.token,
        eventCallback: (ev) => { const fix = quantityReset(ev, openPriceId); if (fix) window.Paddle?.Checkout.updateItems(fix); },
      });
      paddleReady = true;
      gate();
    };
    s.onerror = () => { note.textContent = providers.includes("stripe") ? "Paddle could not be loaded. You can pay with Stripe instead." : "The payment provider could not be loaded. Check your connection or try again later."; };
    document.head.appendChild(s);
  }
  for (const b of buttons) {
    b.addEventListener("click", async () => {
      const plan = (b.dataset.plan ?? "lifetime") as Plan;
      const email = emailEl.value.trim().toLowerCase();
      if (!validEmail(email)) {
        emailNote.textContent = "Enter the email for your license key, then continue.";
        emailEl.focus();
        return;
      }
      if (plan === "lifetime") {
        await refreshStatus();
        if (!offerOpen(Date.now(), lastStatus)) return; // closed meanwhile: the regular plans are now shown
      }
      if (selectedProvider() === "stripe") return void openStripe(email, plan);
      if (!checkoutReady(cfg, plan)) return;
      openPriceId = cfg.prices[plan];
      window.Paddle?.Checkout.open(checkoutOptions(cfg, email, plan));
    });
  }
}
for (const d of document.querySelectorAll("details")) d.addEventListener("toggle", () => d.classList.toggle("open", d.open));
