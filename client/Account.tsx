import { Button, Card } from "@heroui/react";
import { Link } from "react-router-dom";
import { useCurrentUser } from "./guards";
import { StatusChip } from "./ui";

export default function Account() {
  const user = useCurrentUser();
  if (!user) return null;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-4 text-2xl font-semibold tracking-tight">My account</h1>
      <Card className="p-6">
        <dl className="space-y-3">
          <div className="flex items-center justify-between border-b border-neutral-100 pb-3">
            <dt className="text-sm text-neutral-500">Username</dt>
            <dd className="font-medium">{user.username}</dd>
          </div>
          <div className="flex items-center justify-between border-b border-neutral-100 pb-3">
            <dt className="text-sm text-neutral-500">Role</dt>
            <dd>
              <StatusChip label={user.role} tone={user.role === "admin" ? "accent" : "neutral"} />
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-sm text-neutral-500">Created</dt>
            <dd className="text-sm">{user.created_at}</dd>
          </div>
        </dl>
        {user.role === "admin" && (
          <div className="mt-6">
            <Link to="/admin/users">
              <Button variant="secondary">Manage users</Button>
            </Link>
          </div>
        )}
      </Card>
    </div>
  );
}
