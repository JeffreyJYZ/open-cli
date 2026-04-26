import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkbox, confirm, input, select } from "@inquirer/prompts";
import {
	type AppConfig,
	DEFAULT_UPDATE_REPOSITORY,
	type LocationRecord,
	type OpenerConfig,
	type UpdateCheckState,
	absolutePathSchema,
	getPlatformLabel,
	getPlatformOpenerPresets,
	locationSchema,
	refSchema,
} from "./domain";
import {
	assertLocationPathExists,
	assertRefAvailable,
	createLocationRecord,
	createOpenerRecord,
	detectRepositoryInfo,
	getProjectRoot,
	getDefaultStorageDir,
	loadState,
	type LoadedState,
	initializeRuntime,
	moveStorageDirectory,
	normalizeUserPath,
	saveState,
	slugifyKey,
	writeConfigPathEnv,
} from "./state";
import {
	info,
	printLocations,
	renderBanner,
	renderConfigSummary,
	renderHelp,
	renderOpenerList,
	success,
	warn,
} from "./ui";

function quoteForShell(value: string): string {
	if (process.platform === "win32") {
		return `"${value.replaceAll('"', '""')}"`;
	}
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function formatOpenerChoice(opener: OpenerConfig): string {
	return `${opener.label} (${opener.key})`;
}

function applyCommandTemplate(
	template: string,
	location: LocationRecord,
): string {
	return template
		.replaceAll("{path}", quoteForShell(location.path))
		.replaceAll("{ref}", quoteForShell(location.ref));
}

const GITHUB_REPOSITORY_SHORTHAND_PATTERN =
	/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const UPDATE_CHECK_INTERVAL_MS = 1000 * 60 * 60 * 24;

function resolveRepositoryCloneSource(repositoryUrl: string): string {
	const trimmed = repositoryUrl.trim();
	if (
		trimmed === "" ||
		trimmed.startsWith("git@") ||
		trimmed.includes("://") ||
		trimmed.startsWith("/") ||
		trimmed.startsWith(".") ||
		trimmed.startsWith("~")
	) {
		return trimmed;
	}

	return GITHUB_REPOSITORY_SHORTHAND_PATTERN.test(trimmed)
		? `https://github.com/${trimmed}.git`
		: trimmed;
}

function parseGitHubRepository(repositoryUrl: string): {
	owner: string;
	repository: string;
} | null {
	const trimmed = repositoryUrl.trim().replace(/\.git$/u, "");
	if (GITHUB_REPOSITORY_SHORTHAND_PATTERN.test(trimmed)) {
		const [owner, repository] = trimmed.split("/");
		return { owner, repository };
	}

	if (trimmed.startsWith("git@github.com:")) {
		const slug = trimmed.slice("git@github.com:".length);
		const [owner, repository] = slug.split("/");
		return owner && repository ? { owner, repository } : null;
	}

	if (trimmed.startsWith("https://github.com/")) {
		const pathname = new URL(trimmed).pathname.replace(/^\//u, "");
		const [owner, repository] = pathname.split("/");
		return owner && repository ? { owner, repository } : null;
	}

	return null;
}

function compareVersions(
	currentVersion: string,
	nextVersion: string,
): number | null {
	const parse = (value: string) => {
		const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u);
		if (!match) {
			return null;
		}

		return match.slice(1).map((segment) => Number.parseInt(segment, 10));
	};

	const current = parse(currentVersion);
	const next = parse(nextVersion);
	if (!current || !next) {
		return null;
	}

	for (let index = 0; index < current.length; index += 1) {
		if (current[index] === next[index]) {
			continue;
		}
		return current[index] < next[index] ? -1 : 1;
	}

	return 0;
}

function readRemoteBranchRevision(
	repositoryUrl: string,
	branch: string,
): string {
	const cloneSource = resolveRepositoryCloneSource(repositoryUrl);
	if (!cloneSource) {
		return "";
	}

	const result = spawnSync(
		"git",
		["ls-remote", cloneSource, `refs/heads/${branch}`],
		{
			encoding: "utf8",
			timeout: 4000,
		},
	);
	if (result.status !== 0) {
		return "";
	}

	const [revision] = result.stdout.trim().split(/\s+/u);
	return revision ?? "";
}

async function readCurrentPackageVersion(rootDir: string): Promise<string> {
	const raw = await fs.readFile(path.join(rootDir, "package.json"), "utf8");
	const parsed = JSON.parse(raw) as { version?: unknown };
	return typeof parsed.version === "string" ? parsed.version : "";
}

async function printVersion(rootDir = getProjectRoot()): Promise<void> {
	const version = await readCurrentPackageVersion(rootDir);
	console.log(version || "unknown");
}

async function readRemotePackageVersion(
	repositoryUrl: string,
	branch: string,
): Promise<string> {
	const githubRepository = parseGitHubRepository(repositoryUrl);
	if (!githubRepository) {
		return "";
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 4000);
	try {
		const response = await fetch(
			`https://raw.githubusercontent.com/${githubRepository.owner}/${githubRepository.repository}/${encodeURIComponent(branch)}/package.json`,
			{ signal: controller.signal },
		);
		if (!response.ok) {
			return "";
		}

		const parsed = (await response.json()) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version : "";
	} catch {
		return "";
	} finally {
		clearTimeout(timeout);
	}
}

function shouldRefreshUpdateCheck(lastCheckedAt: string): boolean {
	if (!lastCheckedAt) {
		return true;
	}

	const lastCheckedAtMs = Date.parse(lastCheckedAt);
	if (Number.isNaN(lastCheckedAtMs)) {
		return true;
	}

	return Date.now() - lastCheckedAtMs >= UPDATE_CHECK_INTERVAL_MS;
}

function formatUpdateNotification(
	currentVersion: string,
	check: UpdateCheckState,
): string | null {
	const versionComparison =
		currentVersion && check.latestVersion
			? compareVersions(currentVersion, check.latestVersion)
			: null;
	if (versionComparison === -1) {
		return `open-cli ${check.latestVersion} is available (installed ${currentVersion}). Run \`o update\`.`;
	}

	if (
		check.installedRevision &&
		check.latestRevision &&
		check.installedRevision !== check.latestRevision
	) {
		return "A newer open-cli build is available. Run `o update`.";
	}

	return null;
}

async function maybeNotifyIfUpdateAvailable(
	state: LoadedState,
): Promise<LoadedState> {
	const currentVersion = await readCurrentPackageVersion(state.rootDir);
	const installedRevision =
		state.config.update.check.installedRevision ||
		detectRepositoryInfo(state.rootDir).revision;
	let nextState = state;

	if (shouldRefreshUpdateCheck(state.config.update.check.lastCheckedAt)) {
		const latestRevision = readRemoteBranchRevision(
			state.config.update.repositoryUrl,
			state.config.update.branch,
		);
		const latestVersion = await readRemotePackageVersion(
			state.config.update.repositoryUrl,
			state.config.update.branch,
		);
		const nextCheck = {
			...state.config.update.check,
			installedRevision,
			lastCheckedAt: new Date().toISOString(),
			latestVersion,
			latestRevision,
		};

		if (
			nextCheck.lastCheckedAt !==
				state.config.update.check.lastCheckedAt ||
			nextCheck.latestVersion !==
				state.config.update.check.latestVersion ||
			nextCheck.latestRevision !==
				state.config.update.check.latestRevision
		) {
			nextState = await saveState({
				...state,
				config: {
					...state.config,
					update: {
						...state.config.update,
						check: nextCheck,
					},
				},
			});
		}
	} else if (
		installedRevision !== state.config.update.check.installedRevision
	) {
		nextState = await saveState({
			...state,
			config: {
				...state.config,
				update: {
					...state.config.update,
					check: {
						...state.config.update.check,
						installedRevision,
					},
				},
			},
		});
	}

	const notification = formatUpdateNotification(
		currentVersion,
		nextState.config.update.check,
	);
	if (notification) {
		warn(notification);
	}

	return nextState;
}

function printConfigState(state: LoadedState): void {
	console.log(renderBanner());
	console.log(renderConfigSummary(state.config));
	console.log(
		renderOpenerList(state.config.openers, state.config.defaultOpenerId),
	);
}

function parseStorageIndent(value: string): number {
	const storageIndent = Number.parseInt(value, 10);
	if (
		!Number.isInteger(storageIndent) ||
		storageIndent < 2 ||
		storageIndent > 8
	) {
		throw new Error("Indent must be a whole number between 2 and 8");
	}
	return storageIndent;
}

function validateStorageIndent(value: string): true | string {
	try {
		parseStorageIndent(value);
		return true;
	} catch (error) {
		return error instanceof Error ? error.message : "Invalid indent";
	}
}

function resetUpdateCheck(check: UpdateCheckState): UpdateCheckState {
	return {
		...check,
		lastCheckedAt: "",
		latestVersion: "",
		latestRevision: "",
	};
}

async function runProcess(
	command: string,
	args: string[],
	options: { cwd?: string } = {},
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			stdio: "inherit",
			shell: process.platform === "win32",
		});

		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(
				new Error(
					`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`,
				),
			);
		});
	});
}

