import { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuthStore } from "./authStore";
import { useConfigStore } from "./configStore";
import { GuestOnly, RequireAdmin, RequireAuth } from "./guards";
import Login from "./Login";
import Layout from "./Layout";
import Account from "./Account";
import UsersPage from "./UsersPage";
import XmppSetup from "./XmppSetup";

export default function App() {
  const initialize = useAuthStore((s) => s.initialize);
  const loadConfig = useConfigStore((s) => s.load);

  useEffect(() => {
    void initialize();
    void loadConfig();
  }, [initialize, loadConfig]);

  return (
    <Routes>
      <Route
        path="/login"
        element={
          <GuestOnly>
            <Login />
          </GuestOnly>
        }
      />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Account />} />
        <Route path="/xmpp" element={<XmppSetup />} />
        <Route
          path="/admin/users"
          element={
            <RequireAdmin>
              <UsersPage />
            </RequireAdmin>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
