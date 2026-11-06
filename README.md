# Netgsm Agent Skills

**English** · [Türkçe](README.tr.md)

Netgsm provides this skill package so that customers integrating with our APIs can work faster and more
safely with AI coding agents. The package teaches an agent the correct usage rules, error codes and
official documentation links of Netgsm's APIs for SMS sending, balance queries and consent management
in İYS (İleti Yönetim Sistemi, Turkey's commercial electronic message consent system).

The skills follow the open [Agent Skills](https://agentskills.io/) format (a folder with a `SKILL.md`
file and references), so they work with any agent that supports skills, for example Claude Code,
claude.ai, OpenAI Codex, GitHub Copilot, Cursor, Gemini CLI, Kiro and Goose. This repository is also a
Claude Code plugin marketplace named `netgsm-agent-skills` containing the `sms-skills` plugin.

The skill content is in Turkish, because it is written for developers in Turkey; code samples, field
names and error codes appear in their original form, and agents answer in the language you ask in.

## What's included

### Skills

| Skill | Scope | Test environment |
|---|---|---|
| `netgsm-sms` | SMS API v3 and the Identity (token) API: bulk SMS, OTP, template sends, delivery reports, inbound SMS, webhooks, sender names, `iysFilter`, balance and remaining packages (`GET /sms/v3/balance`), error codes and retry rules | Local mock server and the Netgsm sandbox |
| `netgsm-iys` | İYS API v1: saving and querying consents (ONAY / RET), brand code, consent result webhook, error codes, use together with SMS sends | None; every request goes to the live İYS |

An agent loads a skill automatically when you ask about its topic or write integration code for it.

### Local mock server

`netgsm-sms` ships a dependency-free Node.js mock of the SMS and Identity APIs
(`scripts/netgsm-sms-mock.mjs`). It speaks the same paths and contract as the real API, needs no Netgsm
subscription and never sends SMS. It can inject errors on demand (`503`, `504`, `500`, `429`), deliver
webhooks, and report integration anti-patterns at `GET /__mock/advice`.

### Commands (Claude Code only)

| Command | What it does |
|---|---|
| `/sms-mock [port]` | Starts the local SMS API mock server in the background (default port `4010`). |
| `/sms-review [path]` | Reviews the Netgsm SMS API integration in your code against the skill rules and reports findings by severity; it does not change code without your approval. |

## Who it is for

- Software teams building bulk SMS, OTP or notification integrations with the Netgsm SMS API,
- Businesses that must register commercial electronic message consents in İYS and apply the İYS
  filter to their sends,
- Customers who want to monitor their account balance and packages from their applications.

Developers without a Netgsm subscription can still build and test an SMS integration with the local
mock server and the sandbox.

## Installation

### 1. Claude Code (plugin marketplace)

```
/plugin marketplace add netgsm/skills
/plugin install sms-skills@netgsm-agent-skills
```

After installation both skills and the `/sms-mock` and `/sms-review` commands are available.

### 2. claude.ai (skill upload)

1. Download the zip of the skill you need from the **Releases** page of this repository:
   `netgsm-sms.zip`, `netgsm-iys.zip`. Each zip contains one skill.
2. In claude.ai, upload the zip under **Settings → Capabilities → Skills**.

Until a release is published, you can build the zips yourself with `npm install && npm run zip`
(output in `dist/`). The mock server does not run inside claude.ai; run it on your own machine instead.

### 3. Other agents that support Agent Skills

Copy the skill folders into your agent's skills directory:

- `plugins/sms-skills/skills/netgsm-sms`
- `plugins/sms-skills/skills/netgsm-iys`

Many tools read project-level skills from `.agents/skills/` in your repository; the exact location
(project or user level) differs between tools and changes over time, so check your tool's documentation.
Keep each folder intact (`SKILL.md`, `references/` and, for `netgsm-sms`, `scripts/`).

The `/sms-mock` and `/sms-review` slash commands are Claude Code-specific. Their equivalents:

- **Mock server:** run it directly with Node.js 20 or later, no installation needed:

  ```bash
  node <skill folder>/scripts/netgsm-sms-mock.mjs [options]
  ```

  | Option | Meaning |
  |---|---|
  | `--port <n>` | Port to listen on (default `4010`) |
  | `--host <h>` | Address to listen on (default `127.0.0.1`). On a non-loopback address a warning is printed and loopback webhook URLs are rejected as on the real API. |
  | `--token-ttl <s>` | Token lifetime in seconds (default `86400`) |
  | `--rate-scale <x>` | Rate-limit multiplier (default `1`; `10` = limits ten times looser, below `1` = tighter) |
  | `--quiet` | Do not log successful requests; show only errors (✘) and findings (⚠) |
  | `--help` | Show the help text |

- **Integration review:** ask your agent to review your Netgsm integration against the `netgsm-sms`
  skill (its rules, `references/errors.md` and `references/limits-and-batching.md`).

### 4. Any LLM or chat without skill support

Give the model the relevant files as context: the API contract `references/openapi.yaml` (and
`references/identity-openapi.json` for tokens) plus the reference files for your topic, for example
`references/errors.md`, `references/limits-and-batching.md` or the endpoint file under
`references/endpoints/`. Start with `SKILL.md`, which lists the rules and maps questions to files.

### What's Claude-specific

Only the packaging: the plugin marketplace files (`.claude-plugin/`), the `/sms-mock` and `/sms-review`
commands, and the claude.ai zip upload. The skills themselves (`SKILL.md`, references, examples and the
mock server) are tool-neutral.

## Quick start

Once installed, an agent can handle requests like these directly:

- "Write a Node.js service that sends SMS to 10,000 recipients in a single Netgsm request; test it on the
  mock first."
- "Write code that registers the SMS consent we collect on our web form in İYS; how should `iysFilter`
  be used for commercial sends?"
- "Write a function that checks our remaining balance before a campaign."
- "Review our existing Netgsm integration in `src/`."

The mock runs with Node.js 20 or later and needs no installation:

```bash
node plugins/sms-skills/skills/netgsm-sms/scripts/netgsm-sms-mock.mjs --port 4010
```

It serves the same paths as the real API (`/auth/v3/*`, `/sms/v3/*`) at `http://127.0.0.1:4010` and
lists its test accounts on start-up (for example `8500000000` / `password001`, sender `MOCKTEST`).
Details are in `references/testing.md` of the `netgsm-sms` skill.

## Environments

Our recommended path for an SMS integration:

| Stage | Address | Description |
|---|---|---|
| 1. Local mock | `http://127.0.0.1:4010` | No subscription needed, sends no SMS. For development, automated tests and error scenarios. |
| 2. Sandbox | `https://ext-sandbox.netgsm.com.tr` | Real network and token flow with demo accounts; sends no SMS, free of charge. |
| 3. Live | `https://ext-api.netgsm.com.tr` | Real, paid sends with your own credentials. |

There is no mock or sandbox for the İYS API (`https://ext-api.netgsm.com.tr/iys/v1`). The balance query
(`GET /sms/v3/balance`) can be tried on the local mock with sample data. Consents saved in İYS are legal
records; the skills warn against testing with real numbers or sample records and ask for your explicit
approval before such requests.

## Official documentation and Knowledge Base

The skills summarise our official documentation and point to the relevant page in every answer. The
official documentation is always the primary source:

- **API documentation:** https://api-docs.netgsm.com.tr/ (SMS API v3, Identity, İYS API, balance)
- **Knowledge Base (Bilgi Bankası):** https://bilgibankasi.netgsm.com.tr/ (account and process topics
  such as API sub-users, API access, IP permissions, sender name requests, NetİYS registration and
  balance top-ups)
