// To get full autocomplete in any Bitburner script, add this JSDoc comment
// above your main function. It tells VS Code to use the NS type definitions.



/**
 * @param {import("NetscriptDefinitions").NS} ns
 */
export async function main(ns) {
  // Try typing "ns." below — you should see autocomplete suggestions like:
  //   ns.hack(), ns.grow(), ns.weaken(), ns.scan(), ns.tprint(), etc.
  ns.tprint("Hello from Bitburner!");
}
