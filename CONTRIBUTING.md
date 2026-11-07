# Contributing

Install the root dependencies with `npm ci` using Node.js 24. The root application uses Bun through the package scripts. The `arc/` CLI and `arc-ui/` demo each have an independent lockfile.

Run `npm run verify` before sending a change. This runs type checking, lint, the build, and the deterministic suite. Add a focused test when changing execution behavior. Use temporary workspaces and fixture planners for automated tests. Keep live provider calls opt-in and describe any local service prerequisites in the change.

Review the exact paths in your staged diff. Keep environment files, model weights, local databases, execution reports, and private logs out of Git. Include the verification commands and any remaining limitations in your pull request description. See the [testing guide](docs/TESTING.md) and [license](LICENSE).
