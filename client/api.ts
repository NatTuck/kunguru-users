export class ApiError extends Error {
  readonly status: number;
  readonly retryAfterSec?: number;

  constructor(status: number, message: string, retryAfterSec?: number) {
    super(message);
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

type Body = Record<string, unknown>;

async function request<T>(
  method: string,
  path: string,
  body?: Body,
): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      data && typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
    const retryAfterSec =
      data && typeof data.retryAfterSec === "number" ? data.retryAfterSec : undefined;
    throw new ApiError(res.status, msg, retryAfterSec);
  }
  return data as T;
}

export const get = <T>(path: string): Promise<T> => request<T>("GET", path);
export const post = <T>(path: string, body?: Body): Promise<T> =>
  request<T>("POST", path, body);
export const patch = <T>(path: string, body?: Body): Promise<T> =>
  request<T>("PATCH", path, body);
export const del = <T>(path: string): Promise<T> => request<T>("DELETE", path);
