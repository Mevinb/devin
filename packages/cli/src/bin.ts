#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  defaultAdbClient,
  AndroidBootstrap,
  buildWebViewShell,
  getAvdProfile,
  listAvdProfiles,
  runDevicesDoctor
} from "@pixelsentinel/android";
import {
  globalDeviceRegistry,
  attachBudgetToReport,
  RunBudget,
  explore,
  replayTrace,
  reportFails,
  resolveScanConfig,
  writeHtmlReport,
  writeJsonReport,
  scan,
  DEFAULT_VIEWPORTS,
  type DefectSeverity
} from "@pixelsentinel/core";

import { attachProposalsToReport, FixProposalEngine, type PatchProposal } from "@pixelsentinel/fixer";
import chalk from "chalk";
import { Command, Option } from "commander";
import dotenv from "dotenv";
import open from "open";
import ora from "ora";

dotenv.config();
const execAsync = promisify(execFile);

const program = new Command();

program
  .name("pixelsentinel")
  .description("Automated visual QA & layout defect platform with real device runtimes, exploration, and fixes")
  .version("0.2.0");

// -------------------------------------------------------------
// COMMAND: scan
// -------------------------------------------------------------
const scanCommand = program
  .command("scan")
  .description("Scan a URL or local frontend project across responsive viewports or real devices")
  .argument("<target>", "URL (https://...) or local project path")
  .option("-c, --config <path>", "Path to custom pixelsentinel config file")
  .option("-o, --out <dir>", "Directory to save output reports and screenshots")
  .option("-d, --devices <list>", "Comma-separated device IDs (e.g. 'android:pixel-8,webkit:iphone-15-pro')")
  .option("--explore", "Run autonomous LLM exploration across application states", false)
  .option("--max-steps <number>", "Max steps for exploration agent", "15")
  .option("--max-states <number>", "Max discovered application states", "20")
  .option("--max-minutes <number>", "Shared time limit for capture, exploration and fixes")
  .option("--max-actions <number>", "Shared action limit including replay/recovery/verification")
  .option("--max-tokens <number>", "Shared AI token cap (requires model ceilings in config)")
  .option("--max-cost <usd>", "Shared estimated dollar cap (requires model pricing in config)")
  .option("--mock-agent", "Use the deterministic offline exploration agent", false)
  .option("--per-device", "Explore independently on every device", false)
  .option("--allow-destructive", "Allow destructive labelled actions during exploration", false)
  .option("--allowed-origins <list>", "Additional comma-separated HTTP(S) origins allowed during exploration")
  .option("--viewports <list>", "Comma-separated configured viewport names")
  .option("--propose-fixes", "Generate self-verifying unified diffs for detected defects", false)
  .option("--no-vision", "Disable OpenAI vision analysis (heuristics only)")
  .option("--model <model>", "OpenAI model to use")
  .option("--concurrency <number>", "Number of parallel browser contexts")
  .option("--start <command>", "Start command for local dev server (e.g. 'npm run dev')")
  .option("--port <port>", "Port for local dev server (0 selects an ephemeral port)")
  .option("--open", "Open the HTML report in default browser after scan completes", false)
  .addOption(new Option("--fail-on <severity>", "Exit with code 1 at this finding severity").choices(["critical", "warning", "info", "none"]).default("critical"))
  .option("--fail-on-approximate", "Include approximate devices in the failure threshold", false);

interface ScanCliOptions {
  config?: string; out?: string; devices?: string; concurrency?: string; model?: string; start?: string; port?: string;
  viewports?: string; maxSteps?: string; maxStates?: string; maxMinutes?: string;
  maxActions?: string; maxTokens?: string; maxCost?: string;
  vision?: boolean; mockAgent?: boolean; perDevice?: boolean; proposeFixes?: boolean; explore?: boolean;
  open?: boolean; failOn: DefectSeverity | "none"; failOnApproximate?: boolean;
  allowDestructive?: boolean; allowedOrigins?: string;
}

function budgetOverrides(opts: ScanCliOptions) {
  const number = (value: string | undefined, name: string, integer = false, zero = true) => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || !zero && parsed === 0 || integer && !Number.isSafeInteger(parsed)) throw new Error(`Invalid ${name}`);
    return parsed;
  };
  return {
    ...(opts.maxMinutes !== undefined ? { maxMinutes: number(opts.maxMinutes, "max-minutes", false, false) } : {}),
    ...(opts.maxActions !== undefined ? { maxActions: number(opts.maxActions, "max-actions", true) } : {}),
    ...(opts.maxTokens !== undefined ? { maxTokens: number(opts.maxTokens, "max-tokens", true) } : {}),
    ...(opts.maxCost !== undefined ? { maxCostUsd: number(opts.maxCost, "max-cost") } : {})
  };
}

