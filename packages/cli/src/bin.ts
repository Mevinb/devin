#!/usr/bin/env node
import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  defaultAdbClient,
  listAvdProfiles,
  runDevicesDoctor
} from "@pixelsentinel/android";
import {
  globalDeviceRegistry,
  PilotThenReplayScheduler,
  resolveTarget,
  scan,
  DEFAULT_VIEWPORTS,
  type DeviceTarget
} from "@pixelsentinel/core";

import { FixProposalEngine, type PatchProposal } from "@pixelsentinel/fixer";
import chalk from "chalk";
import { Command } from "commander";
import dotenv from "dotenv";
import open from "open";
import ora from "ora";

dotenv.config();
const execAsync = promisify(exec);

const program = new Command();

program
  .name("pixelsentinel")
  .description("Automated visual QA & layout defect platform with real device runtimes, exploration, and fixes")
  .version("0.2.0");

// -------------------------------------------------------------
// COMMAND: scan
// -------------------------------------------------------------
program
  .command("scan")
  .description("Scan a URL or local frontend project across responsive viewports or real devices")
  .argument("<target>", "URL (https://...) or local project path")
  .option("-c, --config <path>", "Path to custom pixelsentinel config file")
  .option("-o, --out <dir>", "Directory to save output reports and screenshots", "./pixelsentinel-output")
  .option("-d, --devices <list>", "Comma-separated device IDs (e.g. 'android:pixel-8,webkit:iphone-15-pro')")
  .option("--explore", "Run autonomous LLM exploration across application states", false)
  .option("--max-steps <number>", "Max steps for exploration agent", "15")
  .option("--propose-fixes", "Generate self-verifying unified diffs for detected defects", false)
  .option("--no-vision", "Disable OpenAI vision analysis (heuristics only)")
  .option("--model <model>", "OpenAI model to use", "gpt-4o")
  .option("--concurrency <number>", "Number of parallel browser contexts", "4")
  .option("--start <command>", "Start command for local dev server (e.g. 'npm run dev')")
  .option("--port <port>", "Port for local dev server", "5173")
  .option("--open", "Open the HTML report in default browser after scan completes", false)
  .option("--fail-on <severity>", "Exit with code 1 if findings reach severity (critical, warning, info)", "critical")
  .action(async (target, opts) => {
    console.log(chalk.bold.hex("#6366f1")("\n🔍 PixelSentinel Visual Defect Scanner\n"));

    const spinner = ora({
      text: chalk.cyan(`Initializing scan on ${target}...`),
      color: "magenta"
    }).start();

    try {
      const concurrency = parseInt(opts.concurrency, 10) || 4;
      const port = opts.port ? parseInt(opts.port, 10) : undefined;

      // Handle exploration mode
      if (opts.explore) {
        spinner.text = chalk.cyan("Running autonomous multi-state exploration...");
        const scheduler = new PilotThenReplayScheduler();

        let deviceTargets: DeviceTarget[] = [];
        if (opts.devices) {
          const ids = opts.devices.split(",").map((s: string) => s.trim());
          deviceTargets = ids.map((id: string) => globalDeviceRegistry.resolveTarget(id));
        } else {
          deviceTargets = [
            globalDeviceRegistry.resolveTarget("chromium:desktop-1080p"),
            globalDeviceRegistry.resolveTarget("android:pixel-8"),
            globalDeviceRegistry.resolveTarget("webkit:iphone-15-pro")
          ];
        }

        const targetRes = await resolveTarget({
          target,
          browser: "chromium",
          fullPage: true,
          waitUntil: "networkidle",
          extraWaitMs: 500,
          concurrency: 4,
          vision: { enabled: false, model: "gpt-4o", maxImageDim: 1568 },
          output: { dir: opts.out, clean: false, html: true, json: true, annotatedImages: true }
        });

        try {
          const exploreResult = await scheduler.run(
            targetRes.url,
            deviceTargets,
            { maxSteps: parseInt(opts.maxSteps, 10) || 15 },
            opts.out
          );

          spinner.succeed(chalk.green(`Exploration completed! Discovered ${exploreResult.states.length} states across ${deviceTargets.length} devices.\n`));

          console.log(chalk.bold("🗺️ Device × State Matrix:"));
          console.log(chalk.gray("─".repeat(80)));
          for (const entry of exploreResult.matrix) {
            const fidBadge =
              entry.fidelity === "real"
                ? chalk.bgGreen.bold(" REAL ")
                : entry.fidelity === "webview"
                ? chalk.bgBlue.bold(" WEBVIEW ")
                : chalk.bgYellow.black(" APPROX ");

            console.log(
              ` ${fidBadge} ${chalk.cyan(entry.deviceName.padEnd(25))} ` +
              `${chalk.bold(entry.stateName.padEnd(25))} ` +
              (entry.findings.length === 0
                ? chalk.green("✓ 0 defects")
                : chalk.red(`✗ ${entry.findings.length} findings`))
            );
          }
          console.log(chalk.gray("─".repeat(80)));

          if (opts.proposeFixes && exploreResult.allFindings.length > 0) {
            const fixEngine = new FixProposalEngine({ repoRoot: process.cwd(), verifyInWorktree: true });
            const proposals = await fixEngine.proposeFixes(exploreResult.allFindings, opts.out);
            console.log(chalk.green(`\n🛠️  Generated ${proposals.length} self-verifying fix proposals.`));
            console.log(chalk.gray(`Run 'pixelsentinel fixes list' to review.`));
          }
        } finally {
          await targetRes.cleanup();
        }

        return;
      }


      // Standard Viewport / Device scan
      const report = await scan(
        {
          target,
          concurrency,
          output: {
            dir: opts.out
          },
          vision: {
            enabled: opts.vision !== false,
            model: opts.model
          },
          devServer: opts.start
            ? {
                command: opts.start,
                port
              }
            : undefined
        },
        {
          configFile: opts.config,
          onProgress: (_step, completed, total, detail) => {
            if (detail) {
              spinner.text = chalk.cyan(`[${completed}/${total}] ${detail}`);
            }
          }
        }
      );

      spinner.succeed(chalk.green("Scan completed successfully!\n"));

      // Print Summary Table
      console.log(chalk.bold("📊 Viewport Matrix Results:"));
      console.log(chalk.gray("─".repeat(70)));

      for (const item of report.matrix) {
        const statusBadge =
          item.status === "pass"
            ? chalk.bgGreen.bold(" PASS ")
            : chalk.bgRed.bold(" FAIL ");

        const findingsInfo =
          item.status === "pass"
            ? chalk.green("0 defects")
            : chalk.yellow(`${item.findings.length} findings (${item.findingsCount.critical} critical)`);

        console.log(
          ` ${statusBadge} ${chalk.bold(item.name.padEnd(28))} ` +
          `${chalk.gray(`${item.viewport.width}x${item.viewport.height}`.padEnd(14))} ` +
          findingsInfo
        );
      }

      console.log(chalk.gray("─".repeat(70)));
      console.log(
        chalk.bold(`Total: ${report.summary.totalFindings} findings `) +
        `(${chalk.red(`${report.summary.criticalFindings} critical`)}, ` +
        `${chalk.yellow(`${report.summary.warningFindings} warnings`)}) ` +
        `across ${report.summary.totalViewports} viewports in ${(report.summary.durationMs / 1000).toFixed(1)}s\n`
      );

      const allFindings = report.matrix.flatMap((m) => m.findings);
      if (opts.proposeFixes && allFindings.length > 0) {
        const fixEngine = new FixProposalEngine({ repoRoot: process.cwd(), verifyInWorktree: true });
        const proposals = await fixEngine.proposeFixes(allFindings, opts.out);
        console.log(chalk.green(`\n🛠️  Generated ${proposals.length} self-verifying fix proposals.`));
      }


      const reportHtmlPath = path.resolve(process.cwd(), opts.out, "report.html");
      console.log(chalk.bold("📄 HTML Report: ") + chalk.underline.cyan(`file://${reportHtmlPath}\n`));

      if (opts.open) {
        await open(reportHtmlPath).catch(() => {});
      }
    } catch (err) {
      spinner.fail(chalk.red("Scan failed with error:"));
      console.error(err);
      process.exit(1);
    }
  });