async function runShellCommand(command: string, cwd?: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, {
			cwd,
			stdio: "inherit",
			shell: true,
		});

		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(
				new Error(
					`Command failed with exit code ${code ?? "unknown"}: ${command}`,
				),
			);
		});
	});
}

function findLocation(
	target: string,
	locations: LocationRecord[],
): LocationRecord | undefined {
	if (/^\d+$/u.test(target)) {
		const locationId = Number.parseInt(target, 10);
		return locations.find((location) => location.id === locationId);
	}

	const lowered = target.toLowerCase();
	return locations.find((location) => location.ref.toLowerCase() === lowered);
}

function findOpener(
	target: string,
	config: AppConfig,
): OpenerConfig | undefined {
	if (/^\d+$/u.test(target)) {
		const openerId = Number.parseInt(target, 10);
		return config.openers.find((opener) => opener.id === openerId);
	}

	const lowered = target.toLowerCase();
	return config.openers.find(
		(opener) => opener.key.toLowerCase() === lowered,
	);
}

function getDefaultOpener(config: AppConfig): OpenerConfig {
	const opener = config.openers.find(
		(item) => item.id === config.defaultOpenerId,
	);
	if (!opener) {
		throw new Error("Default opener is not configured.");
	}
	return opener;
}

function parseWithOption(args: string[]): {
	args: string[];
	openerTarget: string | null;
} {
	const plainArgs: string[] = [];
	let openerTarget: string | null = null;

	for (let index = 0; index < args.length; index += 1) {
		const current = args[index];
		if (current === "--with") {
			openerTarget = args[index + 1] ?? null;
			index += 1;
			continue;
		}
		plainArgs.push(current);
	}

	return { args: plainArgs, openerTarget };
}

