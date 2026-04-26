import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";
import {
	APP_STORAGE_VERSION,
	type AppConfig,
	type AppStorage,
	DEFAULT_UPDATE_REPOSITORY,
	type LocationRecord,
	absolutePathSchema,
	configSchema,
	type OpenerConfig,
	openerSchema,
	locationSchema,
	locationsSchema,
	refSchema,
	STORAGE_FILE_NAME,
	storageFileSchema,
	updateCheckSchema,
} from "./domain";

const LEGACY_CONFIG_FILE_NAME = "config.json";
const LEGACY_LOCATIONS_FILE_NAME = "locs.json";

const legacySplitConfigSchema = z
	.object({
		version: z.union([z.literal(2), z.literal("2")]).optional(),
		configPath: absolutePathSchema.optional(),
		storagePath: absolutePathSchema.optional(),
		storageDir: absolutePathSchema.optional(),
		storageIndent: z.number().int().min(2).max(8).default(4),
		openers: z
			.array(openerSchema)
			.min(1, "At least one opener is required"),
		defaultOpenerId: z.number().int().positive(),
		update: z
			.object({
				repositoryUrl: z.string().trim().max(300).default(""),
				branch: z.string().trim().min(1).max(80).default("main"),
			})
			.strict(),
		createdAt: z.string().trim().min(1),
		updatedAt: z.string().trim().min(1),
	})
	.strict();

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

