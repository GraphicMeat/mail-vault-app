# Security Policy

MailVault holds people's mail, account passwords and OAuth tokens. We treat security reports as the highest-priority work we have.

## Supported versions

Only the latest release gets security fixes. MailVault updates itself, so a fix ships as a new release rather than a backport.

| Version | Supported |
| --- | --- |
| Latest release ([releases](https://github.com/GraphicMeat/mail-vault-app/releases/latest)) | Yes |
| Anything older | No, please update |

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a security problem.**

Report it privately through GitHub: open the [Security tab](https://github.com/GraphicMeat/mail-vault-app/security) and choose **Report a vulnerability**. Only the maintainers can see the report.

If you cannot use GitHub, write to us through [graphicmeat.com/contact](https://graphicmeat.com/contact) and say it is a security report. We will reply with a private channel.

A useful report includes:

- the MailVault version and platform (macOS, Windows or Linux, and how you installed it: DMG, Windows installer, `.deb` or Snap)
- what an attacker can do, and what they need first (a crafted email, local access, a network position)
- steps or a proof of concept that reproduces it
- any logs, with passwords, tokens and real addresses removed

## What happens next

- We acknowledge your report within 3 working days.
- We confirm or rule out the issue and share our assessment within 10 working days.
- We keep you updated while we fix it, and agree a disclosure date with you. Our target is a fixed release within 90 days, sooner for anything serious.
- We credit you in the release notes and the GitHub advisory, unless you would rather stay anonymous.

## Scope

In scope:

- The MailVault desktop app and its background daemon on every platform
- Handling of untrusted mail: HTML rendering, attachments, links, remote content, MIME and header parsing
- Storage of credentials and tokens (system keychain, OAuth flows, the local loopback callback)
- The local vault, backups, exports and imports (`.eml`, Maildir, MBOX)
- The update channel (signed updates and their verification)
- [mailvaultapp.com](https://mailvaultapp.com) and its API

Out of scope:

- Vulnerabilities in mail providers' servers (report those to the provider)
- Attacks that need an already compromised device or administrator access, unless MailVault makes them meaningfully worse
- Social engineering, phishing of our team, or physical attacks
- Denial of service through traffic volume
- Missing best-practice headers or reports from automated scanners without a demonstrated impact
- Issues in third-party dependencies that MailVault does not expose (please report those upstream; tell us if MailVault is affected)

## Safe harbor

We will not pursue legal action against anyone who researches and reports in good faith under this policy: test only against your own accounts and data, do not access or change other people's mail, do not degrade the service for others, and give us reasonable time to fix the issue before you disclose it.
