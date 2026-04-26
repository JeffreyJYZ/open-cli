import { build, type BuildOptions } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";

const cmd = process.argv[2] ?? "all";

function fatalError(...messages: unknown[]): never {
	const text = messages
		.map((message) =>
			message instanceof Error ? message.message : String(message),
		)
		.join(" ");
	console.error(text);
	process.exit(1);
}

function failedFunc(e: unknown) {
	fatalError("Build failed: ", e instanceof Error ? e.message : e);
}

function successFunc(outfile: string) {
	console.log(`Built ${outfile}`);
}

const buildOptions: BuildOptions = {
	bundle: true,
	external: ["esbuild"],
	platform: "node",
	target: "esnext",
	format: "cjs",
	minify: true,
	legalComments: "none",
};

let builds: [string[], string][];

if (cmd === "all") {
	builds = [
		[["src/index.ts"], "dist/index.min.js"],
		[["src/manage.ts"], "dist/manage.js"],
		[["src/build.ts"], "dist/build.js"],
	];
} else {
	let entryPoints: string[], outfile: string;

	if (cmd) {
		entryPoints = ["src/" + cmd + ".ts"];
		outfile = "dist/" + cmd + ".js";
	} else {
		entryPoints = ["src/index.ts"];
		outfile = "dist/index.min.js";
	}

	builds = [[entryPoints, outfile]];
}

void main(builds).catch(failedFunc);

async function main(builds: [string[], string][]) {
	for (const [currentEntryPoints, currentOutfile] of builds) {
		try {
			await build({
				...buildOptions,
				entryPoints: currentEntryPoints,
				outfile: currentOutfile,
			});
			successFunc(currentOutfile);
		} catch (error) {
			failedFunc(error);
		}
	}

	await writeDistPackageJson();
	await removeLegacyCjsOutputs();
}

async function writeDistPackageJson() {
	await fs.mkdir("dist", { recursive: true });
	await fs.writeFile(
		path.join("dist", "package.json"),
		JSON.stringify({ type: "commonjs" }, null, 2) + "\n",
		"utf8",
	);
}

async function removeLegacyCjsOutputs() {
	const files = ["dist/index.min.cjs", "dist/manage.cjs", "dist/build.cjs"];
	await Promise.all(
		files.map((filePath) => fs.rm(filePath, { force: true })),
	);
}
