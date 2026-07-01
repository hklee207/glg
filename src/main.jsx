import React from "react";
import { createRoot } from "react-dom/client";
import ValueChainExplorer from "./ValueChainExplorer.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ValueChainExplorer />
  </React.StrictMode>,
);
