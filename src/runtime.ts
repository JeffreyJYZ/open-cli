import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkbox, confirm, input, select } from "@inquirer/prompts";
import {
	type AppConfig,
	type LocationRecord,
	type OpenerConfig,
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
	getNextId,
	getProjectRoot,
	getDefaultStorageDir,
	loadState,
	type LoadedState,
	initializeRuntime,
	moveStorageDirectory,
	normalizeUserPath,
	saveConfig,
	saveLocations,
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

async function requireState(): Promise<LoadedState> {
	const state = await loadState({ allowFallbackToCwd: true });
	if (state) {
		return state;
	}
	throw new Error("No config found yet. Run `o setup` first.");
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
	await saveLocations(state.config, locations);
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
	await saveLocations(state.config, locations);
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
	await saveLocations(state.config, locations);
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

	await saveLocations(state.config, []);
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
	if (process.env.CONFIG_PATH?.trim() !== state.config.configPath) {
		issues.push("CONFIG_PATH does not match the active config file.");
		const fixEnv = await confirm({
			message: "Update .env so CONFIG_PATH matches the current config?",
			default: true,
		});
		if (fixEnv) {
			await writeConfigPathEnv(state.config.configPath, state.rootDir);
			process.env.CONFIG_PATH = state.config.configPath;
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
			await saveLocations(state.config, locations);
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

async function configMenuFlow(state: LoadedState): Promise<LoadedState> {
	let current = state;

	while (true) {
		console.log(renderBanner());
		console.log(renderConfigSummary(current.config));
		console.log(
			renderOpenerList(
				current.config.openers,
				current.config.defaultOpenerId,
			),
		);

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
			current = {
				...current,
				config: await saveConfig({
					...current.config,
					defaultOpenerId: opener.id,
				}),
			};
			success(`Default opener set to ${opener.label}`);
			continue;
		}

		if (action === "add-openers") {
			const next = await promptForOpeners(
				current.config.openers,
				current.config.defaultOpenerId,
			);
			current = {
				...current,
				config: await saveConfig({
					...current.config,
					openers: next.openers,
					defaultOpenerId: next.defaultOpenerId,
				}),
			};
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
			current = {
				...current,
				config: await saveConfig({
					...current.config,
					openers,
					defaultOpenerId,
				}),
			};
			success(`Removed ${opener.label}`);
			continue;
		}

		if (action === "move-storage") {
			const approved = await confirm({
				message:
					"Move config.json and locs.json to a new directory? Existing files in the old directory will be removed.",
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
				current.config,
				current.locations,
				normalizeUserPath(nextDirInput),
				current.rootDir,
			);
			success(`Storage moved to ${current.config.storageDir}`);
			continue;
		}

		if (action === "indent") {
			const indentInput = await input({
				message: "JSON indentation",
				default: String(current.config.storageIndent),
				validate: (value) => {
					const parsed = Number.parseInt(value, 10);
					return parsed >= 2 && parsed <= 8
						? true
						: "Indent must be a whole number between 2 and 8";
				},
			});
			const storageIndent = Number.parseInt(indentInput, 10);
			current = {
				...current,
				config: await saveConfig({
					...current.config,
					storageIndent,
				}),
			};
			await saveLocations(current.config, current.locations);
			success(`Indent updated to ${storageIndent}`);
			continue;
		}

		if (action === "update-source") {
			const repositoryUrl = await input({
				message: "Repository URL used by `o update`",
				default: current.config.update.repositoryUrl,
			});
			const branch = await input({
				message: "Branch",
				default: current.config.update.branch,
				validate: (value) =>
					value.trim().length > 0 || "Branch is required",
			});
			current = {
				...current,
				config: await saveConfig({
					...current.config,
					update: {
						repositoryUrl: repositoryUrl.trim(),
						branch: branch.trim(),
					},
				}),
			};
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
		"Setup will create config.json, locs.json, and .env so the CLI is ready to use.",
	);

	const storageDirInput = await input({
		message: "Directory that should contain config.json and locs.json",
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
		message: "Repository URL for `o update`",
		default: detectedRepository.repositoryUrl,
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

	success(`Setup complete. Active config: ${state.config.configPath}`);
	if (state.locations.length > 0) {
		success(`First folder ready: ${state.locations[0].ref}`);
	}
	return state;
}

async function interactivePicker(): Promise<void> {
	const state = await loadState({ allowFallbackToCwd: true });
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
			{ name: "Management dashboard", value: "__manage__" },
			{ name: "Run doctor", value: "__doctor__" },
			{ name: "Show help", value: "__help__" },
		],
	});

	if (choice === "__add__") {
		await addLocationFlow(state);
		return;
	}
	if (choice === "__manage__") {
		await runManageMode();
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
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "open-update-"));
	const cloneDir = path.join(tempRoot, "repo");
	const rootDir = state.rootDir;

	try {
		await runProcess("git", [
			"clone",
			"--depth",
			"1",
			"--branch",
			branch,
			repositoryUrl,
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
		await writeConfigPathEnv(state.config.configPath, rootDir);

		const reloaded = await requireState();
		success("Update complete. Config and storage were preserved.");
		return reloaded;
	} finally {
		await fs.rm(tempRoot, { recursive: true, force: true });
	}
}

export async function runManageMode(): Promise<void> {
	let state = await loadState({ allowFallbackToCwd: true });

	while (true) {
		console.log(renderBanner());
		if (state) {
			console.log(renderConfigSummary(state.config));
			console.log(`Saved folders: ${state.locations.length}`);
		} else {
			warn("No active setup yet.");
		}

		const action = await select<string>({
			message: "Manage",
			choices: [
				{ name: "Setup", value: "setup" },
				{ name: "Open a saved folder", value: "open" },
				{ name: "Add a saved folder", value: "add" },
				{ name: "List saved folders", value: "list" },
				{ name: "Remove a saved folder", value: "remove" },
				{ name: "Rename a reference", value: "rename" },
				{ name: "Config", value: "config" },
				{ name: "Doctor", value: "doctor" },
				{ name: "Update CLI", value: "update" },
				{ name: "Help", value: "help" },
				{ name: "Exit", value: "exit" },
			],
		});

		if (action === "exit") {
			return;
		}

		if (action === "help") {
			console.log(renderHelp());
			continue;
		}

		if (action === "setup") {
			state = await setupFlow(Boolean(state));
			continue;
		}

		if (!state) {
			throw new Error("Run setup first.");
		}

		if (action === "open") {
			const location = await pickLocation(
				state.locations,
				"Choose the saved folder to open",
			);
			const useDefault = await confirm({
				message: "Use the default opener?",
				default: true,
			});
			const opener = useDefault
				? null
				: await pickOpener(state.config, "Choose an opener");
			await openLocation(location, state.config, opener?.key ?? null);
			continue;
		}

		if (action === "add") {
			state = await addLocationFlow(state);
			continue;
		}

		if (action === "list") {
			printLocations(state.locations);
			continue;
		}

		if (action === "remove") {
			state = await removeLocationFlow(state);
			continue;
		}

		if (action === "rename") {
			state = await renameLocationFlow(state);
			continue;
		}

		if (action === "config") {
			state = await configMenuFlow(state);
			continue;
		}

		if (action === "doctor") {
			state = await runDoctorFlow(state);
			continue;
		}

		if (action === "update") {
			state = await updateFlow(state);
		}
	}
}

export async function runCli(args: string[]): Promise<void> {
	if (args.length === 0) {
		await interactivePicker();
		return;
	}

	const [command, ...rest] = args;
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
		await configMenuFlow(state);
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
