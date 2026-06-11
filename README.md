# OpenPen-plugins

The central plugin catalog for [OpenPen](https://github.com/openpen-platform/openpen). The OpenPen app and `openpen-cli` fetch `plugins.json` from this repository to browse and install plugins.

## Structure

- `plugins/<scope>/<name>/manifest.json` — one manifest per registered plugin
- `plugins.json` — aggregated index consumed by the app and CLI

## Registering a plugin

Run `npx openpen publish` from your plugin repository. See the [plugin authoring guide](https://github.com/openpen-platform/openpen/tree/main/docs) for details.
