#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import dotenv from "dotenv";
import open from "open";
import ora from "ora";
import { scan, DEFAULT_VIEWPORTS } from "@pixelsentinel/core";

dotenv.config();

const program = new Command();

program
  .name("pixelsentinel")
  .description("Automated responsive visual defect scanner powered by Playwright and AI Vision")
  .version("0.1.0");

program
  .command("scan")
  .description("Scan a URL or local frontend project across responsive viewports")
  .argument("<target>", "URL (https://...) or local project path")
  .option("-c, --config <path>", "Path to custom pixelsentinel config file")
  .option("-o, --out <dir>", "Directory to save output reports and screenshots", "./pixelsentinel-output")
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

      const reportHtmlPath = path.resolve(process.cwd(), opts.out, "report.html");
      console.log(chalk.bold("📄 HTML Report: ") + chalk.underline.cyan(`file://${reportHtmlPath}\n`));

      if (opts.open) {
        await open(reportHtmlPath).catch(() => {});
      }

      // Exit code check for CI/CD
      const failSeverity = opts.failOn || "critical";
      let shouldFail = false;

      if (failSeverity === "critical" && report.summary.criticalFindings > 0) {
        shouldFail = true;
      } else if (failSeverity === "warning" && (report.summary.criticalFindings > 0 || report.summary.warningFindings > 0)) {
        shouldFail = true;
      } else if (failSeverity === "info" && report.summary.totalFindings > 0) {
        shouldFail = true;
      }

      if (shouldFail) {
        console.error(chalk.red.bold(`❌ Failing scan due to ${failSeverity} defects found.`));
        process.exit(1);
      }
    } catch (err) {
      spinner.fail(chalk.red("Scan failed with error:"));
      console.error(err);
      process.exit(1);
    }
  });

program
  .command("init")
  .description("Initialize a pixelsentinel.config.json configuration file")
  .action(async () => {
    const configPath = path.resolve(process.cwd(), "pixelsentinel.config.json");
    const defaultConfig = {
      $schema: "https://pixelsentinel.dev/schema.json",
      target: "http://localhost:3000",
      viewports: DEFAULT_VIEWPORTS,
      concurrency: 4,
      vision: {
        enabled: true,
        model: "gpt-4o"
      },
      output: {
        dir: "./pixelsentinel-output",
        clean: true,
        html: true,
        json: true
      }
    };

    await fs.writeFile(configPath, JSON.stringify(defaultConfig, null, 2), "utf8");
    console.log(chalk.green(`✓ Created ${configPath}`));
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
