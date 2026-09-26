import { connect } from "node:net";

/**
 * Best-effort liveness probe: resolve true when a TCP connection to
 * `host:port` opens within `timeoutMs`, false on refusal/timeout/error.
 * The caller is the app host, which reaches every tenant upstream (loopback
 * when co-located, the WireGuard address otherwise), so this answers "is the
 * tenant's app listening on its slot port".
 */
export function tcpUp(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let done = false;

    const finish = (up: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(up);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}