// -------------------------------------------------------------
// COMMAND GROUP: devices
// -------------------------------------------------------------
const devicesCmd = program.command("devices").description("Manage real device runtimes, ADB emulators, and virtualization");

devicesCmd
  .command("doctor")
  .description("Diagnose host hardware acceleration, KVM, JDK, ADB, and Android SDK readiness")
  .action(async () => {
    console.log(chalk.bold.hex("#6366f1")("\n🩺 PixelSentinel Device Runtime Doctor\n"));
    const report = await runDevicesDoctor();

    for (const check of report.checks) {
      const icon =
        check.status === "ok"
          ? chalk.green("✓ [OK]     ")
          : check.status === "warning"
          ? chalk.yellow("▲ [WARN]   ")
          : chalk.red("✗ [ERROR]  ");

      console.log(`${icon} ${chalk.bold(check.name)}: ${check.message}`);
      if (check.recommendation) {
        console.log(`           ${chalk.gray("→ " + check.recommendation)}`);
      }
    }

    console.log(chalk.gray("\n" + "─".repeat(75)));
    if (report.canEmulate) {
      console.log(chalk.green.bold("✓ Host is fully capable of running headless hardware-accelerated device runtimes!\n"));
    } else {
      console.log(chalk.yellow.bold("▲ Some device runtimes may run in software approximation mode.\n"));
    }
  });

