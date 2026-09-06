import { useCurrentUser } from "./guards";

export default function Account() {
  const user = useCurrentUser();
  if (!user) return null;

  return (
    <div>
      <h1>My account</h1>
      <p>
        You are signed in as <strong>{user.username}</strong>.
      </p>
      <ul>
        <li>Username: {user.username}</li>
        <li>Role: {user.role}</li>
        <li>Created: {user.created_at}</li>
      </ul>
      {user.role === "admin" && (
        <p>
          <a href="/admin/users">Manage users</a>
        </p>
      )}
    </div>
  );
}
