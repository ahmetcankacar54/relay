import path from "node:path";
import { checkMascotSources, renderMascot, writeMascot } from "./mascot-assets";

async function main() {
  const root = path.resolve(import.meta.dirname, "..");
  const source = path.join(root, "assets/mascot/source");
  const problems = await checkMascotSources(source);
  if (problems.length) {
    console.error(`Mascot sources in ${path.relative(root, source)} need fixing; nothing was written:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  await writeMascot(await renderMascot(source), root);
  console.log("Generated the mascot tray frames and the puppet rig.");
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
