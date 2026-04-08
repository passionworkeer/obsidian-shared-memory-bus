# Development

## Pre-commit Checks

Before committing, run:

```bash
cd shared-mcp
npm run lint
```

To auto-fix issues:

```bash
cd shared-mcp
npm run lint:fix
```

## CI Linting

The `lint.yml` workflow runs ESLint on all JavaScript/Node.js files and shell syntax checks (`sh -n`) on `.sh` files on every push to main and PR.