async function requireState(notifyAboutUpdates = true): Promise<LoadedState> {
	const state = await loadState({ allowFallbackToCwd: true });
	if (state) {
		return notifyAboutUpdates ? maybeNotifyIfUpdateAvailable(state) : state;
	}
	throw new Error("No storage file found yet. Run `o setup` first.");
}

async function promptForLocation(
	locations: LocationRecord[],
	defaults?: Partial<Omit<LocationRecord, "id">>,
): Promise<Omit<LocationRecord, "id">> {
	const ref = await input({
		message: "Reference",
		default: defaults?.ref,
		validate: (value) => {
			const parsed = refSchema.safeParse(value);
			if (!parsed.success) {
				return parsed.error.issues[0]?.message ?? "Invalid reference";
			}
			const duplicate = locations.some(
				(location) =>
					location.ref.toLowerCase() === parsed.data.toLowerCase() &&
					location.ref.toLowerCase() !== defaults?.ref?.toLowerCase(),
			);
			return duplicate
				? `Reference already exists: ${parsed.data}`
				: true;
		},
	});

	const folderPath = await input({
		message: "Absolute folder path",
		default: defaults?.path,
		validate: (value) => {
			const normalized = normalizeUserPath(value);
			const parsed = absolutePathSchema.safeParse(normalized);
			if (!parsed.success) {
				return parsed.error.issues[0]?.message ?? "Invalid path";
			}
			if (!existsSync(normalized)) {
				return `Path does not exist: ${normalized}`;
			}
			return true;
		},
	});

	const note = await input({
		message: "Optional note",
		default: defaults?.note ?? "",
	});

	return {
		ref: refSchema.parse(ref),
		path: normalizeUserPath(folderPath),
		note,
	};
}

async function promptForCustomOpener(
	openers: OpenerConfig[],
): Promise<OpenerConfig> {
	const label = await input({
		message: "Custom opener label",
		validate: (value) =>
			value.trim().length >= 2 || "Label must be at least 2 characters",
	});
	const suggestedKey = slugifyKey(label);
	const key = await input({
		message: "Custom opener key",
		default: suggestedKey,
		validate: (value) => {
			const normalized = slugifyKey(value);
			if (!/^[a-z][a-z0-9-]*$/u.test(normalized)) {
				return "Key must be kebab-case";
			}
			return openers.some((item) => item.key.toLowerCase() === normalized)
				? `Opener key already exists: ${normalized}`
				: true;
		},
	});
	const command = await input({
		message: "Command template",
		validate: (value) =>
			value.includes("{path}") || "Command template must include {path}",
	});
	const description = await input({
		message: "Optional description",
		default: "",
	});

	return createOpenerRecord(
		{
			key: slugifyKey(key),
			label: label.trim(),
			command: command.trim(),
			description: description.trim(),
		},
		openers,
	);
}

