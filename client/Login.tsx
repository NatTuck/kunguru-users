import { useState } from "react";
import type { FormEvent } from "react";
import { Alert, Button, Card, Input, Spinner } from "@heroui/react";
import { useAuthStore } from "./authStore";

export default function Login() {
  const login = useAuthStore((s) => s.login);
  const loggingIn = useAuthStore((s) => s.loggingIn);
  const loginError = useAuthStore((s) => s.loginError);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await login(username, password);
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-neutral-100 p-4">
      <Card className="w-full max-w-sm p-6 sm:p-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight">Kunguru Users</h1>
          <p className="mt-1 text-sm text-neutral-500">Sign in to manage the cluster</p>
        </div>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="login-username" className="text-sm font-medium">
              Username
            </label>
            <Input
              id="login-username"
              name="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              placeholder="kunguru"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="login-password" className="text-sm font-medium">
              Password
            </label>
            <Input
              id="login-password"
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              placeholder="••••••••"
            />
          </div>
          {loginError && (
            <Alert status="danger">
              <Alert.Content>
                <Alert.Description>{loginError}</Alert.Description>
              </Alert.Content>
            </Alert>
          )}
          <Button type="submit" variant="primary" isDisabled={loggingIn}>
            {loggingIn ? (
              <span className="inline-flex items-center gap-2">
                <Spinner size="sm" /> Signing in…
              </span>
            ) : (
              "Sign in"
            )}
          </Button>
        </form>
      </Card>
    </div>
  );
}
