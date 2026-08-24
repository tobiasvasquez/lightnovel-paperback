# Paperback 0.9 Sources

Production-ready `Paperback 0.9` extension repository with multiple sources in the same project.

Current sources:

- `LightNovelWorld`
- `SkyNovels`
- `NovelFull`

## Production Hosting

This repository is set up to deploy the built `bundles/` output to GitHub Pages through Actions.

After the first push:

1. Create a GitHub repository and push this project to its `main` branch.
2. In GitHub, open `Settings -> Pages`.
3. Set `Source` to `GitHub Actions`.
4. Wait for the `Deploy Pages` workflow to finish.
5. Open `https://<your-user>.github.io/<repo>/versioning.json` and confirm it loads.
6. In Paperback `0.9`, add `https://<your-user>.github.io/<repo>/` as a repository URL.

Paperback should then show the sources published by this repository.

## Local Commands

Install dependencies:

```bash
npm ci
```

Typecheck:

```bash
npm run tsc
```

Build bundles:

```bash
npm run build
```

Serve locally:

```bash
npm run serve
```

## Notes

- The toolchain expects Node `>=24`.
- The deploy workflow publishes the built `bundles/` directory as the Pages site root.
- The generated public repository endpoints will look like:
  - `/versioning.json`
  - `/LightNovelWorld/info.json`
  - `/LightNovelWorld/index.js`
  - `/SkyNovels/info.json`
  - `/SkyNovels/index.js`
  - `/NovelFull/info.json`
  - `/NovelFull/index.js`
