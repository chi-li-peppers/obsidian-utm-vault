# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.2] - 2026-11-24

### Fixed

- Duplicate URL detection now also checks notes in the configured UTM notes folder (`utm_url` frontmatter) when using one-note-per-link mode for Bases.
- Wrapped clipboard copy actions in error handling so clipboard permission issues show a clean notice.
- Debounced text inputs in settings and ensured pending saves flush on unload.

## [1.0.1] - 2026-11-24

### Changed

- Removed redundant "Obsidian" from `manifest.json` description for directory review guidelines.

## [1.0.0] - 2026-11-24

### Added

- Interactive UTM builder modal with editable channel presets, live URL preview and validation
- Automatic normalisation (lowercase, separator, query-param and hash preservation) and duplicate link detection
- Markdown registry table (`UTM Registry.md`) and optional one-note-per-link mode with `.base` generator for Obsidian Bases
- Clipboard UTM URL parser and active-note UTM link auditor
- Desktop and mobile support

[1.0.2]: https://github.com/chi-li-peppers/obsidian-utm-vault/releases/tag/1.0.2
[1.0.1]: https://github.com/chi-li-peppers/obsidian-utm-vault/releases/tag/1.0.1
[1.0.0]: https://github.com/chi-li-peppers/obsidian-utm-vault/releases/tag/1.0.0
