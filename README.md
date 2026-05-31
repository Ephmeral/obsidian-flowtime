# FlowTime Obsidian Plugin

MVP Obsidian plugin for syncing FlowTime data into a vault.

## MVP Scope

- Log in to a FlowTime server with email and password.
- Store the returned Bearer token in local plugin data.
- Pull `core.categories`, `core.tags`, and `core.time_entries` from `/api/v1/sync/records`.
- Render today's local time log to `FlowTime/Daily/YYYY/YYYY-MM-DD.md`.
- Keep sync read-only from FlowTime to Obsidian.

## Development

```bash
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` into an Obsidian vault plugin folder to test manually.

## Sync to a local vault

Set `FLOWTIME_OBSIDIAN_PLUGINS_DIR` to your vault's `.obsidian/plugins` directory, then run:

```bash
npm run sync:vault
```

The script builds the plugin and copies release artifacts into a subfolder named from `manifest.json` (`flowtime`). Keep any machine-specific path in your shell environment or an ignored local env file.

