import "./style.css";
import { checkoutOptions, checkoutReady, readConfig } from "./config.ts";

declare global { interface Window { Paddle?: { Environment: { set(e: string): void }; Initialize(o: { token: string }): void; Checkout: { open(o: unknown): void } } } }

const cfg = readConfig(import.meta.env as Record<string, string>);
const btn = document.getElementById("buy") as HTMLButtonElement;
const note = document.getElementById("buy-note")!;

if (new URLSearchParams(location.search).get("thanks") === "1") document.getElementById("thanks")?.removeAttribute("hidden");

if (!checkoutReady(cfg)) {
  btn.disabled = true;
  note.textContent = "Checkout is not open yet. It opens once the Lifetime price is configured.";
} else {
  const s = document.createElement("script");
  s.src = "https://cdn.paddle.com/paddle/v2/paddle.js";
  s.onload = () => {
    if (!window.Paddle) return;
    if (cfg.env === "sandbox") window.Paddle.Environment.set("sandbox");
    window.Paddle.Initialize({ token: cfg.token });
    btn.disabled = false;
  };
  s.onerror = () => { note.textContent = "The payment provider could not be loaded. Check your connection or try again later."; };
  document.head.appendChild(s);
  btn.disabled = true;
  btn.addEventListener("click", () => window.Paddle?.Checkout.open(checkoutOptions(cfg)));
}
for (const d of document.querySelectorAll("details")) d.addEventListener("toggle", () => d.classList.toggle("open", d.open));
