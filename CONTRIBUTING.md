# Contributing

Thanks for helping. This is a small project, so the process is short.

## Set up

You need Node 24 and pnpm 10.

```sh
cp .env.example .env
pnpm install
pnpm dev
```

## Before you open a pull request

These three checks must pass:

```sh
pnpm lint
pnpm typecheck
pnpm test
```

A pull request needs:

- tests for any new behaviour;
- updated documentation when a feature or rule changes;
- a description of what changed and why;
- a reason for any new dependency. Dependencies are kept few.

For anything bigger than a small fix, open an issue first so we can agree on the approach before you write the code.

## Layout, conventions and security rules

`AGENTS.md` is the single place for these. It is written for people and for coding agents alike. Please read it before you change code.

## Releasing (maintainers)

1. Set `version` in `package.json` in a pull request and merge it. Wait until the `Build & push image` workflow has pushed the image of that commit.
2. Tag that commit and push the tag: `git tag v0.3.1 && git push origin v0.3.1`.

The `Release` workflow then gives that image the tag `0.3.1` and creates the GitHub release with generated notes. It fails when the tag and `package.json` disagree, or when the commit has no image.

## License

By contributing, you agree that your contribution is licensed under the project's MIT license (see `LICENSE`).

## Security problems

Do not open an issue for a security problem. Follow `SECURITY.md` instead.