devicesCmd
  .command("list")
  .description("List available built-in device targets and connected physical/emulated devices")
  .action(async () => {
    console.log(chalk.bold("\n📱 Registered Device Targets:"));
    console.log(chalk.gray("─".repeat(75)));

    const builtins = globalDeviceRegistry.listBuiltins();
    for (const dev of builtins) {
      const fid =
        dev.fidelity === "real"
          ? chalk.green("real")
          : chalk.yellow(dev.fidelity);

      console.log(
        `• ${chalk.cyan(dev.id.padEnd(25))} ${chalk.bold(dev.name.padEnd(28))} ` +
        `[${dev.runtime}] ${chalk.gray(`${dev.viewport.width}x${dev.viewport.height}`)} (${fid})`
      );
    }

    console.log(chalk.bold("\n🔌 Connected ADB Devices:"));
    console.log(chalk.gray("─".repeat(75)));
    const adbDevices = await defaultAdbClient.listDevices();
    if (adbDevices.length === 0) {
      console.log(chalk.gray("No online Android devices/emulators connected."));
    } else {
      for (const dev of adbDevices) {
        console.log(`• ${chalk.green(dev.serial)} [${dev.state}] ${dev.model || ""} (${dev.product || ""})`);
      }
    }
    console.log();
  });

// -------------------------------------------------------------
// COMMAND GROUP: fixes
// -------------------------------------------------------------
const fixesCmd = program.command("fixes").description("Inspect and apply verified layout fix proposals");