async function runScan(target: string, opts: ScanCliOptions) {
  console.log(chalk.bold.hex("#6366f1")("\n🔍 PixelSentinel Visual Defect Scanner\n"));

  const spinner = ora({
    text: chalk.cyan(`Initializing scan on ${target}...`),
    color: "magenta"
  }).start();
  let budget: RunBudget | undefined;
  try {
    if (opts.proposeFixes && /^https?:\/\//i.test(target)) throw new Error("Fix proposals require a local source project target");
    const positive = (value: string | undefined, name: string, allowZero = false) => {
      if (value === undefined) return undefined;
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1)) throw new Error(`${name} must be ${allowZero ? "nonnegative" : "positive"} integer`);
      return number;
    };
    const input = await resolveScanConfig({
      target,
      ...(opts.devices ? { devices: opts.devices.split(",").map((id: string) => id.trim()).filter(Boolean) } : {}),
      ...(opts.concurrency ? { concurrency: positive(opts.concurrency, "concurrency") } : {}),
      output: opts.out ? { dir: opts.out } : {},
      budget: budgetOverrides(opts),
      vision: {
        ...(opts.vision === false ? { enabled: false } : {}),
        ...(opts.model ? { model: opts.model } : {})
      },
      ...(opts.start || opts.port ? { devServer: { ...(opts.start ? { command: opts.start } : {}),
        ...(opts.port !== undefined ? { port: positive(opts.port, "port", true) } : {}) } } : {})
    }, opts.config);
    if (opts.explore && input.budget.maxMinutes === undefined) input.budget.maxMinutes = 5;
    budget = new RunBudget(input.budget);
    if (opts.viewports) {
      const names = opts.viewports.split(",").map((s: string) => s.trim());
      const available = input.viewports ?? DEFAULT_VIEWPORTS;
      input.viewports = available.filter((v) => names.includes(v.name));
      if (input.viewports.length !== new Set(names).size) throw new Error(`Unknown viewport name; choose from ${available.map((v) => v.name).join(", ")}`);
    }
    const report = opts.explore
      ? (await explore(input, {
          maxSteps: positive(opts.maxSteps, "max-steps"), maxStates: positive(opts.maxStates, "max-states"),
          maxMinutes: input.budget.maxMinutes, model: input.vision.model, useMockAgent: opts.mockAgent, perDevice: opts.perDevice,
          allowDestructive: opts.allowDestructive, allowedOrigins: opts.allowedOrigins?.split(",").map((origin) => origin.trim()).filter(Boolean)
        }, { budget, onProgress: (event) => { spinner.text = `${event.phase}: ${event.deviceId} step ${event.step} ${event.message ?? ""}`; } })).report
      : await scan(input, { budget, onProgress: (_step, completed, total, detail) => {
          if (detail) spinner.text = chalk.cyan(`[${completed}/${total}] ${detail}`);
        } });
    const outputDir = report.config.output.dir;

    if (report.errors?.length) spinner.warn(`Scan finished with ${report.errors.length} device or replay errors.\n`);
    else spinner.succeed(chalk.green("Scan completed successfully!\n"));
    for (const error of report.errors ?? []) console.error(chalk.red(`${error.targetId}: ${error.message}`));

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
        ` ${statusBadge} ${chalk.bold(`${item.name}${item.stateName ? " — " + item.stateName : ""}`.padEnd(28))} ` +
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
    if (opts.proposeFixes && allFindings.length > 0 && !budget.snapshot().stopped) {
      const localTarget = path.resolve(target);
      const { stdout } = await execAsync("git", ["rev-parse", "--show-toplevel"], {
        cwd: (await fs.stat(localTarget)).isDirectory() ? localTarget : path.dirname(localTarget)
      });
      const fixEngine = new FixProposalEngine({ repoRoot: stdout.trim(), scanConfig: report.config, model: report.config.vision.model, verifyInWorktree: true, budget });
      const proposals = await fixEngine.proposeFixes(allFindings, outputDir);
      attachProposalsToReport(report, proposals, outputDir);
      console.log(chalk.green(`\n🛠️  Generated ${proposals.length} proposals (${proposals.filter((p) => p.verificationStatus === "verified").length} verified by re-scan).`));
    }
    attachBudgetToReport(report, budget);
    if (report.config.output.json) await writeJsonReport(report, outputDir);
    if (report.config.output.html) await writeHtmlReport(report, outputDir);
    console.log(`AI usage: ${report.usage!.requests} requests, ${report.usage!.totalTokens} tokens, ${report.usage!.costUsd === null ? "cost unknown" : "$" + report.usage!.costUsd.toFixed(6) + " estimated"}`);
    if (report.usage!.stopped) console.error(chalk.red(report.usage!.stopped.message));
    const reportHtmlPath = path.resolve(outputDir, "report.html");
    console.log(chalk.bold("📄 HTML Report: ") + chalk.underline.cyan(`file://${reportHtmlPath}\n`));

    if (opts.open) await open(reportHtmlPath).catch(() => {});
    if (reportFails(report, opts.failOn, opts.failOnApproximate)) process.exitCode = 1;
  } catch (err) {
    spinner.fail(chalk.red("Scan failed with error:"));
    console.error(err);
    process.exitCode = 1;
  } finally { budget?.dispose(); }
}
scanCommand.action(runScan);

