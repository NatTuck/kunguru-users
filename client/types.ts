export type Role = "admin" | "user";

export interface User {
  id: number;
  username: string;
  role: Role;
  created_at: string;
}

export interface PasswordReveal {
  user: User;
  password: string;
  kind: "create" | "reset";
}
