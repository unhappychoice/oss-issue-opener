# Contributing

## Development setup

Requires Node.js >= 20.

```bash
npm install
```

## Running checks

```bash
npm run build   # compile TypeScript (tsc)
npm test        # build, then run the test suite (node --test)
```

To run the scanner itself against real repositories:

```bash
GH_TOKEN=your_token npm run start
```

`npm run check` builds and runs the scanner in one step; it is what the weekly workflow runs in CI
after `npm test`.

## Opening a pull request

1. Fork the repository and create a branch for your change.
2. Make your change, keeping it focused and adding or updating tests under `test/` for any
   behavior change.
3. Run `npm test` and make sure it passes.
4. Open a pull request against `main`. The `Test` workflow (`.github/workflows/test.yml`) runs
   `npm test` on every pull request and must pass before merging.
