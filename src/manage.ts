#!/usr/bin/env node

import { runManageMode } from "./runtime";
import { printError } from "./ui";

runManageMode().catch((error) => {
	printError(error);
	process.exit(1);
});
