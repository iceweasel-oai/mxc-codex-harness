import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCasePlan, listCasesForSuite, listSuiteNames } from "./cases.mjs";

function parseArgs(argv) {
  const options = {
    suite: "all",
    keepTemp: false,
    root: null,
    dumpSdk: false,
    list: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--suite") {
      options.suite = argv[index + 1];
      index += 1;
    } else if (arg === "--root") {
      options.root = argv[index + 1];
      index += 1;
    } else if (arg === "--keep-temp") {
      options.keepTemp = true;
    } else if (arg === "--dump-sdk") {
      options.dumpSdk = true;
    } else if (arg === "--list") {
      options.list = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node ./src/cli.mjs --suite all
  node ./src/cli.mjs --suite smoke
  node ./src/cli.mjs --dump-sdk
  node ./src/cli.mjs --list

Options:
  --suite <name>   One of: all, ${listSuiteNames().join(", ")}
  --root <path>    Working root for temp files
  --keep-temp      Keep per-case directories after the run
  --dump-sdk       Print discovered @microsoft/mxc-sdk exports
  --list           List suites and cases
  --help           Show this message
`);
}

async function ensureRoot(rootOption) {
  const rootDir =
    rootOption || path.join(os.tmpdir(), `mxc-harness-${Date.now().toString(16)}`);
  await fs.mkdir(rootDir, { recursive: true });
  return rootDir;
}

function printList() {
  console.log("Suites:");
  for (const suiteName of ["all", ...listSuiteNames()]) {
    const cases = listCasesForSuite(suiteName);
    if (suiteName === "all") {
      console.log(`  ${suiteName} (${cases.length} cases)`);
      continue;
    }
    console.log(`  ${suiteName}`);
    for (const testCase of cases) {
      console.log(`    - ${testCase.name}`);
    }
  }
}

function printCase(result) {
  const status = result.ok ? "PASS" : "FAIL";
  if (result.detail) {
    console.log(`[${status}] ${result.name} :: ${result.detail}`);
    return;
  }
  console.log(`[${status}] ${result.name}`);
}

function printSummary(results, rootDir, keepTemp) {
  const passed = results.filter((result) => result.ok).length;
  const total = results.length;
  console.log("");
  console.log("=".repeat(72));
  console.log(`MXC harness: ${passed}/${total} passed`);
  if (keepTemp) {
    console.log(`Artifacts kept at ${rootDir}`);
  }
  console.log("=".repeat(72));
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }

  if (options.list) {
    printList();
    return 0;
  }

  if (!["all", ...listSuiteNames()].includes(options.suite)) {
    throw new Error(`Unknown suite: ${options.suite}`);
  }

  if (options.dumpSdk) {
    const { dumpSdkSurface } = await import("./mxc-adapter.mjs");
    const surface = await dumpSdkSurface();
    console.log(JSON.stringify(surface, null, 2));
    return 0;
  }

  const rootDir = await ensureRoot(options.root);
  const { runMxcCommand } = await import("./mxc-adapter.mjs");
  const plan = await createCasePlan(rootDir, options.suite);
  const results = [];

  for (const item of plan) {
    const { testCase, ctx } = item;
    try {
      const prepared = await testCase.run(ctx);
      const executionResult = await runMxcCommand(prepared.spec);
      const assertion = await prepared.assert(executionResult);
      const result = {
        name: testCase.name,
        ok: assertion.ok,
        detail: assertion.detail,
      };
      results.push(result);
      printCase(result);
    } catch (error) {
      const result = {
        name: testCase.name,
        ok: false,
        detail: String(error?.message || error),
      };
      results.push(result);
      printCase(result);
    }
  }

  printSummary(results, rootDir, options.keepTemp);

  if (!options.keepTemp) {
    await fs.rm(rootDir, { recursive: true, force: true });
  }

  return results.every((result) => result.ok) ? 0 : 1;
}

run()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