async function promptForOpeners(
	existingOpeners: OpenerConfig[] = [],
	currentDefaultOpenerId?: number,
): Promise<{
	openers: OpenerConfig[];
	defaultOpenerId: number;
}> {
	const presets = getPlatformOpenerPresets();
	const selectedKeys = await checkbox({
		message: `Choose the folder openers to enable on ${getPlatformLabel()}`,
		choices: [
			...presets.map((preset) => ({
				name: `${preset.label}  ${preset.description}`,
				value: preset.key,
				checked: existingOpeners.some(
					(opener) =>
						opener.key.toLowerCase() === preset.key.toLowerCase(),
				),
			})),
			{
				name: "Custom command",
				value: "__custom__",
				checked: false,
			},
		],
		validate: (value) => value.length > 0 || "Select at least one opener",
	});

	const openers = [...existingOpeners];

	for (const preset of presets) {
		if (!selectedKeys.includes(preset.key)) {
			continue;
		}
		if (openers.some((opener) => opener.key === preset.key)) {
			continue;
		}

		openers.push(
			createOpenerRecord(
				{
					key: preset.key,
					label: preset.label,
					command: preset.command,
					description: preset.description,
				},
				openers,
			),
		);
	}

	if (selectedKeys.includes("__custom__")) {
		let keepAdding = true;
		while (keepAdding) {
			const customOpener = await promptForCustomOpener(openers);
			openers.push(customOpener);
			keepAdding = await confirm({
				message: "Add another custom opener?",
				default: false,
			});
		}
	}

	const selectedOpeners =
		existingOpeners.length === 0
			? openers.filter(
					(opener) =>
						selectedKeys.includes(opener.key) ||
						(!presets.some((preset) => preset.key === opener.key) &&
							selectedKeys.includes("__custom__")),
				)
			: openers;

	if (selectedOpeners.length === 0) {
		throw new Error("At least one opener is required.");
	}

	const defaultOpenerId = await select<number>({
		message: "Choose the default opener",
		choices: selectedOpeners.map((opener) => ({
			name: formatOpenerChoice(opener),
			value: opener.id,
		})),
		default:
			currentDefaultOpenerId &&
			selectedOpeners.some(
				(opener) => opener.id === currentDefaultOpenerId,
			)
				? currentDefaultOpenerId
				: selectedOpeners[0].id,
	});

	return {
		openers: selectedOpeners,
		defaultOpenerId,
	};
}

async function openLocation(
	location: LocationRecord,
	config: AppConfig,
	openerTarget?: string | null,
): Promise<void> {
	assertLocationPathExists(location.path);
	const opener = openerTarget
		? findOpener(openerTarget, config)
		: getDefaultOpener(config);
	if (!opener) {
		throw new Error(`Opener not found: ${openerTarget}`);
	}

	const command = applyCommandTemplate(opener.command, location);
	info(`Opening ${location.ref} with ${opener.label}`);
	await runShellCommand(command, location.path);
}

async function pickLocation(
	locations: LocationRecord[],
	message: string,
): Promise<LocationRecord> {
	if (locations.length === 0) {
		throw new Error("No saved folders yet. Use `o add` first.");
	}

	const locationId = await select<number>({
		message,
		choices: locations.map((location) => ({
			name: `${location.ref}  ${location.path}`,
			value: location.id,
		})),
	});

	const location = locations.find((item) => item.id === locationId);
	if (!location) {
		throw new Error("Could not resolve the selected location.");
	}

	return location;
}

async function pickOpener(
	config: AppConfig,
	message: string,
): Promise<OpenerConfig> {
	const openerId = await select<number>({
		message,
		choices: config.openers.map((opener) => ({
			name: formatOpenerChoice(opener),
			value: opener.id,
		})),
		default: config.defaultOpenerId,
	});

	const opener = config.openers.find((item) => item.id === openerId);
	if (!opener) {
		throw new Error("Could not resolve the selected opener.");
	}

	return opener;
}

async function addLocationFlow(
	state: LoadedState,
	args: string[] = [],
): Promise<LoadedState> {
	const existing = state.locations;
	let draft: Omit<LocationRecord, "id">;

	if (args.length >= 2) {
		const folderPath = normalizeUserPath(args[1]);
		absolutePathSchema.parse(folderPath);
		assertLocationPathExists(folderPath);
		draft = {
			ref: refSchema.parse(args[0]),
			path: folderPath,
			note: "",
		};
	} else {
		draft = await promptForLocation(existing);
	}

	const location = createLocationRecord(draft, existing);
	const locations = [...existing, location].sort((left, right) =>
		left.ref.localeCompare(right.ref),
	);
	await saveState({
		...state,
		locations,
	});
	success(`Saved ${location.ref}`);
	return {
		...state,
		locations,
	};
}

async function removeLocationFlow(
	state: LoadedState,
	target?: string,
): Promise<LoadedState> {
	const location = target
		? findLocation(target, state.locations)
		: await pickLocation(
				state.locations,
				"Choose the saved folder to remove",
			);

	if (!location) {
		throw new Error(`Saved folder not found: ${target}`);
	}

	const approved = await confirm({
		message: `Remove ${location.ref}?`,
		default: false,
	});
	if (!approved) {
		warn("Removal cancelled.");
		return state;
	}

	const locations = state.locations.filter((item) => item.id !== location.id);
	await saveState({
		...state,
		locations,
	});
	success(`Removed ${location.ref}`);
	return {
		...state,
		locations,
	};
}

