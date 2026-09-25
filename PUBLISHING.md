# Publishing @frontendxlab/opencode-computer-use

First publish checklist for the maintainer. No auto-publish on push.

## 0. One-time setup (local machine only)

```bash
npm login
npm whoami
npm access list packages @frontendxlab --json
```

The package uses the existing `@frontendxlab` npm scope, which is already
available to the publishing account. The unscoped `opencode-computer-use`
name is not used because it is already registered by another publisher.

## 1. Pre-flight (from package root)

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('json ok')"
npm run lint
npm test
npm pack --dry-run
```

`prepublishOnly` runs `lint` plus `test` automatically on `npm publish`.
Both pass headless (37 tests, no desktop session needed).

## 2. Version

```bash
npm version patch   # or minor / major
```

This updates `package.json` and `package-lock.json` together.
Do not hand-edit the version.

## 3. Publish

```bash
npm publish --access public --dry-run
npm publish --access public
```

Use an npm OTP only when the account requires it. Never put the OTP in a
repository file or command committed to git.

## 4. Verify

- `npm view @frontendxlab/opencode-computer-use versions --json` lists the new version.
- In a clean directory: `npm install @frontendxlab/opencode-computer-use` and
  `npx opencode-computer-use-repl --help` or an equivalent smoke check.

## What is included

`files` allowlist: `bin/`, `lib/`, `docs/`, `index.js`, `README.md`,
`SECURITY.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`.
Excluded by npm defaults plus `.gitignore`: `node_modules/`, `test/`,
`test-fixtures/`, `.git/`, `.env*`, `*.tgz`, coverage output.
The current dry-run tarball is small because the native runtime remains an
optional dependency and is not bundled into this package.

## Notes

- `open-computer-use` is an `optionalDependency`, so installs on
  platforms without its native binaries still succeed.
- The `postinstall` setup is best-effort. It never fails the package install;
  ambiguous detection prints manual V1/V2 instructions and leaves config alone.
  pnpm 10 and newer may require `pnpm approve-builds @frontendxlab/opencode-computer-use` before lifecycle scripts are allowed.
- `engines` requires Node >= 18 and supports the OpenCode2 beta line.
- Docs site (Cloudflare Pages, https://opencode-computer-use.pages.dev/)
  deploys separately and is not part of the release flow.
- Never commit or publish `.env` files or credentials.
