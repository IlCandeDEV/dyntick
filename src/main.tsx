import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
// CSS is bundled by Vite; Deno checks the side-effect import through this declaration.
// @deno-types="./styles.d.ts"
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Dyntick's root container could not be found.");

createRoot(container).render(<StrictMode><App /></StrictMode>);