async function renameLocationFlow(
	state: LoadedState,
	target?: string,
	nextRefArg?: string,
): Promise<LoadedState> {
	const location = target
		? findLocation(target, state.locations)
		: await pickLocation(
				state.locations,
				"Choose the saved folder to rename",
			);

	if (!location) {
		throw new Error(`Saved folder not found: ${target}`);
	}

	const nextRef = nextRefArg
		? refSchema.parse(nextRefArg)
		: await input({
				message: `New reference for ${location.ref}`,
				default: location.ref,
				validate: (value) => {
					const parsed = refSchema.safeParse(value);
					if (!parsed.success) {
						return (
							parsed.error.issues[0]?.message ??
							"Invalid reference"
						);
					}
					const duplicate = state.locations.some(
						(item) =>
							item.id !== location.id &&
							item.ref.toLowerCase() ===
								parsed.data.toLowerCase(),
					);
					return duplicate
						? `Reference already exists: ${parsed.data}`
						: true;
				},
			});

	assertRefAvailable(nextRef, state.locations, location.id);
	const locations = state.locations.map((item) =>
		item.id === location.id
			? locationSchema.parse({ ...item, ref: nextRef })
			: item,
	);
	await saveState({
		...state,
		locations,
	});
	success(`Renamed ${location.ref} to ${nextRef}`);
	return {
		...state,
		locations,
	};
}

async function clearLocationsFlow(state: LoadedState): Promise<LoadedState> {
	if (state.locations.length === 0) {
		warn("Storage is already empty.");
		return state;
	}

	const approved = await confirm({
		message: "Clear every saved folder? This cannot be undone.",
		default: false,
	});
	if (!approved) {
		warn("Clear cancelled.");
		return state;
	}

	await saveState({
		...state,
		locations: [],
	});
	success("Removed every saved folder.");
	return {
		...state,
		locations: [],
	};
}

function extractCommandBinary(command: string): string | null {
	const trimmed = command.trim();
	if (!trimmed) {
		return null;
	}
	if (trimmed.startsWith('"')) {
		const endIndex = trimmed.indexOf('"', 1);
		return endIndex > 1 ? trimmed.slice(1, endIndex) : null;
	}
	return trimmed.split(/\s+/u)[0] ?? null;
}

function commandExists(command: string): boolean {
	const binary = extractCommandBinary(command);
	if (!binary) {
		return false;
	}
	if (binary.includes(path.sep)) {
		return existsSync(binary);
	}
	const checker = process.platform === "win32" ? "where" : "which";
	const result = spawnSync(checker, [binary], { stdio: "ignore" });
	return result.status === 0;
}

async function runDoctorFlow(state: LoadedState): Promise<LoadedState> {
	console.log(renderBanner());
	console.log(renderConfigSummary(state.config));

	const issues: string[] = [];
	if (process.env.CONFIG_PATH?.trim() !== state.config.storagePath) {
		issues.push("CONFIG_PATH does not match the active storage file.");
		const fixEnv = await confirm({
			message:
				"Update .env so CONFIG_PATH matches the current storage file?",
			default: true,
		});
		if (fixEnv) {
			await writeConfigPathEnv(state.config.storagePath, state.rootDir);
			process.env.CONFIG_PATH = state.config.storagePath;
			success("Updated .env.");
		}
	}

	if (!existsSync(state.config.storageDir)) {
		issues.push(`Storage directory is missing: ${state.config.storageDir}`);
	}

	const missingLocations = state.locations.filter(
		(location) => !existsSync(location.path),
	);
	if (missingLocations.length > 0) {
		issues.push(
			`${missingLocations.length} saved folders no longer exist.`,
		);
		const deleteIds = await checkbox<number>({
			message: "Select missing folders to delete from storage",
			choices: missingLocations.map((location) => ({
				name: `${location.ref}  ${location.path}`,
				value: location.id,
				checked: true,
			})),
		});
		if (deleteIds.length > 0) {
			const locations = state.locations.filter(
				(location) => !deleteIds.includes(location.id),
			);
			await saveState({
				...state,
				locations,
			});
			state = {
				...state,
				locations,
			};
			success(`Deleted ${deleteIds.length} missing entries.`);
		}
	}

	const brokenOpeners = state.config.openers.filter(
		(opener) => !commandExists(opener.command),
	);
	if (brokenOpeners.length > 0) {
		issues.push(
			`${brokenOpeners.length} opener commands are not currently available.`,
		);
		warn("Unavailable openers:");
		console.log(
			renderOpenerList(brokenOpeners, state.config.defaultOpenerId),
		);
	}

	if (issues.length === 0) {
		success("Doctor found no issues.");
	} else {
		warn("Doctor summary:");
		issues.forEach((issue) => console.log(`  - ${issue}`));
	}

	return state;
}

async function saveDefaultOpener(
	state: LoadedState,
	opener: OpenerConfig,
): Promise<LoadedState> {
	return saveState({
		...state,
		config: {
			...state.config,
			defaultOpenerId: opener.id,
		},
	});
}

async function saveStorageIndent(
	state: LoadedState,
	storageIndent: number,
): Promise<LoadedState> {
	return saveState({
		...state,
		config: {
			...state.config,
			storageIndent,
		},
	});
}

