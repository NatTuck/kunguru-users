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
  agentChannel: string | null;
  agentVersion: string | null;
  venvKind: string | null;
}

/** Result of a command run on a host (membership convergence, app actions). */
export interface CommandResult {
  ok: boolean;
  output: string;
}

export interface GroupProvisionInfo extends CommandResult {
  jobId: number;
  status: string;
  failedStep?: string;
}

export interface GroupMember {
  user_id: number;
  username: string;
  role: "owner" | "member";
  added_at: string;
}

export type GroupRole = "owner" | "member" | "admin";

export interface GroupSummary {
  id: number;
  username: string;
  role: GroupRole;
  owner_username: string | null;
  enabled: number;
  created_at: string;
  member_count: number;
  provisioned: boolean;
  host: string | null;
  status: "pending" | "active" | "failed" | null;
  /** The group's Hermes agent has been provisioned (a Bifrost key exists). */
  agent: boolean;
}

export interface GroupDetail {
  group: GroupSummary;
  members: GroupMember[];
  canManage: boolean;
}

/** An account's two app slots (user units installed by provisioning). */
export type AppSlot = "app" | "app-dev";

export interface AppSlotStatus {
  slot: AppSlot;
  unit: string;
  load: string;
  enabled: string;
  active: string;
  sub: string;
  exitCode: number | null;
  result: string;
  installed: boolean;
}

export interface AppStatus {
  manager: boolean;
  slots: AppSlotStatus[];
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

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
}

export interface ModelInfo {
  current: string | null;
  default: string;
  models: ModelOption[];
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
  password?: string;
  kind: "create" | "reset" | "provision" | "enable" | "update";
  provisioning?: ProvisionInfo | null;
}

export interface FleetUpdateResult {
  username: string;
  jobId: number | null;
  status: string;
}

export interface FleetUpdateStatus {
  running: boolean;
  total: number;
  done: number;
  current: string | null;
  startedAt: number | null;
  results: FleetUpdateResult[];
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

/** A static site: `<label>.<base>` served from the owner's `~/www/<label>`. */
export interface StaticSite {
  id: number;
  owner_kind: "user" | "group";
  owner_id: number;
  owner_name: string;
  label: string;
  hostname: string;
  source_root: string;
  served_root: string;
  require_auth: number;
  any_authenticated: number;
  apex: number;
  created_at: string;
}
