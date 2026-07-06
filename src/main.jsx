import React from "react";
import { createRoot } from "react-dom/client";
import ValueChainExplorer from "./ValueChainExplorer.jsx";
import AccessGate from "./AccessGate.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AccessGate>
      <ValueChainExplorer />
    </AccessGate>
  </React.StrictMode>,
);
