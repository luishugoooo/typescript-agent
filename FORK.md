# on-wert Inside SDK fork

The `codex/fix-stream-failure-lifecycle` branch is based on upstream `@openrouter/agent@0.11.0` (`f3dbc6289d7d699a4d5ee97ebfbddeefa059c017`), not the moving upstream main branch.

Changes:

- Deliver background tool-loop failures through the turn broadcaster; a consumer that throws, stops early or is cancelled must not leave a detached rejected promise.
- Keep the broadcaster's first terminal outcome so subsequent completion cannot erase the original error for concurrent or late consumers.
- Test all five public turn-stream APIs with disconnects and run-signal cancellation, before/after a tool, plus early return and replay.

The application consumes a precompiled package from a separate `codex/package-agent-<version>` branch, pinned to its full Git commit SHA. The source is a monorepo, so its root cannot be installed directly as the agent package. A versioned GitHub prerelease also carries the package tarball and its SHA-256 checksum. Bun does not record integrity for remote tarball dependencies, so the application uses the immutable package commit rather than the release asset URL. Nothing is published under OpenRouter's npm scope. Keep upstream package metadata, dependencies and exports unchanged except for the fork version and repository URL.

To cut a new fork build, bump `packages/agent/package.json`, run the version generator, typecheck, compile and run the unit suite. Use Bun for installation and compilation; the upstream Vitest suite currently requires Node because Bun's Vitest module mocking produces invalid Zod imports.

```sh
bun install --ignore-scripts
bun packages/agent/scripts/gen-version.mjs
bun run --bun tsc --noEmit -p packages/agent/tsconfig.typecheck.json
bun run --bun tsc -p packages/agent/tsconfig.json
cd packages/agent
node ../../node_modules/vitest/vitest.mjs run --project unit --coverage.enabled=false
bun pm pack --ignore-scripts --destination <release-directory>
```

Commit the version and generated source, push the branch, then create a tag/prerelease at that exact commit with the tarball and its SHA-256 checksum. Extract that exact tarball into a separate, empty package checkout, add a `SOURCE_COMMIT` file identifying the source tag/commit, and push it on a new package branch. Update the application's `github:luishugoooo/typescript-agent#<full-package-commit>` dependency and lockfile together and run its SDK compatibility tests, check and lint. Do not replace existing release assets or force-push package commits. Return to an upstream release only after the same failure regressions pass without a local patch.