async function saveUpdateSource(
	state: LoadedState,
	repositoryUrl: string,
	branch: string,
): Promise<LoadedState> {
	return saveState({
		...state,
		config: {
			...state.config,
			update: {
				repositoryUrl: repositoryUrl.trim(),
				branch: branch.trim(),
				check: resetUpdateCheck(state.config.update.check),
			},
		},
	});
}

async function handleConfigCommand(
	state: LoadedState,
	args: string[],
): Promise<LoadedState> {
	const [subcommand, ...rest] = args;

	if (!subcommand) {
		return configMenuFlow(state);
	}

	if (subcommand === "show") {
		printConfigState(state);
		return state;
	}

	if (subcommand !== "set") {
		throw new Error(
			"Unknown config command. Use `o config`, `o config show`, or `o config set <field> <value>`.",
		);
	}

	const [field, ...values] = rest;
	if (!field) {
		throw new Error(
			"Usage: o config set <default-opener|storage-dir|indent|update-repo|update-branch|update-source> <value>",
		);
	}

	if (field === "default-opener" || field === "default") {
		const target = values[0];
		if (!target) {
			throw new Error(
				"Usage: o config set default-opener <opener-id|opener-key>",
			);
		}
		const opener = findOpener(target, state.config);
		if (!opener) {
			throw new Error(`Opener not found: ${target}`);
		}
		const nextState = await saveDefaultOpener(state, opener);
		success(`Default opener set to ${opener.label}`);
		return nextState;
	}

	if (field === "storage-dir") {
		const nextDirInput = values[0];
		if (!nextDirInput) {
			throw new Error("Usage: o config set storage-dir <absolute-path>");
		}
		const nextDir = normalizeUserPath(nextDirInput);
		absolutePathSchema.parse(nextDir);

		if (nextDir === state.config.storageDir) {
			info(`Storage already uses ${nextDir}`);
			return state;
		}

		const approved = await confirm({
			message: `Move storage.json to ${nextDir}? The old storage file will be removed.`,
			default: false,
		});
		if (!approved) {
			warn("Storage move cancelled.");
			return state;
		}

		const nextState = await moveStorageDirectory(state, nextDir);
		success(`Storage moved to ${nextState.config.storageDir}`);
		return nextState;
	}

	if (field === "indent" || field === "storage-indent") {
		const rawIndent = values[0];
		if (!rawIndent) {
			throw new Error("Usage: o config set indent <2-8>");
		}
		const storageIndent = parseStorageIndent(rawIndent);
		const nextState = await saveStorageIndent(state, storageIndent);
		success(`Indent updated to ${storageIndent}`);
		return nextState;
	}

	if (field === "update-repo" || field === "repository") {
		const repositoryUrl = values[0]?.trim();
		if (!repositoryUrl) {
			throw new Error(
				"Usage: o config set update-repo <repository-url|owner/repo>",
			);
		}
		const nextState = await saveUpdateSource(
			state,
			repositoryUrl,
			state.config.update.branch,
		);
		success("Update repository saved.");
		return nextState;
	}

	if (field === "update-branch" || field === "branch") {
		const branch = values[0]?.trim();
		if (!branch) {
			throw new Error("Usage: o config set update-branch <branch>");
		}
		const nextState = await saveUpdateSource(
			state,
			state.config.update.repositoryUrl,
			branch,
		);
		success("Update branch saved.");
		return nextState;
	}

	if (field === "update-source") {
		const repositoryUrl = values[0]?.trim();
		const branch = values[1]?.trim();
		if (!repositoryUrl || !branch) {
			throw new Error(
				"Usage: o config set update-source <repository-url|owner/repo> <branch>",
			);
		}
		const nextState = await saveUpdateSource(state, repositoryUrl, branch);
		success("Update source saved.");
		return nextState;
	}

	throw new Error(
		`Unknown config field: ${field}. Supported fields: default-opener, storage-dir, indent, update-repo, update-branch, update-source.`,
	);
}