const exploreCommand = program.command("explore <target>").description("Discover application states and save replayable traces");
for (const option of scanCommand.options) exploreCommand.addOption(option);
exploreCommand.action((target, opts) => runScan(target, { ...opts, explore: true }));

program.command("replay <trace>")
  .description("Replay saved actions against a target and generate a report")
  .requiredOption("--target <target>", "URL or local project to replay against")
  .option("--config <path>", "Scan configuration including model ceilings and pricing")
  .option("--max-minutes <number>", "Shared replay time limit")
  .option("--max-actions <number>", "Shared action cap across all replay devices")
  .option("--max-states <number>", "Shared state cap across replay devices")
  .option("--max-tokens <number>", "Shared AI token cap")
  .option("--max-cost <usd>", "Shared estimated dollar cap")
  .option("-d, --devices <list>", "Comma-separated target device IDs")
  .option("-o, --out <dir>", "Report output directory", "./pixelsentinel-output/replay")
  .option("--no-vision", "Disable OpenAI vision analysis")
  .option("--mock-agent", "Use deterministic recovery agent", false)
  .option("--allow-destructive", "Allow destructive labelled actions in the saved trace", false)
  .option("--allowed-origins <list>", "Additional comma-separated HTTP(S) origins allowed during replay")
  .addOption(new Option("--fail-on <severity>", "Finding severity that fails CI; replay errors always fail").choices(["critical", "warning", "info", "none"]).default("critical"))
  .option("--fail-on-approximate", "Include approximate findings in the failure threshold", false)
  .option("--start <command>", "Dev server command ({port} uses the assigned port)")
  .option("--port <port>", "Dev server port", "0")
  .action(async (trace, opts) => {
    const report = await replayTrace(trace, { target: opts.target, devices: opts.devices?.split(",").map((id: string) => id.trim()),
      budget: budgetOverrides(opts),
      output: { dir: opts.out }, vision: { enabled: opts.vision !== false },
      ...(opts.start ? { devServer: { command: opts.start, port: Number(opts.port) } } : {})
    }, { useMockAgent: opts.mockAgent, allowDestructive: opts.allowDestructive, maxStates: opts.maxStates === undefined ? undefined : Number(opts.maxStates),
      allowedOrigins: opts.allowedOrigins?.split(",").map((origin: string) => origin.trim()).filter(Boolean) }, { configFile: opts.config });
    for (const error of report.errors ?? []) console.error(chalk.red(`${error.targetId}: ${error.message}`));
    if (reportFails(report, opts.failOn, opts.failOnApproximate)) process.exitCode = 1;
    console.log(`Replay report: ${path.resolve(opts.out, "report.html")}`);
  });

program.command("init")
  .description("Write a default viewport scanner configuration")
  .option("-o, --out <file>", "Configuration path", "pixelsentinel.config.json")
  .action(async (opts) => {
    await fs.writeFile(opts.out, JSON.stringify({ viewports: DEFAULT_VIEWPORTS, vision: { enabled: true }, output: { dir: "./pixelsentinel-output" } }, null, 2) + "\n", { flag: "wx" });
    console.log(`Created ${path.resolve(opts.out)}`);
  });

// -------------------------------------------------------------
// COMMAND GROUP: devices
// -------------------------------------------------------------
const devicesCmd = program.command("devices").description("Manage real device runtimes, ADB emulators, and virtualization");

