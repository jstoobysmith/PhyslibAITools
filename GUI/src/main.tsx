import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./theme/theme.css";
import "./components/components.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