async function configMenuFlow(state: LoadedState): Promise<LoadedState> {
	let current = state;

	while (true) {
		printConfigState(current);

		const action = await select<string>({
			message: "Config",
			choices: [
				{ name: "Change default opener", value: "default" },
				{ name: "Add more openers", value: "add-openers" },
				{ name: "Remove an opener", value: "remove-opener" },
				{ name: "Move storage directory", value: "move-storage" },
				{ name: "Change JSON indent", value: "indent" },
				{ name: "Change update source", value: "update-source" },
				{ name: "Back", value: "back" },
			],
		});

		if (action === "back") {
			return current;
		}

		if (action === "default") {
			const opener = await pickOpener(
				current.config,
				"Choose the default opener",
			);
			current = await saveDefaultOpener(current, opener);
			success(`Default opener set to ${opener.label}`);
			continue;
		}

		if (action === "add-openers") {
			const next = await promptForOpeners(
				current.config.openers,
				current.config.defaultOpenerId,
			);
			current = await saveState({
				...current,
				config: {
					...current.config,
					openers: next.openers,
					defaultOpenerId: next.defaultOpenerId,
				},
			});
			success("Updated opener list.");
			continue;
		}

		if (action === "remove-opener") {
			if (current.config.openers.length === 1) {
				warn("At least one opener must remain.");
				continue;
			}
			const opener = await pickOpener(
				current.config,
				"Choose the opener to remove",
			);
			const approved = await confirm({
				message: `Remove ${opener.label}?`,
				default: false,
			});
			if (!approved) {
				continue;
			}

			const openers = current.config.openers.filter(
				(item) => item.id !== opener.id,
			);
			const defaultOpenerId =
				current.config.defaultOpenerId === opener.id
					? openers[0].id
					: current.config.defaultOpenerId;
			current = await saveState({
				...current,
				config: {
					...current.config,
					openers,
					defaultOpenerId,
				},
			});
			success(`Removed ${opener.label}`);
			continue;
		}

		if (action === "move-storage") {
			const approved = await confirm({
				message:
					"Move storage.json to a new directory? The old storage file will be removed.",
				default: false,
			});
			if (!approved) {
				continue;
			}

			const nextDirInput = await input({
				message: "New storage directory",
				default: current.config.storageDir,
			});
			current = await moveStorageDirectory(
				current,
				normalizeUserPath(nextDirInput),
			);
			success(`Storage moved to ${current.config.storageDir}`);
			continue;
		}

		if (action === "indent") {
			const indentInput = await input({
				message: "JSON indentation",
				default: String(current.config.storageIndent),
				validate: validateStorageIndent,
			});
			const storageIndent = parseStorageIndent(indentInput);
			current = await saveStorageIndent(current, storageIndent);
			success(`Indent updated to ${storageIndent}`);
			continue;
		}

		if (action === "update-source") {
			const repositoryUrl = await input({
				message:
					"Repository URL or GitHub owner/repo used by `o update`",
				default:
					current.config.update.repositoryUrl ||
					DEFAULT_UPDATE_REPOSITORY,
			});
			const branch = await input({
				message: "Branch",
				default: current.config.update.branch,
				validate: (value) =>
					value.trim().length > 0 || "Branch is required",
			});
			current = await saveUpdateSource(current, repositoryUrl, branch);
			success("Update source saved.");
		}
	}
}

async function setupFlow(force = false): Promise<LoadedState> {
	const existing = await loadState({ allowFallbackToCwd: true });
	if (existing && !force) {
		const approved = await confirm({
			message:
				"Setup already exists. Run setup again and replace the current config?",
			default: false,
		});
		if (!approved) {
			return existing;
		}
	}

	console.log(renderBanner());
	info(
		"Setup will create storage.json and .env so open-cli is ready to use.",
	);

	const storageDirInput = await input({
		message: "Directory that should contain storage.json",
		default: getDefaultStorageDir(),
	});
	const storageDir = normalizeUserPath(storageDirInput);

	const openerSelection = await promptForOpeners();
	const addFirstLocation = await confirm({
		message: "Add your first saved folder now? Recommended.",
		default: true,
	});

	const initialLocation = addFirstLocation
		? await promptForLocation([])
		: undefined;
	const detectedRepository = detectRepositoryInfo(getProjectRoot());
	const repositoryUrl = await input({
		message: "Repository URL or GitHub owner/repo for `o update`",
		default: DEFAULT_UPDATE_REPOSITORY,
	});
	const branch = await input({
		message: "Branch to pull during updates",
		default: detectedRepository.branch,
		validate: (value) => value.trim().length > 0 || "Branch is required",
	});

	const state = await initializeRuntime({
		storageDir,
		openers: openerSelection.openers,
		defaultOpenerId: openerSelection.defaultOpenerId,
		storageIndent: 4,
		repositoryUrl,
		branch,
		initialLocation,
	});

	success(`Setup complete. Active storage: ${state.config.storagePath}`);
	if (state.locations.length > 0) {
		success(`First folder ready: ${state.locations[0].ref}`);
	}
	return state;
}

async function interactivePicker(): Promise<void> {
	const loadedState = await loadState({ allowFallbackToCwd: true });
	const state = loadedState
		? await maybeNotifyIfUpdateAvailable(loadedState)
		: null;
	if (!state) {
		await setupFlow();
		return;
	}

	if (state.locations.length === 0) {
		warn("No saved folders yet.");
		await addLocationFlow(state);
		return;
	}

	const choice = await select<string>({
		message: "Choose a saved folder or action",
		choices: [
			...state.locations.map((location) => ({
				name: `${location.ref}  ${location.path}`,
				value: String(location.id),
			})),
			{ name: "Add a saved folder", value: "__add__" },
			{ name: "Configure open-cli", value: "__config__" },
			{ name: "Run doctor", value: "__doctor__" },
			{ name: "Show help", value: "__help__" },
		],
	});

	if (choice === "__add__") {
		await addLocationFlow(state);
		return;
	}
	if (choice === "__config__") {
		await configMenuFlow(state);
		return;
	}
	if (choice === "__doctor__") {
		await runDoctorFlow(state);
		return;
	}
	if (choice === "__help__") {
		console.log(renderHelp());
		return;
	}

	const location = findLocation(choice, state.locations);
	if (!location) {
		throw new Error("Could not resolve the selected location.");
	}
	await openLocation(location, state.config);
}

