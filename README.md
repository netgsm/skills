# Netgsm Agent Skills

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Agent Skills](https://img.shields.io/badge/format-Agent%20Skills-blue.svg)](https://agentskills.io/)

Official agent skills for integrating with Netgsm APIs. They give AI coding assistants the usage
rules, limits, error codes and documentation links of the Netgsm SMS API v3, the Identity (token) API
and the İYS API v1, so that generated integration code follows the API contract from the start.

- Two skills: `netgsm-sms` (SMS API v3, tokens, reports, webhooks, balance) and `netgsm-iys` (İYS
  consent management).
- A local, dependency-free mock of the SMS and Identity APIs for development and automated tests. It
  sends no SMS and needs no subscription.
- Open [Agent Skills](https://agentskills.io/) format: works with Claude Code, claude.ai, OpenAI Codex,
  GitHub Copilot, Cursor, Gemini CLI and other tools that support skills.
- Every answer points to the official documentation at
  [api-docs.netgsm.com.tr](https://api-docs.netgsm.com.tr/).

The skill content is written in Turkish for developers in Türkiye. Field names, error codes and code
samples keep their original form, and the assistant answers in the language of the question.

## Skills

| Skill | Covers | Test environment |
|---|---|---|
| `netgsm-sms` | SMS API v3 and Identity API: bulk and OTP sends, template sends, delivery reports, inbound SMS, webhooks, sender names, `iysFilter`, balance (`GET /sms/v3/balance`), error codes and retry rules | Local mock and Netgsm sandbox |
| `netgsm-iys` | İYS API v1: saving and querying consents (`ONAY` / `RET`), brand code, consent webhook, error codes, combining consents with SMS sends | None; requests go to the live İYS registry |

The assistant loads a skill automatically when a question or a coding task concerns its topic.

## Installation

### Claude Code

```text
/plugin marketplace add netgsm/skills
/plugin install sms-skills@netgsm-agent-skills
```

This installs both skills and two commands:

| Command | Description |
|---|---|
| `/sms-mock [port]` | Starts the local SMS API mock in the background (default port `4010`). |
| `/sms-review [path]` | Reviews a Netgsm SMS API integration against the skill rules and reports findings by severity. It changes no code without approval. |

### claude.ai

1. Download the skill zips from the [latest release](https://github.com/netgsm/skills/releases/latest):
   [netgsm-sms.zip](https://github.com/netgsm/skills/releases/latest/download/netgsm-sms.zip) and
   [netgsm-iys.zip](https://github.com/netgsm/skills/releases/latest/download/netgsm-iys.zip).
2. Upload each zip under **Settings → Capabilities → Skills**.

To build the zips from source instead, run `npm ci && npm run zip`; they are written to `dist/`. The mock
does not run inside claude.ai; run it on your own machine.

### Other tools

Copy the skill folders into the skills directory of your tool, keeping each folder intact:

- `plugins/sms-skills/skills/netgsm-sms` (`SKILL.md`, `references/`, `scripts/`)
- `plugins/sms-skills/skills/netgsm-iys` (`SKILL.md`, `references/`)

The location differs between tools (many read project skills from `.agents/skills/`); see your tool's
documentation. Without slash commands, start the mock with Node.js (below) and ask the assistant to
review your integration against the `netgsm-sms` skill.

For a model without skill support, provide `SKILL.md` and the relevant reference files as context,
for example `references/openapi.yaml`, `references/errors.md` and `references/limits-and-batching.md`.

## Local mock server

The `netgsm-sms` skill includes a mock of the SMS API v3 and the Identity API
(`scripts/netgsm-sms-mock.mjs`). It runs with Node.js 20 or later and needs no installation:

```bash
node plugins/sms-skills/skills/netgsm-sms/scripts/netgsm-sms-mock.mjs --port 4010
```

It serves the same paths and contract as the real API (`/auth/v3/*`, `/sms/v3/*`) at
`http://127.0.0.1:4010` and prints its test accounts on start-up (for example `8500000000` /
`password001` with sender `MOCKTEST`). It can inject error responses (`429`, `500`, `503`, `504`),
deliver webhooks and report integration anti-patterns at `GET /__mock/advice`.

| Option | Description |
|---|---|
| `--port <n>` | Port to listen on (default `4010`). |
| `--host <h>` | Address to listen on (default `127.0.0.1`). |
| `--token-ttl <s>` | Token lifetime in seconds (default `86400`). |
| `--rate-scale <x>` | Rate limit multiplier (default `1`; `10` makes limits ten times looser). |
| `--quiet` | Log only errors and findings. |
| `--help` | Show all options. |

Test scenarios and accounts are described in `references/testing.md` of the `netgsm-sms` skill.

## Environments

| Stage | Address | Description |
|---|---|---|
| 1. Local mock | `http://127.0.0.1:4010` | No subscription needed and no SMS sent. For development, automated tests and error scenarios. |
| 2. Sandbox | `https://ext-sandbox.netgsm.com.tr` | Real network and token flow with demo accounts. Sends no SMS and is free of charge. |
| 3. Live | `https://ext-api.netgsm.com.tr` | Paid sends with your own credentials. |

The İYS API (`https://ext-api.netgsm.com.tr/iys/v1`) has no mock or sandbox. Consents saved in İYS are
legal records: the skills warn against testing with real numbers or sample records and ask for explicit
approval before such requests.

## Example requests

- "Write a Node.js service that sends an SMS campaign to 10,000 recipients in one Netgsm request, and
  test it against the mock."
- "Register the SMS consent collected on our web form in İYS, and apply `iysFilter` to commercial sends."
- "Check the remaining SMS balance before a campaign starts."
- "Review the Netgsm integration in `src/`."

## Security

- **Credentials stay out of code.** The skills keep usernames, passwords and brand codes in environment
  variables or a secrets manager, never in source code, repositories, logs or browser bundles.
- **No SMS without approval.** The skills provide guidance and code. A command that calls a live Netgsm
  address runs only after your explicit approval, with your own credentials, and the assistant states
  beforehand that the request is charged.
- **Tests stay local.** The repository's tests run only against the mock or fake clients.
- **Personal data.** Recipient numbers are personal data; the sample code recommends masking them in
  logs.

To report a security issue, write to [teknikdestek@netgsm.com.tr](mailto:teknikdestek@netgsm.com.tr).

## Documentation

- API documentation: https://api-docs.netgsm.com.tr/
- Knowledge Base (Bilgi Bankası): https://bilgibankasi.netgsm.com.tr/ (API users, API access, IP
  permissions, sender name requests, NetİYS registration, balance top-ups)
- Online services portal: https://portal.netgsm.com.tr

The official documentation is the primary source. Where it does not cover a topic, the skills refer to
the Knowledge Base and Netgsm support instead of guessing.

## Support

| Channel | Contact |
|---|---|
| Call centre | `+90 850 303 0 303`, `+90 312 911 0 911` |
| Technical support | [teknikdestek@netgsm.com.tr](mailto:teknikdestek@netgsm.com.tr) |
| Subscription services | [abone.islemleri@netgsm.com.tr](mailto:abone.islemleri@netgsm.com.tr) |

Include the `requestId` (SMS API), `request_id` (Identity API) or `X-Thread-Id` (İYS API) of the failed
request, and the `jobId` for sends. Never share passwords or tokens.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, tests and content rules.

## License

[MIT](LICENSE). The licence texts of third-party packages bundled into the mock are at the end of
`scripts/netgsm-sms-mock.mjs`.
