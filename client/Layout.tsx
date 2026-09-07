import { Outlet, NavLink } from "react-router-dom";
import { Button, Chip } from "@heroui/react";
import { useCurrentUser } from "./guards";
import { useAuthStore } from "./authStore";

function linkClass({ isActive }: { isActive: boolean }): string {
  return [
    "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
    isActive ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-200",
  ].join(" ");
}

export default function Layout() {
  const user = useCurrentUser();
  const logout = useAuthStore((s) => s.logout);

  return (
    <div className="min-h-dvh bg-neutral-50">
      <header className="sticky top-0 z-20 border-b border-neutral-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <NavLink to="/" className="text-base font-semibold tracking-tight">
            Kunguru Users
          </NavLink>
          <nav className="flex items-center gap-1">
            <NavLink to="/" className={linkClass}>
              My account
            </NavLink>
            {user?.role === "admin" && (
              <NavLink to="/admin/users" className={linkClass}>
                Manage users
              </NavLink>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {user && (
              <Chip size="sm" className="px-2 py-1">
                {user.username} · {user.role}
              </Chip>
            )}
            <Button size="sm" variant="secondary" onPress={() => void logout()}>
              Log out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}
