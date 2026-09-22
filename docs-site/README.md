# Website

This website is built using [Docusaurus](https://docusaurus.io/), a modern static website generator.

For authenticated screenshot generation, see [capture configuration and credential handling](scripts/CAPTURE.md).

## Installation

```bash
npm ci
```

## Local Development

```bash
npm start
```

This command starts a local development server and opens up a browser window. Most changes are reflected live without having to restart the server.

## Build

```bash
npm run build
```

This command generates static content into the `build` directory and can be served using any static contents hosting service.

## Dependency validation

Use Node.js 20 or later and npm so `package-lock.json` and the security overrides
in `package.json` are applied. The presentation check uses the Linux tools available
in CI: Bash, GNU coreutils/grep/sed, unzip and Python 3. For dependency updates, run:

```bash
npm ci
npm run typecheck
npm run build
bash scripts/verify-deck.sh static/presentation/awsops-intro/awsops-intro.pptx
```

The required **Merge Verify** check runs these commands when documentation or its
verification workflow changes. The presentation check rebuilds the deck and
compares every archive part with the committed artifact. Regenerate and commit
the deck if an intentional generator change alters its content.

The overrides retain patched `serialize-javascript` for the webpack plugins,
`image-size` for PptxGenJS, and a CommonJS-compatible patched `uuid` for SockJS.
Remove an override only after its parent accepts a patched release and the
commands above plus `npm audit` pass without a vulnerable nested copy.

Before publishing, also follow the [presentation verification instructions](static/presentation/awsops-intro/README.md)
to check the deck copied into `build/`.

## Deployment

Using SSH:

```bash
USE_SSH=true npm run deploy
```

Not using SSH:

```bash
GIT_USER=<Your GitHub username> npm run deploy
```

If you are using GitHub pages for hosting, this command is a convenient way to build the website and push to the `gh-pages` branch.