function formatSchemaError(error: z.ZodError): string {
	const issue = error.issues[0];
	if (!issue) {
		return "Unknown schema validation error";
	}

	const location = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
	return `${issue.message}${location}`;
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

function splitStorage(storage: AppStorage): Omit<LoadedState, "rootDir"> {
	const { locations, ...config } = storage;
	return {
		config,
		locations,
	};
}

function buildStorageFile(
	config: AppConfig,
	locations: LocationRecord[],
): AppStorage {
	return storageFileSchema.parse({
		...config,
		locations,
		updatedAt: new Date().toISOString(),
	});
}

async function syncEnvWithConfig(
	storagePath: string,
	rootDir: string,
): Promise<void> {
	await writeConfigPathEnv(storagePath, rootDir);
	process.env.CONFIG_PATH = storagePath;
}

function getFallbackStoragePath(rootDir: string): string {
	return path.join(rootDir, "storage", STORAGE_FILE_NAME);
}

async function migrateSplitStorageLayout(
	candidatePath: string,
	rootDir: string,
	rawCandidate: unknown,
): Promise<AppStorage | null> {
	if (
		path.basename(candidatePath) === STORAGE_FILE_NAME &&
		rawCandidate !== null
	) {
		return null;
	}

	const storageDir = path.dirname(candidatePath);
	const legacyConfigPath =
		path.basename(candidatePath) === LEGACY_CONFIG_FILE_NAME
			? candidatePath
			: path.join(storageDir, LEGACY_CONFIG_FILE_NAME);
	const legacyLocationsPath = path.join(
		storageDir,
		LEGACY_LOCATIONS_FILE_NAME,
	);
	const nextStoragePath = path.join(storageDir, STORAGE_FILE_NAME);

	const rawLegacyConfig =
		legacyConfigPath === candidatePath
			? rawCandidate
			: await readJsonFile(legacyConfigPath);
	if (rawLegacyConfig === null) {
		return null;
	}

	const parsedConfig = legacySplitConfigSchema.safeParse(rawLegacyConfig);
	if (!parsedConfig.success) {
		return null;
	}

	const rawLocations = await readJsonFile(legacyLocationsPath);
	const parsedLocations = locationsSchema.safeParse(rawLocations ?? []);
	if (!parsedLocations.success) {
		throw new Error(
			`Legacy locations file does not match the expected schema: ${legacyLocationsPath} (${formatSchemaError(parsedLocations.error)})`,
		);
	}

	const repositoryInfo = detectRepositoryInfo(rootDir);
	const migratedStorage = storageFileSchema.parse({
		version: APP_STORAGE_VERSION,
		storagePath: nextStoragePath,
		storageDir,
		storageIndent: parsedConfig.data.storageIndent,
		locations: parsedLocations.data,
		openers: parsedConfig.data.openers,
		defaultOpenerId: parsedConfig.data.defaultOpenerId,
		update: {
			repositoryUrl:
				parsedConfig.data.update.repositoryUrl.trim() ||
				DEFAULT_UPDATE_REPOSITORY,
			branch: parsedConfig.data.update.branch.trim() || "main",
			check: updateCheckSchema.parse({
				lastCheckedAt: "",
				latestVersion: "",
				latestRevision: "",
				installedRevision: repositoryInfo.revision,
			}),
		},
		createdAt: parsedConfig.data.createdAt,
		updatedAt: new Date().toISOString(),
	});

	await writeJsonFile(
		migratedStorage.storagePath,
		migratedStorage,
		migratedStorage.storageIndent,
	);
	if (legacyConfigPath !== migratedStorage.storagePath) {
		await fs.rm(legacyConfigPath, { force: true });
	}
	await fs.rm(legacyLocationsPath, { force: true });
	await syncEnvWithConfig(migratedStorage.storagePath, rootDir);

	return migratedStorage;
}

async function loadStorageFile(options?: {
	allowFallbackToCwd?: boolean;
	rootDir?: string;
}): Promise<{ rootDir: string; storage: AppStorage } | null> {
	const rootDir = options?.rootDir ?? getProjectRoot();
	const configuredPath = getConfiguredPathFromEnv(rootDir);
	const fallbackPath = getFallbackStoragePath(rootDir);
	const candidatePaths = [configuredPath];

	if (options?.allowFallbackToCwd && fallbackPath !== configuredPath) {
		candidatePaths.push(fallbackPath);
	}

	for (const storagePath of candidatePaths) {
		if (!storagePath) {
			continue;
		}

		const raw = await readJsonFile(storagePath);
		if (raw === null) {
			const migrated = await migrateSplitStorageLayout(
				storagePath,
				rootDir,
				raw,
			);
			if (migrated) {
				return {
					rootDir,
					storage: migrated,
				};
			}

			continue;
		}

		const parsed = storageFileSchema.safeParse(raw);
		if (parsed.success) {
			await syncEnvWithConfig(parsed.data.storagePath, rootDir);
			return {
				rootDir,
				storage: parsed.data,
			};
		}

		const migrated = await migrateSplitStorageLayout(
			storagePath,
			rootDir,
			raw,
		);
		if (migrated) {
			return {
				rootDir,
				storage: migrated,
			};
		}

		throw new Error(
			`Storage file does not match the expected schema: ${storagePath} (${formatSchemaError(parsed.error)})`,
		);
	}

	return null;
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
	const record = openerSchema.parse({
		id: getNextId(openers),
		...values,
	});

	if (
		openers.some(
			(item) => item.key.toLowerCase() === record.key.toLowerCase(),
		)
	) {
		throw new Error(`Opener key already exists: ${record.key}`);
	}

	return record;
}

export async function writeConfigPathEnv(
	storagePath: string,
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
	nextLines.push(`CONFIG_PATH=${storagePath}`);
	await fs.writeFile(envPath, nextLines.join("\n") + "\n", "utf8");
}

export async function saveState(state: LoadedState): Promise<LoadedState> {
	const storage = buildStorageFile(state.config, state.locations);
	await writeJsonFile(storage.storagePath, storage, storage.storageIndent);
	await syncEnvWithConfig(storage.storagePath, state.rootDir);

	return {
		rootDir: state.rootDir,
		...splitStorage(storage),
	};
}

export async function loadState(options?: {
	allowFallbackToCwd?: boolean;
	rootDir?: string;
}): Promise<LoadedState | null> {
	const loaded = await loadStorageFile(options);
	if (!loaded) {
		return null;
	}

	return {
		rootDir: loaded.rootDir,
		...splitStorage(loaded.storage),
	};
}

export async function initializeRuntime(
	options: SetupOptions,
	rootDir = getProjectRoot(),
): Promise<LoadedState> {
	const storageDir = normalizeUserPath(options.storageDir);
	const storagePath = path.join(storageDir, STORAGE_FILE_NAME);
	const repositoryInfo = detectRepositoryInfo(rootDir);
	const now = new Date().toISOString();

	const config = configSchema.parse({
		version: APP_STORAGE_VERSION,
		storagePath,
		storageDir,
		storageIndent: options.storageIndent,
		openers: options.openers,
		defaultOpenerId: options.defaultOpenerId,
		update: {
			repositoryUrl:
				options.repositoryUrl.trim() || DEFAULT_UPDATE_REPOSITORY,
			branch: options.branch.trim() || "main",
			check: updateCheckSchema.parse({
				lastCheckedAt: "",
				latestVersion: "",
				latestRevision: "",
				installedRevision: repositoryInfo.revision,
			}),
		},
		createdAt: now,
		updatedAt: now,
	});

	const initialLocations = options.initialLocation
		? [createLocationRecord(options.initialLocation, [])]
		: [];

	await ensureDirectory(storageDir);
	return saveState({
		rootDir,
		config,
		locations: initialLocations,
	});
}

export async function moveStorageDirectory(
	state: LoadedState,
	nextStorageDir: string,
): Promise<LoadedState> {
	const normalizedDir = normalizeUserPath(nextStorageDir);
	if (normalizedDir === state.config.storageDir) {
		return state;
	}

	const previousStoragePath = state.config.storagePath;
	const nextState = await saveState({
		...state,
		config: configSchema.parse({
			...state.config,
			storagePath: path.join(normalizedDir, STORAGE_FILE_NAME),
			storageDir: normalizedDir,
			updatedAt: new Date().toISOString(),
		}),
	});

	if (previousStoragePath !== nextState.config.storagePath) {
		await fs.rm(previousStoragePath, { force: true });
	}

	return nextState;
}

export function detectRepositoryInfo(rootDir = getProjectRoot()): {
	repositoryUrl: string;
	branch: string;
	revision: string;
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
	const revisionResult = spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: rootDir,
		encoding: "utf8",
	});

	return {
		repositoryUrl:
			repositoryUrlResult.status === 0
				? repositoryUrlResult.stdout.trim()
				: "",
		branch:
			branchResult.status === 0 && branchResult.stdout.trim() !== "HEAD"
				? branchResult.stdout.trim()
				: "main",
		revision:
			revisionResult.status === 0 ? revisionResult.stdout.trim() : "",
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
