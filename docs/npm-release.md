# npm release (npx amem setup)

The published package is how people install amem without cloning this repo:

```bash
npx amem setup
# or
npm i -g amem && amem setup
```

`better-sqlite3` ships its own prebuilds. Users need **Node.js 20+**. If a prebuild is missing for their platform, npm falls back to compiling (needs a C++ toolchain).

## What CI does

- `.github/workflows/ci.yml` — `npm test` + `npm run pack:check` on Node 20 and 22 (macOS + Ubuntu).
- `.github/workflows/release.yml` — on a `v*` tag, publish to npm if `NPM_TOKEN` is set.

This repo does **not** auto-publish on every push.

## Release checklist

1. `npm test` and `npm run pack:check` are green locally.
2. Bump `version` in `package.json`.
3. Commit, tag, push:

   ```bash
   git tag v0.1.0
   git push origin main --tags
   ```

4. Add an `NPM_TOKEN` repo secret (Automation token) before the first tagged release.
5. Confirm `npx amem setup` from a folder that is not this checkout.

## Pack contents

`package.json#files` includes `dist`, `ui-static`, `docs`, `skills`, and `scripts/mdm-offboard.sh`. Native code is pulled in as the `better-sqlite3` dependency — do not vendor it.
