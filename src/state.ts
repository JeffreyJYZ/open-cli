import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import {
	APP_CONFIG_VERSION,
	CONFIG_FILE_NAME,
	type AppConfig,
	type LocationRecord,
	LOCATIONS_FILE_NAME,
	type OpenerConfig,
	buildLegacyOpenerCommand,
	configSchema,
	getPlatformOpenerPresets,
	legacyConfigSchema,
	legacyLocationSchema,
	locationSchema,
	storageSchema,
	refSchema,
} from "./domain";

export interface LoadedState {
	rootDir: string;
	config: AppConfig;
	locations: LocationRecord[];
}

export interface SetupOptions {
	storageDir: string;
	openers: OpenerConfig[];
	defaultOpenerId: number;
	storageIndent: number;
	repositoryUrl: string;
	branch: string;
	initialLocation?: Omit<LocationRecord, "id">;
}

function parseJson(raw: string, filePath: string): unknown {
	try {
		return JSON.parse(raw);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not parse JSON in ${filePath}: ${reason}`);
	}
}

async function readJsonFile(filePath: string): Promise<unknown> {
	try {
		const raw = await fs.readFile(filePath, "utf8");
		if (raw.trim() === "") {
			return null;
		}
		return parseJson(raw, filePath);
	} catch (error) {
		if (
			typeof error === "object" &&
			error &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return null;
		}
		throw error;
	}
}

async function ensureDirectory(dirPath: string): Promise<void> {
	await fs.mkdir(dirPath, { recursive: true });
}

async function writeJsonFile(
	filePath: string,
	data: unknown,
	indent: number,
): Promise<void> {
	await ensureDirectory(path.dirname(filePath));
	await fs.writeFile(
		filePath,
		JSON.stringify(data, null, indent) + "\n",
		"utf8",
	);
}

async function syncEnvWithConfig(
	configPath: string,
	rootDir: string,
): Promise<void> {
	await writeConfigPathEnv(configPath, rootDir);
	process.env.CONFIG_PATH = configPath;
}

function materializePresetOpeners(
	presets: Array<Omit<OpenerConfig, "id">>,
): OpenerConfig[] {
	return presets.map((preset, index) => ({
		id: index + 1,
		...preset,
	}));
}

function migrateLegacyConfig(
	raw: unknown,
	configPath: string,
	rootDir: string,
): AppConfig | null {
	const parsed = legacyConfigSchema.safeParse(raw);
	if (!parsed.success) {
		return null;
	}

	const legacy = parsed.data;
	const storageDir = path.dirname(configPath);
	const storagePath =
		legacy.storagePath ?? path.join(storageDir, LOCATIONS_FILE_NAME);
	const detected = detectRepositoryInfo(rootDir);

	const openers =
		legacy.openers?.map((opener, index) => ({
			id: index + 1,
			key:
				opener.name
					.toLowerCase()
					.replaceAll(/[^a-z0-9]+/gu, "-")
					.replaceAll(/^-|-$/gu, "") || `opener-${index + 1}`,
			label: opener.name,
			command: buildLegacyOpenerCommand(opener.app),
			description: `Migrated from legacy option ${opener.opt}`,
		})) ?? materializePresetOpeners(getPlatformOpenerPresets());

	const defaultOpenerId =
		legacy.defaultOpener &&
		openers.some((opener) => opener.id === legacy.defaultOpener)
			? legacy.defaultOpener
			: openers[0].id;

	return configSchema.parse({
		version: APP_CONFIG_VERSION,
		configPath,
		storagePath,
		storageDir,
		storageIndent: legacy.storageFileIndent ?? 4,
		openers,
		defaultOpenerId,
		update: {
			repositoryUrl: detected.repositoryUrl,
			branch: detected.branch,
		},
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});
}

function migrateLegacyLocations(raw: unknown): LocationRecord[] | null {
	if (!Array.isArray(raw)) {
		return null;
	}

	const migrated = raw.map((item) => {
		const legacy = legacyLocationSchema.parse(item);
		return locationSchema.parse({
			id: legacy.id,
			ref: legacy.ref,
			path: legacy.url,
			note: "",
		});
	});

	return storageSchema.parse(migrated);
}

function getFallbackConfigPath(): string {
	return path.join(process.cwd(), "storage", CONFIG_FILE_NAME);
}

export function getProjectRoot(): string {
	const scriptPath = process.argv[1];
	if (!scriptPath) {
		return process.cwd();
	}

	const resolvedScriptPath = realpathSync(scriptPath);
	const scriptDir = path.dirname(resolvedScriptPath);
	const parentDirName = path.basename(scriptDir);

	if (parentDirName === "src" || parentDirName === "dist") {
		return path.resolve(scriptDir, "..");
	}

	return scriptDir;
}

export function loadEnvironment(rootDir = getProjectRoot()): void {
	dotenv.config({ path: path.join(rootDir, ".env"), quiet: true });
	dotenv.config({ path: path.join(rootDir, ".env.local"), quiet: true });
}

export function getConfiguredPathFromEnv(
	rootDir = getProjectRoot(),
): string | null {
	loadEnvironment(rootDir);
	const configPath = process.env.CONFIG_PATH?.trim();
	if (!configPath) {
		return null;
	}
	return path.isAbsolute(configPath)
		? configPath
		: path.resolve(rootDir, configPath);
}

export function getDefaultStorageDir(): string {
	return path.join(process.cwd(), "storage");
}

export function getNextId(items: Array<{ id: number }>): number {
	return items.length === 0
		? 1
		: Math.max(...items.map((item) => item.id)) + 1;
}

export function normalizeUserPath(input: string): string {
	const trimmed = input.trim();
	if (trimmed === "~") {
		return os.homedir();
	}
	if (trimmed.startsWith("~/")) {
		return path.join(os.homedir(), trimmed.slice(2));
	}
	return path.resolve(trimmed);
}

export function slugifyKey(label: string): string {
	return (
		label
			.toLowerCase()
			.replaceAll(/[^a-z0-9]+/gu, "-")
			.replaceAll(/^-|-$/gu, "") || "custom"
	);
}

export function createLocationRecord(
	values: Omit<LocationRecord, "id">,
	locations: LocationRecord[],
): LocationRecord {
	const record = locationSchema.parse({
		id: getNextId(locations),
		ref: values.ref,
		path: values.path,
		note: values.note ?? "",
	});

	if (
		locations.some(
			(item) => item.ref.toLowerCase() === record.ref.toLowerCase(),
		)
	) {
		throw new Error(`Reference already exists: ${record.ref}`);
	}

	if (locations.some((item) => item.path === record.path)) {
		throw new Error(`Path is already saved: ${record.path}`);
	}

	return record;
}

export function createOpenerRecord(
	values: Omit<OpenerConfig, "id">,
	openers: OpenerConfig[],
): OpenerConfig {
	const record = {
		id: getNextId(openers),
		...values,
	};
	const parsed = configSchema.shape.openers.element.parse(record);

	if (
		openers.some(
			(item) => item.key.toLowerCase() === parsed.key.toLowerCase(),
		)
	) {
		throw new Error(`Opener key already exists: ${parsed.key}`);
	}

	return parsed;
}

export async function writeConfigPathEnv(
	configPath: string,
	rootDir = getProjectRoot(),
): Promise<void> {
	const envPath = path.join(rootDir, ".env");
	let existing = "";

	try {
		existing = await fs.readFile(envPath, "utf8");
	} catch (error) {
		if (
			typeof error === "object" &&
			error &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			existing = "";
		} else {
			throw error;
		}
	}

	const lines =
		existing === "" ? [] : existing.split(/\r?\n/u).filter(Boolean);
	const nextLines = lines.filter((line) => !line.startsWith("CONFIG_PATH="));
	nextLines.push(`CONFIG_PATH=${configPath}`);
	await fs.writeFile(envPath, nextLines.join("\n") + "\n", "utf8");
}

export async function saveConfig(
	config: AppConfig,
	rootDir = getProjectRoot(),
): Promise<AppConfig> {
	const parsed = configSchema.parse({
		...config,
		updatedAt: new Date().toISOString(),
	});
	await writeJsonFile(parsed.configPath, parsed, parsed.storageIndent);
	await syncEnvWithConfig(parsed.configPath, rootDir);
	return parsed;
}

export async function saveLocations(
	config: AppConfig,
	locations: LocationRecord[],
): Promise<LocationRecord[]> {
	const parsed = storageSchema.parse(locations);
	await writeJsonFile(config.storagePath, parsed, config.storageIndent);
	return parsed;
}

export async function readConfig(options?: {
	allowFallbackToCwd?: boolean;
	rootDir?: string;
}): Promise<AppConfig | null> {
	const rootDir = options?.rootDir ?? getProjectRoot();
	const configuredPath = getConfiguredPathFromEnv(rootDir);
	const fallbackPath = getFallbackConfigPath();
	const configPath =
		configuredPath ?? (options?.allowFallbackToCwd ? fallbackPath : null);

	if (!configPath) {
		return null;
	}

	const raw = await readJsonFile(configPath);
	if (raw === null) {
		return null;
	}

	const parsed = configSchema.safeParse(raw);
	if (parsed.success) {
		await syncEnvWithConfig(parsed.data.configPath, rootDir);
		return parsed.data;
	}

	const migrated = migrateLegacyConfig(raw, configPath, rootDir);
	if (!migrated) {
		throw new Error(
			`Config file does not match the expected schema: ${configPath}`,
		);
	}

	await saveConfig(migrated, rootDir);
	return migrated;
}

export async function readLocations(
	config: AppConfig,
): Promise<LocationRecord[]> {
	const raw = await readJsonFile(config.storagePath);
	if (raw === null) {
		return [];
	}

	const parsed = storageSchema.safeParse(raw);
	if (parsed.success) {
		return parsed.data;
	}

	const migrated = migrateLegacyLocations(raw);
	if (!migrated) {
		throw new Error(
			`Storage file does not match the expected schema: ${config.storagePath}`,
		);
	}

	await saveLocations(config, migrated);
	return migrated;
}

export async function loadState(options?: {
	allowFallbackToCwd?: boolean;
	rootDir?: string;
}): Promise<LoadedState | null> {
	const rootDir = options?.rootDir ?? getProjectRoot();
	const config = await readConfig({
		allowFallbackToCwd: options?.allowFallbackToCwd,
		rootDir,
	});

	if (!config) {
		return null;
	}

	const locations = await readLocations(config);
	return {
		rootDir,
		config,
		locations,
	};
}

export async function initializeRuntime(
	options: SetupOptions,
	rootDir = getProjectRoot(),
): Promise<LoadedState> {
	const storageDir = normalizeUserPath(options.storageDir);
	const configPath = path.join(storageDir, CONFIG_FILE_NAME);
	const storagePath = path.join(storageDir, LOCATIONS_FILE_NAME);
	const now = new Date().toISOString();

	const config = configSchema.parse({
		version: APP_CONFIG_VERSION,
		configPath,
		storagePath,
		storageDir,
		storageIndent: options.storageIndent,
		openers: options.openers,
		defaultOpenerId: options.defaultOpenerId,
		update: {
			repositoryUrl: options.repositoryUrl.trim(),
			branch: options.branch.trim() || "main",
		},
		createdAt: now,
		updatedAt: now,
	});

	const initialLocations = options.initialLocation
		? [createLocationRecord(options.initialLocation, [])]
		: [];

	await ensureDirectory(storageDir);
	await saveConfig(config, rootDir);
	await saveLocations(config, initialLocations);

	return {
		rootDir,
		config,
		locations: initialLocations,
	};
}

export async function moveStorageDirectory(
	config: AppConfig,
	locations: LocationRecord[],
	nextStorageDir: string,
	rootDir = getProjectRoot(),
): Promise<LoadedState> {
	const normalizedDir = normalizeUserPath(nextStorageDir);
	if (normalizedDir === config.storageDir) {
		return {
			rootDir,
			config,
			locations,
		};
	}

	const nextConfig = configSchema.parse({
		...config,
		configPath: path.join(normalizedDir, CONFIG_FILE_NAME),
		storagePath: path.join(normalizedDir, LOCATIONS_FILE_NAME),
		storageDir: normalizedDir,
		updatedAt: new Date().toISOString(),
	});

	await ensureDirectory(normalizedDir);
	await saveLocations(nextConfig, locations);
	await saveConfig(nextConfig, rootDir);

	if (config.storagePath !== nextConfig.storagePath) {
		await fs.rm(config.storagePath, { force: true });
	}
	if (config.configPath !== nextConfig.configPath) {
		await fs.rm(config.configPath, { force: true });
	}

	return {
		rootDir,
		config: nextConfig,
		locations,
	};
}

export function detectRepositoryInfo(rootDir = getProjectRoot()): {
	repositoryUrl: string;
	branch: string;
} {
	const repositoryUrlResult = spawnSync(
		"git",
		["config", "--get", "remote.origin.url"],
		{
			cwd: rootDir,
			encoding: "utf8",
		},
	);
	const branchResult = spawnSync(
		"git",
		["rev-parse", "--abbrev-ref", "HEAD"],
		{
			cwd: rootDir,
			encoding: "utf8",
		},
	);

	return {
		repositoryUrl:
			repositoryUrlResult.status === 0
				? repositoryUrlResult.stdout.trim()
				: "",
		branch:
			branchResult.status === 0 && branchResult.stdout.trim() !== "HEAD"
				? branchResult.stdout.trim()
				: "main",
	};
}

export function assertLocationPathExists(locationPath: string): void {
	if (!existsSync(locationPath)) {
		throw new Error(`Path does not exist: ${locationPath}`);
	}
}

export function assertRefAvailable(
	reference: string,
	locations: LocationRecord[],
	ignoreId?: number,
): void {
	const parsedReference = refSchema.parse(reference);
	const taken = locations.some(
		(location) =>
			location.id !== ignoreId &&
			location.ref.toLowerCase() === parsedReference.toLowerCase(),
	);
	if (taken) {
		throw new Error(`Reference already exists: ${parsedReference}`);
	}
}
