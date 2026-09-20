import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuthStore } from "./authStore";
import type { ReactNode } from "react";

export function useCurrentUser() {
  return useAuthStore((s) => s.user);
}

export function useInitializing() {
  return useAuthStore((s) => s.initializing);
}

export function RequireAuth({ children }: { children?: ReactNode }) {
  const user = useCurrentUser();
  const initializing = useInitializing();
  if (initializing) {
    return <p>Loading…</p>;
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  return children ? <>{children}</> : <Outlet />;
}

export function RequireAdmin({ children }: { children?: ReactNode }) {
  const user = useCurrentUser();
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== "admin") return <Navigate to="/" replace />;
  return children ? <>{children}</> : <Outlet />;
}

export function GuestOnly({ children }: { children: ReactNode }) {
  const user = useCurrentUser();
  const initializing = useInitializing();
  const location = useLocation();
  if (initializing) return <p>Loading…</p>;
  // When a `next` target is present, let an already-authenticated visitor see
  // the login form: a private per-user site they don't own redirects here, and
  // they must be able to sign in as the owner. Without `next`, keep the usual
  // "signed-in users don't see /login" behavior.
  if (user && !new URLSearchParams(location.search).get("next")) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}
