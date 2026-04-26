import chalk from "chalk";
import type { AppConfig, LocationRecord, OpenerConfig } from "./domain";

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}
	return `${value.slice(0, maxLength - 1)}…`;
}

export function renderBanner(): string {
	return [
		chalk.cyanBright("╭──────────────────────────────────────────────╮"),
		chalk.cyanBright("│") +
			chalk.whiteBright(" open ") +
			chalk.dim("cross-platform folder launcher") +
			chalk.cyanBright(" │"),
		chalk.cyanBright("╰──────────────────────────────────────────────╯"),
	].join("\n");
}

export function info(message: string): void {
	console.log(chalk.cyan("info"), message);
}

export function success(message: string): void {
	console.log(chalk.green("done"), message);
}

export function warn(message: string): void {
	console.log(chalk.yellow("warn"), message);
}

export function printError(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	console.error(chalk.red("error"), message);
}

export function formatTable(headers: string[], rows: string[][]): string {
	const widths = headers.map((header, columnIndex) => {
		const rowWidths = rows.map((row) => row[columnIndex]?.length ?? 0);
		return Math.max(header.length, ...rowWidths);
	});

	const border = `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
	const rowLine = (row: string[]) =>
		`| ${row
			.map((cell, columnIndex) => cell.padEnd(widths[columnIndex]))
			.join(" | ")} |`;

	return [
		border,
		rowLine(headers),
		border,
		...rows.map(rowLine),
		border,
	].join("\n");
}

export function printLocations(locations: LocationRecord[]): void {
	if (locations.length === 0) {
		warn("No saved folders yet.");
		return;
	}

	const rows = locations.map((location) => [
		String(location.id),
		location.ref,
		truncate(location.path, 72),
		location.note || "-",
	]);

	console.log(formatTable(["ID", "Reference", "Path", "Note"], rows));
}

export function renderHelp(): string {
	return [
		renderBanner(),
		"",
		chalk.whiteBright("Usage"),
		"  o <ref>                 Open a saved folder with the default opener",
		"  o open [ref]            Open a folder by reference or pick one interactively",
		"  o add <ref> <path>      Save an absolute folder path",
		"  o rm <id|ref>           Remove a saved folder",
		"  o rename <id|ref> <ref> Rename a saved reference",
		"  o ls                    List saved folders",
		"  o config                Manage openers, paths, and update settings",
		"  o doctor                Validate config, storage, openers, and saved paths",
		"  o update                Clone the latest repo snapshot and rebuild this CLI",
		"  o setup                 Run first-time setup",
		"  o help                  Show this help message",
		"",
		chalk.whiteBright("Interactive shortcuts"),
		"  o                       Open the folder picker",
		"  pnpm manage             Open the full management dashboard",
		"",
		chalk.whiteBright("Notes"),
		"  - Setup stores CONFIG_PATH in .env as an absolute path.",
		"  - Dangerous actions always ask for confirmation.",
		"  - Openers can use {path} and {ref} placeholders.",
	].join("\n");
}

export function renderConfigSummary(config: AppConfig): string {
	return [
		chalk.whiteBright("Config"),
		`  storage dir   ${config.storageDir}`,
		`  config file   ${config.configPath}`,
		`  locations     ${config.storagePath}`,
		`  indent        ${config.storageIndent}`,
		`  default       ${config.openers.find((opener) => opener.id === config.defaultOpenerId)?.label ?? "unknown"}`,
		`  update        ${config.update.repositoryUrl || "not configured"}`,
	].join("\n");
}

export function renderOpenerList(
	openers: OpenerConfig[],
	defaultOpenerId: number,
): string {
	if (openers.length === 0) {
		return "No openers configured.";
	}

	return openers
		.map((opener) => {
			const marker =
				opener.id === defaultOpenerId
					? chalk.green("default")
					: chalk.dim("optional");
			return `  ${opener.label} (${opener.key})  ${marker}\n    ${chalk.dim(opener.command)}`;
		})
		.join("\n");
}
