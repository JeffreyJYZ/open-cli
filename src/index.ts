#!/usr/bin/env node

import main from "./main";
import { printError } from "./ui";

main(process.argv.slice(2)).catch((error) => {
	printError(error);
	process.exit(1);
});
