import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import "./index.css";
import { StoreProvider } from "./lib/store.tsx";

const demo = new URLSearchParams(location.search).get("demo") === "1" ? "demo" : undefined;
createRoot(document.getElementById("root")!).render(
  <StrictMode><BrowserRouter><StoreProvider initialMode={demo}><App /></StoreProvider></BrowserRouter></StrictMode>,
);
