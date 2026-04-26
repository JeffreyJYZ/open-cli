# open

Cross-platform folder launcher for developers.

`open` stores a small JSON config and a saved folder list, then gives you a fast interactive launcher for opening active projects in Finder, Explorer, VS Code, Zed, Cursor, or any custom command you add.

## Highlights

- Cross-platform opener commands.
- Interactive setup with arrow-key prompts.
- Config stored as strict JSON validated by Zod.
- `CONFIG_PATH` written to `.env` as an absolute path.
- Safe confirmations for destructive actions.
- `doctor` command for config, opener, and saved-path validation.
- `update` command that preserves config and storage while refreshing the CLI from a repository.

## Requirements

- Node.js 18+
- `pnpm`
- At least one opener command installed on your machine, for example `code`, `zed`, `cursor`, `explorer`, `xdg-open`, or macOS `/usr/bin/open`

## Install From A Fresh Clone

```bash
pnpm install
pnpm build
pnpm link
```

That links the CLI as `o` on your machine.

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

1. The directory that should contain `config.json` and `locs.json`.
2. The openers you want enabled.
3. The default opener.
4. An optional first saved folder.
5. The repository URL and branch used later by `o update`.

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

Open the full management dashboard:

```bash
pnpm manage
```

## Command Reference

```text
o                        Interactive picker
o setup                  First-time setup
o add <ref> <path>       Add a saved folder
o open [ref]             Open a saved folder
o rm <id|ref>            Remove a saved folder
o rename <id|ref> <ref>  Rename a saved reference
o clr                    Clear all saved folders
o ls                     List saved folders
o config                 Manage openers, storage, and update settings
o doctor                 Validate config, openers, and saved paths
o update                 Refresh the CLI from its configured repository
o help                   Show help
```

## Config Storage

Runtime state is split into two JSON files:

- `config.json`: config path, storage path, opener definitions, update source, formatting options
- `locs.json`: saved folder references and paths

The schemas are defined with strict Zod objects in [src/types.ts](src/types.ts).

## Config Command

`o config` opens an interactive config menu where you can:

- change the default opener
- add custom openers
- remove openers
- move the storage directory
- change JSON indentation
- change the repository URL and branch used by `o update`

Moving storage requires confirmation and rewrites `CONFIG_PATH` in `.env`.

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

## Notes

- Openers use command templates with `{path}` and optional `{ref}` placeholders.
- Existing legacy `storage/config.json` and `storage/locs.json` files are migrated automatically the first time the new CLI reads them.
- The CLI only stores absolute folder paths.
