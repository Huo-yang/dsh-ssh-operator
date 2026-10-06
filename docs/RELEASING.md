# Releasing

1. Update `package.json` and `CHANGELOG.md`.
2. Run `pnpm install --frozen-lockfile` and `pnpm run check`.
3. Run `pnpm run release:prepare -- vX.Y.Z`.
4. Verify the archive hash in `dist/SHA256SUMS.txt` and the matching `release-manifest.json`.
5. Tag exactly `vX.Y.Z` and publish the generated archive and both checksum files.

The release archive contains built runtime files, bundle metadata, instructions, and documentation. It excludes maintained source, tests, scripts, local state, and dependencies.
