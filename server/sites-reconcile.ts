import { reconcileUserSites } from "./nginx";

// Reconcile the gateway's per-user reverse-proxy routes from current DB state.
// Run on the app host: `pnpm sites-reconcile`.
const result = await reconcileUserSites();
console.log(result.output);
process.exit(result.ok ? 0 : 1);
