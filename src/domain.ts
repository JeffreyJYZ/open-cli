import path from "node:path";
import { z } from "zod";

export const APP_STORAGE_VERSION = 3;
export const STORAGE_FILE_NAME = "storage.json";
export const DEFAULT_UPDATE_REPOSITORY = "JeffreyJYZ/open-cli";

const RESERVED_COMMANDS = new Set([
	"add",
	"browse",
	"clr",
	"config",
	"doctor",
	"help",
	"list",
	"ls",
	"open",
	"rename",
	"rm",
	"setup",
	"update",
]);

const uniqueIssue = (
	ctx: z.RefinementCtx,
	message: string,
	path: Array<string | number>,
) => {
	ctx.addIssue({
		code: "custom",
		message,
		path,
	});
};

export const refSchema = z
	.string()
	.trim()
	.min(2, "Reference must be at least 2 characters")
	.max(40, "Reference must be at most 40 characters")
	.regex(
		/^[A-Za-z][A-Za-z0-9-]*$/u,
		"Reference must start with a letter and only use letters, numbers, and dashes",
	)
	.refine(
		(value) => !RESERVED_COMMANDS.has(value.toLowerCase()),
		"Reference cannot be a command name",
	);

export const absolutePathSchema = z
	.string()
	.trim()
	.min(1, "Path is required")
	.refine((value) => path.isAbsolute(value), "Path must be absolute");

export const openerSchema = z
	.object({
		id: z.number().int().positive(),
		key: z
			.string()
			.trim()
			.min(2)
			.max(24)
			.regex(/^[a-z][a-z0-9-]*$/u, "Opener key must be kebab-case"),
		label: z.string().trim().min(2).max(40),
		command: z.string().trim().min(3).max(260),
		description: z.string().trim().max(120).default(""),
	})
	.strict();

export type OpenerConfig = z.infer<typeof openerSchema>;

export const locationSchema = z
	.object({
		id: z.number().int().positive(),
		ref: refSchema,
		path: absolutePathSchema,
		note: z.string().trim().max(120).default(""),
	})
	.strict();

export type LocationRecord = z.infer<typeof locationSchema>;

export const locationsSchema = z
	.array(locationSchema)
	.superRefine((items, ctx) => {
		const refs = new Set<string>();
		const ids = new Set<number>();

		items.forEach((item, index) => {
			const lowerRef = item.ref.toLowerCase();
			if (refs.has(lowerRef)) {
				uniqueIssue(ctx, `Duplicate reference: ${item.ref}`, [
					index,
					"ref",
				]);
			} else {
				refs.add(lowerRef);
			}

			if (ids.has(item.id)) {
				uniqueIssue(ctx, `Duplicate location id: ${item.id}`, [
					index,
					"id",
				]);
			} else {
				ids.add(item.id);
			}
		});
	});

export const updateCheckSchema = z
	.object({
		lastCheckedAt: z.string().trim().max(80).default(""),
		latestVersion: z.string().trim().max(40).default(""),
		latestRevision: z.string().trim().max(80).default(""),
		installedRevision: z.string().trim().max(80).default(""),
	})
	.strict();

export type UpdateCheckState = z.infer<typeof updateCheckSchema>;

const updateSchema = z
	.object({
		repositoryUrl: z.string().trim().max(300).default(""),
		branch: z.string().trim().min(1).max(80).default("main"),
		check: updateCheckSchema.default({
			lastCheckedAt: "",
			latestVersion: "",
			latestRevision: "",
			installedRevision: "",
		}),
	})
	.strict();

function validateOpeners(
	config: {
		openers: OpenerConfig[];
		defaultOpenerId: number;
	},
	ctx: z.RefinementCtx,
) {
	const openerIds = new Set<number>();
	const openerKeys = new Set<string>();

	config.openers.forEach((opener, index) => {
		const lowerKey = opener.key.toLowerCase();
		if (openerIds.has(opener.id)) {
			uniqueIssue(ctx, `Duplicate opener id: ${opener.id}`, [
				"openers",
				index,
				"id",
			]);
		} else {
			openerIds.add(opener.id);
		}

		if (openerKeys.has(lowerKey)) {
			uniqueIssue(ctx, `Duplicate opener key: ${opener.key}`, [
				"openers",
				index,
				"key",
			]);
		} else {
			openerKeys.add(lowerKey);
		}
	});

	if (
		!config.openers.some((opener) => opener.id === config.defaultOpenerId)
	) {
		ctx.addIssue({
			code: "custom",
			message: "Default opener id does not exist in openers",
			path: ["defaultOpenerId"],
		});
	}
}

export const configSchema = z
	.object({
		version: z.literal(APP_STORAGE_VERSION),
		storagePath: absolutePathSchema,
		storageDir: absolutePathSchema,
		storageIndent: z.number().int().min(2).max(8).default(4),
		openers: z
			.array(openerSchema)
			.min(1, "At least one opener is required"),
		defaultOpenerId: z.number().int().positive(),
		update: updateSchema,
		createdAt: z.string().trim().min(1),
		updatedAt: z.string().trim().min(1),
	})
	.strict()
	.superRefine(validateOpeners);

export type AppConfig = z.infer<typeof configSchema>;

export const storageFileSchema = z
	.object({
		version: z.literal(APP_STORAGE_VERSION),
		storagePath: absolutePathSchema,
		storageDir: absolutePathSchema,
		storageIndent: z.number().int().min(2).max(8).default(4),
		locations: locationsSchema,
		openers: z
			.array(openerSchema)
			.min(1, "At least one opener is required"),
		defaultOpenerId: z.number().int().positive(),
		update: updateSchema,
		createdAt: z.string().trim().min(1),
		updatedAt: z.string().trim().min(1),
	})
	.strict()
	.superRefine(validateOpeners);

export type AppStorage = z.infer<typeof storageFileSchema>;

export interface OpenerPreset {
	key: string;
	label: string;
	command: string;
	description: string;
}

export function getPlatformLabel(platform = process.platform): string {
	if (platform === "darwin") {
		return "macOS";
	}
	if (platform === "win32") {
		return "Windows";
	}
	return "Linux";
}

export function getPlatformOpenerPresets(
	platform = process.platform,
): OpenerPreset[] {
	const systemPreset: OpenerPreset =
		platform === "darwin"
			? {
					key: "finder",
					label: "Finder",
					command: "/usr/bin/open {path}",
					description: "Open folders in Finder.",
				}
			: platform === "win32"
				? {
						key: "explorer",
						label: "File Explorer",
						command: "explorer {path}",
						description: "Open folders in File Explorer.",
					}
				: {
						key: "system",
						label: "System File Manager",
						command: "xdg-open {path}",
						description:
							"Open folders with the default file manager.",
					};

	return [
		systemPreset,
		{
			key: "vscode",
			label: "VS Code",
			command: "code -n {path}",
			description: "Open folders in Visual Studio Code.",
		},
		{
			key: "cursor",
			label: "Cursor",
			command: "cursor {path}",
			description: "Open folders in Cursor.",
		},
		{
			key: "zed",
			label: "Zed",
			command: "zed {path}",
			description: "Open folders in Zed.",
		},
	];
}
