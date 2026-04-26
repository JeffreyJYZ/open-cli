//@ts-check

import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import globals from "globals";

const tsconfigRootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(
	{
		ignores: ["dist/**", "storage/**", "scripts/**"],
	},
	{
		files: ["**/*.{js,mjs,cjs}"],
		...js.configs.recommended,
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
		rules: {
			...js.configs.recommended.rules,
			"no-unused-vars": "off",
			"no-empty": "off",
		},
	},
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				projectService: true,
				tsconfigRootDir,
			},
			globals: {
				...globals.node,
			},
		},
	},
	...tseslint.configs.recommendedTypeChecked.map((config) => ({
		...config,
		files: ["src/**/*.ts"],
	})),
	{
		files: ["src/**/*.ts"],
		rules: {
			"@typescript-eslint/no-deprecated": "error",
			"@typescript-eslint/no-unused-vars": "off",
			"no-unused-vars": "off",
			"no-empty": "off",
		},
	},
);