- **Portal (Online İşlemler):** https://portal.netgsm.com.tr

On topics the documentation does not cover, the skills do not guess; they direct you to the Knowledge
Base and our support channels.

## Security and privacy

- **Your credentials are not shared with the assistant.** Keep usernames, passwords and brand codes in
  environment variables or a secrets manager; the skills enforce that they are never written into code,
  repositories, logs or browser bundles.
- **The skills never send SMS on their own.** They provide information and code samples. A command or
  code that calls a live Netgsm address runs only with your explicit approval and your own credentials;
  the agent states beforehand that the request runs on a real account and that sends are charged.
- **Tests and samples never call the live API.** The package's tests and tools run only against the
  local mock server or fake clients.
- **Personal data:** recipient numbers and e-mail addresses are personal data; the sample code
  recommends masking them in logs.

## Support

If you cannot find an answer in the official documentation or the Knowledge Base, contact our support
teams:

| Channel | Contact |
|---|---|
| Call centre | `+90 850 303 0 303` · `+90 312 911 0 911` |
| Technical support | `teknikdestek@netgsm.com.tr` |
| Subscription services | `abone.islemleri@netgsm.com.tr` |

Including the `requestId` (SMS API) or `request_id` (Identity), the `jobId` for sends, and the
`X-Thread-Id` (İYS API) in your support request helps us investigate quickly. Never share passwords or
tokens on any channel.

## Contributing

The development environment, tests, content checks and spec update steps are described in
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

This package is provided under the [MIT license](LICENSE). License texts of the third-party packages
bundled into the mock server file are at the end of that file.
