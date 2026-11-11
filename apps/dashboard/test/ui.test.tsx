import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { App } from "../src/App.tsx";
import { StoreProvider } from "../src/lib/store.tsx";
import { ROADMAP } from "../src/lib/roadmap.ts";
import { toCsv } from "../src/pages/Audit.tsx";
import { byDay } from "../src/pages/Overview.tsx";
import { demoAudit } from "../src/lib/api/demo.ts";

class RO { observe() {} unobserve() {} disconnect() {} }
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;

const at = (path: string, mode?: "demo") => render(<MemoryRouter initialEntries={[path]}><StoreProvider initialMode={mode}><App /></StoreProvider></MemoryRouter>);

describe("dashboard", () => {
  it("waits for the session check, then shows sign-in without a session", async () => {
    at("/");
    expect(screen.getByText("Loading your dashboard…")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });
  it("labels demo mode on every screen", async () => {
    at("/snapshots", "demo");
    expect(screen.getByRole("note")).toHaveTextContent("sample data");
    expect(await screen.findByText("Before homepage title change")).toBeInTheDocument();
  });
  it("shows coming-soon sections as not functional", () => {
    at("/coming-soon", "demo");
    expect(screen.getAllByText("Coming soon").length).toBeGreaterThan(1);
  });
  it("roadmap copy has no exclamation marks", () => {
    for (const r of ROADMAP) expect(`${r.title} ${r.body}`).not.toContain("!");
  });
  it("audit CSV escapes quotes and never includes ip", () => {
    const csv = toCsv([{ ...demoAudit[0]!, summary: 'a "b"' }]);
    expect(csv).toContain('"a ""b"""');
    expect(csv.split("\n")[0]).not.toContain("ip");
  });
  it("groups audit by day", () => {
    expect(byDay(demoAudit).reduce((n, d) => n + d.count, 0)).toBe(demoAudit.length);
  });
});
