// Toggle Bill's mode.  Print:  npm run mode    Set:  npm run mode -- auto|gated|off
import { getMode, setMode, autoExecAllowed, MODES, type Mode } from "./mode.js";
import { installSafetyNet } from "./http-utils.js";

installSafetyNet("bill-mode");

const arg = process.argv[2]?.trim().toLowerCase();

if (!arg) {
  console.log(`Bill mode: ${getMode()}`);
  if (getMode() === "auto" && !autoExecAllowed()) {
    console.log('(auto is set, but BILL_ALLOW_AUTO_EXEC=1 is NOT — runs as gated until you set it)');
  }
  process.exit(0);
}

if (!(MODES as string[]).includes(arg)) {
  console.error(`Invalid mode "${arg}". Use one of: ${MODES.join(", ")}`);
  process.exit(2);
}

setMode(arg as Mode);
console.log(`Bill mode set -> ${getMode()}`);
if (arg === "auto") {
  console.log("NOTE: auto also requires the env var BILL_ALLOW_AUTO_EXEC=1 before it will place any paper orders.");
}
