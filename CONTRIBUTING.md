# Contributing

This file is for people developing in this repository. For using the package, see
[README.md](README.md).

The skill content under `plugins/sms-skills/skills/` and the commands under `plugins/sms-skills/commands/`
are written in Turkish for developers in Türkiye; keep them in Turkish. Repository-level documentation
(this file, the README, manifest descriptions) is in English.

## Requirements

- Node.js 22.6 or later (the tests run the TypeScript examples directly with
  `--experimental-strip-types`).
- Development dependencies via `npm install` (`yaml`, `ajv`, `esbuild`, `fflate`).

## Commands

```bash
npm install
npm test          # builds the specs and the mock bundle, runs all tests, runs the leak scan
npm run build     # regenerates the spec module and the mock bundle (scripts/netgsm-sms-mock.mjs)
npm run check     # leak scan ("Sızıntı yok") and content check ("İçerik temiz")
npm run zip       # builds dist/<skill>.zip for each skill (claude.ai upload)
npm run sync-specs -- <path to openapi.yaml> <path to api-docs.json>   # when the SMS or Identity spec changes
```

Tests and tools never call the live API. The SMS client (including the balance query) is tested against
the real mock; the İYS client is tested with a fake `fetch`.

## Repository layout

```text
.claude-plugin/marketplace.json          marketplace definition (netgsm-agent-skills)
plugins/sms-skills/
  .claude-plugin/plugin.json             plugin definition and version
  commands/                              /sms-mock, /sms-review (Claude Code)
  skills/
    netgsm-sms/                          SKILL.md, references/, scripts/netgsm-sms-mock.mjs (built)
    netgsm-iys/                          SKILL.md, references/ (including openapi.yaml)
packages/sms-mock/                       source and tests of the mock server
tools/                                   build, content check, leak scan, zip and their tests
docs/sources/                            public source texts that the skills summarise
```

## Rules

- **The built mock is committed.** `scripts/netgsm-sms-mock.mjs` is kept in the repository; after
  `npm run build`, `git status` must be clean.
- **Specs are the single source of truth.** The SMS (`netgsm-sms/references/openapi.yaml`), Identity
  (`identity-openapi.json`) and İYS (`netgsm-iys/references/openapi.yaml`) contracts are kept exactly as
  published in the official documentation. Use `npm run sync-specs` for SMS and Identity. The İYS spec
  is copied **verbatim** from the published file and never edited by hand.
- **Every skill cites the official source.** SKILL.md contains the api-docs and Knowledge Base links,
  and every reference file (except examples) contains at least one api-docs link. The content check
  enforces this.
- **Skills do not link to each other with relative links.** On claude.ai each skill is uploaded as a
  separate zip; refer to another skill by name (for example "`references/errors.md` of the `netgsm-sms`
  skill").
- **Nothing invented.** Behaviour, limits or fields that are not in the spec or the official
  documentation are not written. There is no sandbox or mock for İYS; none is added or described as if
  it existed.
- **Tool-neutral skills.** Skills follow the open Agent Skills format. Claude Code-specific features
  (slash commands) are mentioned together with a tool-neutral alternative.
- **No internal information.** The repository is public: no internal system names, internal addresses or
  internal codes.

## Content check (`tools/check-content.mjs`)

Every skill directory under `plugins/sms-skills/skills/` is checked:

| Check | Scope |
|---|---|
| `frontmatter` | SKILL.md frontmatter; `name` equals the directory name, `description` at most 1024 characters, SKILL.md at most 500 lines |
| `links` | Relative links point to existing files and do not leave the skill directory |
| `domains` | Netgsm subdomains and URLs are on the allow list |
| `sources` | SKILL.md contains the api-docs and Knowledge Base links; reference files contain an api-docs link |
| `errors` | Skill-specific: every error code and enum value in the spec appears in the relevant reference file as `CODE` |
| `endpoints` | Skill-specific: every path in the spec has a reference file |
| `limits` | `netgsm-sms` only: every path in the spec appears in the limits file |

Skill-specific rules live in the `SKILL_RULES` object. A new skill gets the generic checks
automatically; if it has a spec, add its error code and endpoint mapping to `SKILL_RULES`. To check a
single skill: `node tools/check-content.mjs plugins/sms-skills/skills/<skill>`.

## Leak scan (`tools/leak-scan.mjs`)

All text files in the repository are scanned for internal terms that are not stored in plain text
(salted SHA-256 digests in `tools/forbidden-terms.sha256`). To add a term:

```bash
node tools/leak-scan.mjs --hash "term"
node tools/leak-scan.mjs --hash-prefix "abc"
```

Append the printed line to the digest file. The scan also runs on the zip contents.

## Zip (`tools/build-zip.mjs`)

`dist/<skill>.zip` is built for each skill. The zip root holds a directory named after the skill with
`SKILL.md`, `references/`, `scripts/` (if any) and `LICENSE`. The output is deterministic (sorted files,
fixed mtime). Zips are attached to GitHub Releases when a version is published.

## Versioning

The plugin version is in `plugins/sms-skills/.claude-plugin/plugin.json`. Bump it when content or
behaviour changes, and keep the manifest descriptions in line with the list of skills.