fixesCmd
  .command("list")
  .description("List generated fix proposals from output directory")
  .option("-o, --out <dir>", "Output directory", "./pixelsentinel-output")
  .action(async (opts) => {
    const proposalsFile = path.resolve(opts.out, "fixes", "proposals.json");
    try {
      const data = await fs.readFile(proposalsFile, "utf8");
      const proposals: PatchProposal[] = JSON.parse(data);

      console.log(chalk.bold(`\n🛠️  Proposed Fixes (${proposals.length} available):\n`));
      for (const p of proposals) {
        const statusBadge =
          p.verificationStatus === "verified"
            ? chalk.bgGreen.bold(" VERIFIED ")
            : p.verificationStatus === "failed"
            ? chalk.bgRed.bold(" FAILED ")
            : chalk.bgYellow.black(" UNVERIFIED ");

        console.log(
          ` ${statusBadge} ${chalk.cyan(p.id)} [${p.defectType}] in ${chalk.bold(p.file)}:L${p.startLine}\n` +
          `           ${chalk.gray(p.explanation)}\n`
        );
      }
      console.log(chalk.gray(`Use 'pixelsentinel fixes show <id>' to inspect diff.`));
    } catch {
      console.log(chalk.yellow(`No fix proposals found at ${proposalsFile}. Run 'pixelsentinel scan --propose-fixes' first.`));
    }
  });

fixesCmd
  .command("show <id>")
  .description("Show the unified diff for a fix proposal")
  .option("-o, --out <dir>", "Output directory", "./pixelsentinel-output")
  .action(async (id, opts) => {
    const proposalsFile = path.resolve(opts.out, "fixes", "proposals.json");
    try {
      const data = await fs.readFile(proposalsFile, "utf8");
      const proposals: PatchProposal[] = JSON.parse(data);
      const match = proposals.find((p) => p.id === id);
      if (!match) {
        console.error(chalk.red(`Fix proposal '${id}' not found.`));
        return;
      }

      console.log(chalk.bold(`\nPatch ${match.id} (${match.defectType}) for ${match.file}:\n`));
      const lines = match.diff.split("\n");
      for (const line of lines) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          console.log(chalk.green(line));
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          console.log(chalk.red(line));
        } else if (line.startsWith("@@")) {
          console.log(chalk.cyan(line));
        } else {
          console.log(chalk.gray(line));
        }
      }
      console.log();
    } catch {
      console.error(chalk.red("Failed to read proposals."));
    }
  });

fixesCmd
  .command("apply <id>")
  .description("Apply a verified fix proposal to your repository")
  .option("-o, --out <dir>", "Output directory", "./pixelsentinel-output")
  .action(async (id, opts) => {
    const proposalsFile = path.resolve(opts.out, "fixes", "proposals.json");
    try {
      const data = await fs.readFile(proposalsFile, "utf8");
      const proposals: PatchProposal[] = JSON.parse(data);
      const match = proposals.find((p) => p.id === id);
      if (!match) {
        console.error(chalk.red(`Fix proposal '${id}' not found.`));
        return;
      }

      const tempPatchPath = path.resolve(".pixelsentinel-apply.diff");
      await fs.writeFile(tempPatchPath, match.diff, "utf8");

      try {
        await execAsync(`git apply --check "${tempPatchPath}"`);
        await execAsync(`git apply "${tempPatchPath}"`);
        await fs.unlink(tempPatchPath).catch(() => {});
        console.log(chalk.green(`✓ Successfully applied fix ${match.id} to ${match.file}!`));
      } catch (err: unknown) {
        await fs.unlink(tempPatchPath).catch(() => {});
        console.error(chalk.red(`Failed to apply patch: ${(err as Error).message}`));
      }
    } catch {
      console.error(chalk.red("Failed to load proposals."));
    }
  });

program
  .command("serve")
  .description("Start the PixelSentinel local dashboard and Fastify server")
  .option("-p, --port <port>", "Server port", "3000")
  .option("--open", "Open dashboard in browser", true)
  .action(async (opts) => {
    try {
      const { startServer } = await import("@pixelsentinel/server");
      const port = parseInt(opts.port, 10) || 3000;
      await startServer(port, opts.open);
    } catch {
      console.error(chalk.red("Failed to start server. Ensure @pixelsentinel/server is built."));
    }
  });

program.parse(process.argv);
