# JSON Schema References

Navigate between local JSON Schema `$ref` values with hover previews and go-to-definition support.

## Features

- Hover a `$ref` string in JSON or JSONC files to preview the referenced schema snippet.
- `F12` / `Cmd+Click` on a `$ref` to jump to the referenced schema location, including nested JSON Pointer targets.
- Supports relative, absolute, and `file://` paths that resolve to local schema files.

![Product Collection](https://github.com/nicolasburford/json-schema-references/blob/main/assets/product-collection.png?raw=true)

## Getting Started

1. Install dependencies and compile the extension:
   ```bash
   npm install
   npm run compile
   ```
2. Press `F5` in VS Code to launch a new Extension Development Host for testing.

## Notes

- Only local file references are resolved. Remote URIs (e.g. `http://`) are ignored.
- Pointer resolution follows the JSON Pointer specification, including `~0`/`~1` escape handling.
- Hover previews truncate after a few hundred characters to keep tooltips compact.