devicesCmd
  .command("doctor")
  .description("Diagnose host hardware acceleration, KVM, JDK, ADB, and Android SDK readiness")
  .option("--sdk-root <path>", "SDK directory (defaults to ANDROID_HOME or ~/Android/Sdk)")
  .option("--avd-home <path>", "AVD directory")
  .option("--profiles <list>", "Comma-separated AVD profiles to check", "pixel_8")
  .option("--json", "Print machine-readable diagnostics", false)
  .action(async (opts) => {
    const report = await runDevicesDoctor({ sdkRoot: opts.sdkRoot, avdHome: opts.avdHome, profiles: opts.profiles.split(",").map((id: string) => id.trim()) });
    if (!report.canEmulate) process.exitCode = 1;
    if (opts.json) { console.log(JSON.stringify(report, null, 2)); return; }
    console.log(chalk.bold.hex("#6366f1")("\n🩺 PixelSentinel Device Runtime Doctor\n"));

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
      console.log(chalk.green.bold("✓ Ready to boot the checked emulator profiles with hardware acceleration.\n"));
    } else {
      console.log(chalk.yellow.bold("▲ New accelerated emulator boots are not ready; see the checks above.\n"));
    }
    if (report.canUseConnectedDevices) console.log(chalk.cyan(`Connected Android devices remain available: ${report.connectedDevices.filter((d) => d.state === "device").map((d) => d.serial).join(", ")}`));
  });

devicesCmd.command("install")
  .description("Install official Android command-line tools, emulator, platform-tools and selected system images")
  .option("--profiles <list>", "Comma-separated AVD profiles", "pixel_8")
  .option("--all", "Install images for all built-in form factors", false)
  .option("--sdk-root <path>", "Destination SDK directory")
  .option("--avd-home <path>", "AVD directory")
  .option("--user-home <path>", "Writable Android preferences/cache directory")
  .option("--tools-only", "Install command-line tools only", false)
  .option("--accept-licenses", "Allow license prompts to be accepted during installation", false)
  .action(async (opts) => {
    const bootstrap = new AndroidBootstrap({ sdkRoot: opts.sdkRoot, avdHome: opts.avdHome, userHome: opts.userHome, onLog: (line) => console.log(line) });
    const result = await bootstrap.install({ profiles: opts.all ? listAvdProfiles().map((p) => p.id) : opts.profiles.split(",").map((id: string) => id.trim()), toolsOnly: opts.toolsOnly, acceptLicenses: opts.acceptLicenses });
    console.log(result.message);
    if (!result.success) process.exitCode = 1;
  });

devicesCmd.command("build-shell")
  .description("Install Android build dependencies and build/lint the Kotlin WebView shell APK")
  .option("--sdk-root <path>", "Writable SDK directory")
  .option("--user-home <path>", "Writable Android preferences/signing directory")
  .option("--gradle-home <path>", "Writable Gradle dependency cache")
  .option("--accept-licenses", "Allow Android SDK license prompts to be accepted", false)
  .action(async (opts) => {
    const result = await buildWebViewShell({ sdkRoot: opts.sdkRoot, userHome: opts.userHome,
      gradleHome: opts.gradleHome, acceptLicenses: opts.acceptLicenses, onLog: (line) => console.log(line) });
    console.log(result.message);
    if (!result.success) process.exitCode = 1;
  });

devicesCmd.command("create <profile>")
  .description("Create a profile-specific AVD without replacing existing devices")
  .option("--name <name>", "Override the profile's standard AVD name")
  .option("--sdk-root <path>", "SDK directory")
  .option("--avd-home <path>", "AVD directory")
  .option("--user-home <path>", "Writable Android preferences/cache directory")
  .option("--force", "Explicitly replace the named AVD", false)
  .action(async (id, opts) => {
    const profile = getAvdProfile(id);
    if (!profile) throw new Error(`Unknown AVD profile '${id}'. Available: ${listAvdProfiles().map((p) => p.id).join(", ")}`);
    const result = await new AndroidBootstrap({ sdkRoot: opts.sdkRoot, avdHome: opts.avdHome, userHome: opts.userHome, onLog: (line) => console.log(line) }).createAvd(profile, opts.name, { force: opts.force });
    console.log(result.message);
    if (!result.success) process.exitCode = 1;
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
        await execAsync("git", ["apply", "--check", tempPatchPath]);
        await execAsync("git", ["apply", tempPatchPath]);
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

program.parseAsync(process.argv).catch((err) => { console.error(chalk.red((err as Error).message)); process.exitCode = 1; });
