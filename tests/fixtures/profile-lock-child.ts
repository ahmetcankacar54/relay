// Holds a profile lock in its own process for tests: prints "ready" and holds until killed.
import { acquireProfileLock } from "../../electron/core/profile-lock";

const [locks, account, kind] = process.argv.slice(2);
acquireProfileLock(locks, account, kind as "shared" | "exclusive");
process.stdout.write("ready\n");
setInterval(() => {}, 1000);
