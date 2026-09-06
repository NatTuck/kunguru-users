import { openDb, setAdminPassword, generatePassword, ADMIN_USERNAME } from "./db";

const db = openDb();
const password = generatePassword();
await setAdminPassword(db, password);
db.close();

console.log("==================================================");
console.log(`  Admin password for "${ADMIN_USERNAME}" reset.`);
console.log(`  New one-time password: ${password}`);
console.log("  Store it somewhere safe now. It will not be shown again.");
console.log("==================================================");
