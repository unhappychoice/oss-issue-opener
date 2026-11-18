# Contributing

## Development setup

Requires Node.js >= 26. Use the Node.js 26 LTS version specified in `.node-version`
to match the test and weekly workflows.

```bash
npm install
```

## Running checks

```bash
npm run build   # compile TypeScript (tsc)
npm test        # build, then run the test suite (node --test)
npm run test:coverage # build and test with coverage (requires Node.js >= 26)
```

The build enables TypeScript strict mode, exact optional property types, and checks
for missing return paths, switch fallthrough, unused locals, and unused parameters.
These checks also run in CI because the coverage command builds first.

The pull request and `main` branch CI job runs `npm run test:coverage` on Node.js 26.
Node's built-in coverage report appears in the job log and covers executed compiled
production modules under `dist/`, excluding tests and dependencies. The suite fails
below 97% line, 95% branch, or 99% function coverage across those modules. Run the
same command locally before changing these thresholds.

To run the scanner itself against real repositories:

```bash
GH_TOKEN=your_token npm run start
```

The [weekly workflow](.github/workflows/weekly.yml) runs `npm test` followed by
`npm run start`. For a local build and scan in one step, use `npm run check`.

## Opening a pull request

1. Fork the repository and create a branch for your change.
2. Make your change, keeping it focused and adding or updating tests under `test/` for any
   behavior change.
3. Run `npm test` and make sure it passes.
4. Open a pull request against `main`. The `Test` workflow (`.github/workflows/test.yml`) runs
   `npm run test:coverage` on every pull request and must pass before merging.
