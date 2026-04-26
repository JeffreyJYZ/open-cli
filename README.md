# open-cli

Cross-platform folder launcher for developers.

`open-cli` stores its runtime state in a single `storage.json` file, then gives you a fast interactive launcher for opening active projects in Finder, Explorer, VS Code, Zed, Cursor, or any custom command you add.

## Highlights

- Cross-platform opener commands.
- Interactive setup with arrow-key prompts.
- Config stored as strict JSON validated by Zod.
- One `storage.json` file for settings and saved locations.
- `CONFIG_PATH` written to `.env` as an absolute path.
- Safe confirmations for destructive actions.
- `doctor` command for config, opener, and saved-path validation.
- `update` command that preserves config and storage while refreshing the CLI from a repository.
- Automatic update checks that notify you when a newer `open-cli` version or revision is available.

## Requirements

- Node.js 18+
- `pnpm`
- At least one opener command installed on your machine, for example `code`, `zed`, `cursor`, `explorer`, `xdg-open`, or macOS `/usr/bin/open`

## Install From A Fresh Clone

```bash
pnpm install
pnpm build
pnpm link
o setup
```

That installs the dependencies, builds the single-file CLI outputs, links `o`
globally, and finishes first-time setup.

If you do not want to link it globally yet, you can still run it locally with:

```bash
node dist/index.min.js setup
```

## First-Time Setup

Run:

```bash
o setup
```

Setup will ask for:

1. The directory that should contain `storage.json`.
2. The openers you want enabled.
3. The default opener.
4. An optional first saved folder.
5. The repository URL or GitHub `owner/repo` and branch used later by `o update`.

Default storage is:

```text
<current-working-directory>/storage
```

After setup, `.env` will contain an absolute `CONFIG_PATH` value.

## Daily Use

Run without arguments to open the interactive picker:

```bash
o
```

Open a saved folder by reference:

```bash
o my-project
```

Open a saved folder with a specific opener:

```bash
o open my-project --with vscode
```

Print the installed CLI version:

```bash
o --version
```

## Command Reference

```text
o                        Interactive picker
o -v | --version         Show the installed CLI version
o setup                  First-time setup
o add <ref> <path>       Add a saved folder
o open [ref]             Open a saved folder
o rm <id|ref>            Remove a saved folder
o rename <id|ref> <ref>  Rename a saved reference
o clr                    Clear all saved folders
o ls                     List saved folders
o config                 Open the interactive config menu
o config show            Show the current config and openers
o config set ...         Change config directly from the command line
o doctor                 Validate config, openers, and saved paths
o update                 Refresh the CLI from its configured repository
o help                   Show help
```

## Config Storage

Runtime state lives in one JSON file:

- `storage.json`: saved folder references, opener definitions, update source, update-check metadata, formatting options, and file location metadata

The schemas are defined with strict Zod objects in [src/types.ts](src/types.ts).

## Config Command

`o config` still opens the interactive config menu where you can:

- change the default opener
- add custom openers
- remove openers
- move the storage directory
- change JSON indentation
- change the repository URL and branch used by `o update`

You can also change config directly with commands such as:

```bash
o config show
o config set default-opener vscode
o config set indent 2
o config set update-repo JeffreyJYZ/open-cli
o config set update-branch main
o config set update-source JeffreyJYZ/open-cli main
```

Moving storage requires confirmation and rewrites `CONFIG_PATH` in `.env`.

When a newer version or repository revision is detected, `open-cli` prints a reminder to run `o update`.

## Doctor

`o doctor` checks:

- whether `CONFIG_PATH` points at the active config
- whether the storage directory exists
- whether saved folders still exist
- whether opener commands are available in `PATH`

If saved folders are missing on disk, the doctor can remove them from storage interactively.

## Update Flow

`o update` is designed to keep your saved config and folders while refreshing the CLI code:

1. Clone the configured repository and branch into a temporary directory.
2. Copy the new repo contents into the current installation.
3. Preserve `storage`, `.env`, and `.env.local`.
4. Run `pnpm install` and `pnpm build`.
5. Re-apply `CONFIG_PATH` into `.env`.

Set the repository URL during setup or later with `o config`.

GitHub shorthand like `JeffreyJYZ/open-cli` is accepted and cloned as the
matching GitHub repository automatically.

## Notes

- Openers use command templates with `{path}` and optional `{ref}` placeholders.
- The CLI only stores absolute folder paths.
- If you do not wish to add a global command, you can run `node . <command>`
