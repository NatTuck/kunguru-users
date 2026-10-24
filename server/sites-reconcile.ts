import { reconcileSites } from "./nginx";

// Reconcile site routing from current DB state: the gateway's account/static
// routes and each host's static-site nginx. Run on the app host:
// `pnpm sites-reconcile`.
const result = await reconcileSites();
console.log(result.output);
process.exit(result.ok ? 0 : 1);
