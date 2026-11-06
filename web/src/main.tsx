import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./index.css";
import { Connect, GrantFailed, Share, Verify } from "./pages/Signup";
import { Activity, EarningsPage, GrantPage, Today } from "./pages/App";
import { Audit, Landing } from "./pages/Public";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/audit" element={<Audit />} />
        <Route path="/signup/verify" element={<Verify />} />
        <Route path="/signup/connect" element={<Connect />} />
        <Route path="/signup/share" element={<Share />} />
        <Route path="/signup/failed" element={<GrantFailed />} />
        <Route path="/app" element={<Navigate to="/app/today" replace />} />
        <Route path="/app/today" element={<Today />} />
        <Route path="/app/activity" element={<Activity />} />
        <Route path="/app/earnings" element={<EarningsPage />} />
        <Route path="/app/grant" element={<GrantPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
