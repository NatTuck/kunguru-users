export type Role = "admin" | "user";

export interface User {
  id: number;
  username: string;
  role: Role;
  created_at: string;
}

export type HostRole = "user-server" | "gateway" | "admin";

export interface Host {
  id: number;
  name: string;
  role: HostRole;
}

export type AccountStatus = "pending" | "active" | "failed";

export interface AccountInfo {
  hostId: number;
  hostName: string;
  hostRole: HostRole;
  status: AccountStatus;
}

export interface AdminUser extends User {
  enabled: number;
  account: AccountInfo | null;
}

export interface ProvisionInfo {
  ok: boolean;
  jobId: number | null;
  status?: string;
  failedStep?: string;
  message?: string;
}

export interface PasswordReveal {
  user: User;
  password: string;
  kind: "create" | "reset" | "provision" | "enable";
  provisioning?: ProvisionInfo | null;
}

export interface JobInfo {
  id: number;
  host_id: number | null;
  profile: string;
  created_by: number | null;
  status: "running" | "succeeded" | "failed";
  started_at: number;
  finished_at: number | null;
  host_name: string | null;
}

export interface JobStepInfo {
  id: number;
  job_id: number;
  seq: number;
  script: string;
  target_host_id: number | null;
  target_ssh: string;
  status: "running" | "succeeded" | "failed";
  exit_code: number | null;
  output_log: string;
  started_at: number;
  finished_at: number | null;
}

export interface JobDetail {
  job: JobInfo;
  steps: JobStepInfo[];
}
