const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const packageJson = JSON.parse(
	fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "open-cli-test-"));
const storageDir = path.join(tempRoot, "storage");
const storagePath = path.join(storageDir, "storage.json");

fs.mkdirSync(storageDir, { recursive: true });
fs.writeFileSync(
	storagePath,
	JSON.stringify(
		{
			version: 3,
			storagePath,
			storageDir,
			storageIndent: 4,
			locations: [
				{
					id: 1,
					ref: "smoke",
					path: repoRoot,
					note: "",
				},
			],
			openers: [
				{
					id: 1,
					key: "echo",
					label: "Echo",
					command: "echo {path}",
					description: "Smoke test opener.",
				},
			],
			defaultOpenerId: 1,
			update: {
				repositoryUrl: "JeffreyJYZ/open-cli",
				branch: "main",
				check: {
					lastCheckedAt: "",
					latestVersion: "",
					latestRevision: "",
					installedRevision: "",
				},
			},
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		},
		null,
		4,
	) + "\n",
	"utf8",
);

const env = {
	...process.env,
	CONFIG_PATH: storagePath,
};

const help = spawnSync(process.execPath, ["dist/index.min.js", "help"], {
	cwd: repoRoot,
	encoding: "utf8",
	env,
});
if (help.status !== 0) {
	throw new Error(help.stderr || help.stdout || "help command failed");
}

const list = spawnSync(process.execPath, ["dist/index.min.js", "ls"], {
	cwd: repoRoot,
	encoding: "utf8",
	env,
});
if (list.status !== 0 || !list.stdout.includes("smoke")) {
	throw new Error(list.stderr || list.stdout || "list command failed");
}

const version = spawnSync(process.execPath, ["dist/index.min.js", "-v"], {
	cwd: repoRoot,
	encoding: "utf8",
	env,
});
if (version.status !== 0 || version.stdout.trim() !== packageJson.version) {
	throw new Error(
		version.stderr || version.stdout || "version command failed",
	);
}

const configSet = spawnSync(
	process.execPath,
	["dist/index.min.js", "config", "set", "indent", "2"],
	{
		cwd: repoRoot,
		encoding: "utf8",
		env,
	},
);
if (configSet.status !== 0) {
	throw new Error(
		configSet.stderr || configSet.stdout || "config set command failed",
	);
}

const updatedStorage = JSON.parse(fs.readFileSync(storagePath, "utf8"));
if (updatedStorage.storageIndent !== 2) {
	throw new Error("config set indent did not update storage.json");
}

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log("Smoke tests passed.");
