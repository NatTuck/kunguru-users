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

export interface MessageResult {
  ok: boolean;
  output: string;
}

export interface CatalogModel {
  name: string;
  provider: string;
}

export interface ProviderRefreshResult {
  provider: string;
  ok: boolean;
  error?: string;
}

export interface WebuiRestartResult {
  username: string;
  ok: boolean;
  error?: string;
}

export interface ModelsRefreshResult {
  providers: ProviderRefreshResult[];
  models: CatalogModel[];
  webuis: WebuiRestartResult[];
  ok: boolean;
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

export type AliasKind = "proxy" | "static";
export type AliasAccess = "public" | "private";
export type AliasService = "private-app" | "public-site" | "hermes-webui";

export interface Alias {
  id: number;
  user_id: number;
  label: string;
  kind: AliasKind;
  service: AliasService | null;
  root: string | null;
  access: AliasAccess;
  created_at: string;
}
