#!/usr/bin/env bun
/**
 * NIM-12 umbrella proof gate.
 *
 * Runs every NIM-13..NIM-21 proof suite in sequence and reports overall
 * pass/fail. Exits 0 only if every suite passes. Output is plain text so
 * NIM-11 (final verification) can consume the per-suite verdicts.
 *
 * Usage:
 *   bun scripts/run-proofs.ts            # run every proof suite
 *   bun scripts/run-proofs.ts 13 17 21   # run only the listed suites
 *   bun scripts/run-proofs.ts --bail     # stop on first failure
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

type Suite = {
  id: string;
  slice: string;
  file: string;
  description: string;
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");

const SUITES: Suite[] = [
  {
    id: "NIM-13",
    slice: "NIM-2",
    file: "tests/nim-13.remote-surface-proof.test.ts",
    description: "remote-surface deletion",
  },
  {
    id: "NIM-14",
    slice: "NIM-3",
    file: "tests/nim-14.state-machine-proof.test.ts",
    description: "daemon state machine",
  },
  {
    id: "NIM-15",
    slice: "NIM-4",
    file: "tests/nim-15.multiplexed-router-proof.test.ts",
    description: "multiplexed daemon router",
  },
  {
    id: "NIM-16",
    slice: "NIM-5",
    file: "tests/nim-16.daemon-lifecycle-proof.test.ts",
    description: "daemon lifecycle",
  },
  {
    id: "NIM-17",
    slice: "NIM-6",
    file: "tests/nim-17.submit-wait-proof.test.ts",
    description: "submit + wait flow",
  },
  {
    id: "NIM-18",
    slice: "NIM-7",
    file: "tests/nim-18.cli-contract-proof.test.ts",
    description: "CLI contract",
  },
  {
    id: "NIM-19",
    slice: "NIM-8",
    file: "tests/nim-19.notification-proof.test.ts",
    description: "notification surface",
  },
  {
    id: "NIM-20",
    slice: "NIM-9",
    file: "tests/nim-20.agent-wrapper-proof.test.ts",
    description: "agent wrapper hooks",
  },
  {
    id: "NIM-21",
    slice: "NIM-10",
    file: "tests/nim-21.build-packaging-proof.test.ts",
    description: "build + packaging",
  },
];

type Verdict = "passed" | "failed";

type SuiteResult = {
  suite: Suite;
  verdict: Verdict;
  exitCode: number;
  durationMs: number;
};

function parseArgs(argv: string[]): { bail: boolean; selectIds: Set<string> } {
  const bail = argv.includes("--bail");
  const numbers = argv.filter((arg) => /^\d+$/.test(arg));
  const selectIds = new Set<string>();
  for (const number of numbers) {
    selectIds.add(`NIM-${number}`);
  }
  return { bail, selectIds };
}

function pickSuites(selectIds: Set<string>): Suite[] {
  if (selectIds.size === 0) {
    return SUITES;
  }
  const matched = SUITES.filter((suite) => selectIds.has(suite.id));
  const unknown = [...selectIds].filter(
    (id) => !SUITES.some((suite) => suite.id === id),
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown proof IDs: ${unknown.join(", ")}`);
  }
  return matched;
}

function ensureSuiteFilesExist(suites: Suite[]): void {
  const missing = suites.filter(
    (suite) => !existsSync(join(REPO_ROOT, suite.file)),
  );
  if (missing.length > 0) {
    const list = missing.map((suite) => `  - ${suite.id}: ${suite.file}`).join("\n");
    throw new Error(`Missing proof files:\n${list}`);
  }
}

async function runSuite(suite: Suite): Promise<SuiteResult> {
  const start = Date.now();
  const child = spawn(
    "bun",
    ["test", suite.file],
    {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: "inherit",
    },
  );

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  return {
    suite,
    verdict: exitCode === 0 ? "passed" : "failed",
    exitCode,
    durationMs: Date.now() - start,
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function printHeader(suite: Suite, index: number, total: number): void {
  const banner = "=".repeat(72);
  console.log(`\n${banner}`);
  console.log(
    `[${index + 1}/${total}] ${suite.id} (${suite.slice} ${suite.description})`,
  );
  console.log(`        ${suite.file}`);
  console.log(banner);
}

function printSummary(results: SuiteResult[]): void {
  const banner = "=".repeat(72);
  console.log(`\n${banner}`);
  console.log("NIM-12 umbrella proof gate — summary");
  console.log(banner);

  for (const result of results) {
    const status = result.verdict === "passed" ? "PASS" : "FAIL";
    const duration = formatDuration(result.durationMs);
    console.log(
      `  ${status}  ${result.suite.id}  ${duration.padStart(7)}  ${result.suite.file}`,
    );
  }

  const passed = results.filter((r) => r.verdict === "passed").length;
  const failed = results.length - passed;
  console.log(banner);
  console.log(
    `Total: ${results.length}   Passed: ${passed}   Failed: ${failed}`,
  );
  console.log(banner);
}

async function main(): Promise<number> {
  const { bail, selectIds } = parseArgs(process.argv.slice(2));
  const suites = pickSuites(selectIds);
  ensureSuiteFilesExist(suites);

  const results: SuiteResult[] = [];
  for (let i = 0; i < suites.length; i += 1) {
    const suite = suites[i];
    printHeader(suite, i, suites.length);
    const result = await runSuite(suite);
    results.push(result);
    if (result.verdict === "failed" && bail) {
      printSummary(results);
      return 1;
    }
  }

  printSummary(results);
  return results.every((r) => r.verdict === "passed") ? 0 : 1;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`run-proofs.ts: ${message}`);
    process.exit(1);
  });