async function updateFlow(state: LoadedState): Promise<LoadedState> {
	const repositoryUrl = state.config.update.repositoryUrl.trim();
	if (!repositoryUrl) {
		throw new Error(
			"Update source is not configured. Use `o config` to set a repository URL first.",
		);
	}

	const approved = await confirm({
		message: `Clone the latest snapshot from ${repositoryUrl} and rebuild this CLI now?`,
		default: true,
	});
	if (!approved) {
		warn("Update cancelled.");
		return state;
	}

	const branch = state.config.update.branch.trim() || "main";
	const cloneSource = resolveRepositoryCloneSource(repositoryUrl);
	const tempRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "open-cli-update-"),
	);
	const cloneDir = path.join(tempRoot, "repo");
	const rootDir = state.rootDir;

	try {
		await runProcess("git", [
			"clone",
			"--depth",
			"1",
			"--branch",
			branch,
			cloneSource,
			cloneDir,
		]);

		const entries = await fs.readdir(cloneDir, { withFileTypes: true });
		for (const entry of entries) {
			if (
				[
					".git",
					".env",
					".env.local",
					"dist",
					"node_modules",
					"storage",
				].includes(entry.name)
			) {
				continue;
			}
			await fs.cp(
				path.join(cloneDir, entry.name),
				path.join(rootDir, entry.name),
				{
					recursive: true,
					force: true,
				},
			);
		}

		await runProcess("pnpm", ["install"], { cwd: rootDir });
		await runProcess("pnpm", ["build"], { cwd: rootDir });
		await writeConfigPathEnv(state.config.storagePath, rootDir);

		let reloaded = await requireState(false);
		const installedRevision = detectRepositoryInfo(cloneDir).revision;
		if (installedRevision) {
			reloaded = await saveState({
				...reloaded,
				config: {
					...reloaded.config,
					update: {
						...reloaded.config.update,
						check: {
							...reloaded.config.update.check,
							installedRevision,
							lastCheckedAt: "",
							latestVersion: "",
							latestRevision: "",
						},
					},
				},
			});
		}
		success("Update complete. Config and storage were preserved.");
		return reloaded;
	} finally {
		await fs.rm(tempRoot, { recursive: true, force: true });
	}
}

export async function runCli(args: string[]): Promise<void> {
	if (args.length === 0) {
		await interactivePicker();
		return;
	}

	const [command, ...rest] = args;
	if (command === "-v" || command === "--version" || command === "version") {
		await printVersion();
		return;
	}
	const parsed = parseWithOption(rest);

	if (command === "help") {
		console.log(renderHelp());
		return;
	}

	if (command === "setup") {
		await setupFlow();
		return;
	}

	if (command === "add") {
		const state = await requireState();
		await addLocationFlow(state, parsed.args);
		return;
	}

	if (command === "rm") {
		const state = await requireState();
		await removeLocationFlow(state, parsed.args[0]);
		return;
	}

	if (command === "rename") {
		const state = await requireState();
		await renameLocationFlow(state, parsed.args[0], parsed.args[1]);
		return;
	}

	if (command === "clr") {
		const state = await requireState();
		await clearLocationsFlow(state);
		return;
	}

	if (command === "ls" || command === "list") {
		const state = await requireState();
		printLocations(state.locations);
		return;
	}

	if (command === "config") {
		const state = await requireState();
		await handleConfigCommand(state, parsed.args);
		return;
	}

	if (command === "doctor") {
		const state = await requireState();
		await runDoctorFlow(state);
		return;
	}

	if (command === "update") {
		const state = await requireState();
		await updateFlow(state);
		return;
	}

	if (command === "browse") {
		await interactivePicker();
		return;
	}

	if (command === "open") {
		const state = await requireState();
		const location = parsed.args[0]
			? findLocation(parsed.args[0], state.locations)
			: await pickLocation(
					state.locations,
					"Choose the saved folder to open",
				);
		if (!location) {
			throw new Error(`Saved folder not found: ${parsed.args[0]}`);
		}
		await openLocation(location, state.config, parsed.openerTarget);
		return;
	}

	const state = await requireState();
	const location = findLocation(command, state.locations);
	if (!location) {
		throw new Error(`Unknown command or saved reference: ${command}`);
	}
	await openLocation(location, state.config, parsed.openerTarget);
}
