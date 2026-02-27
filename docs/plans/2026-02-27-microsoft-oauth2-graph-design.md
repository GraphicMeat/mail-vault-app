# Microsoft OAuth2 Fix + Graph API Transport

**Date:** 2026-02-27
**Issue:** https://github.com/GraphicMeat/mail-vault-app/issues/2
**Status:** Approved

## Problem

Two distinct Microsoft account login failures:

1. **Corporate M365 accounts** — `AADSTS900971: No reply address provided` and HTTP 404 errors. Root cause: the app uses Thunderbird's borrowed public client ID (`9e5f94bc-...`), which corporate tenants may block or not trust.
2. **Personal Outlook.com/Hotmail/Live.com accounts** — Known Microsoft server-side IMAP regression since Dec 2024 ("User is authenticated but not connected"). Not fixable from client side.

## Solution

Two independent parts, shipped sequentially.

### Part A — Fix Corporate M365 OAuth2

**Swap to MailVault's own Azure AD app registration.**

- **Client ID:** `d4e1c192-2c87-4aeb-b2d6-edbb91c577cd`
- **App type:** Public client (PKCE, no secret needed)
- **Redirect URI:** `http://localhost:19876/callback` (Mobile/Desktop platform)
- **Supported accounts:** Any Entra ID Tenant + Personal Microsoft accounts
- **API permissions (portal):** `Mail.ReadWrite`, `offline_access`, `SMTP.Send` (Graph). IMAP scopes requested dynamically at login.

**Code changes:**

1. `src-tauri/src/oauth2.rs` — Replace `MS_THUNDERBIRD_CLIENT_ID` with `MS_MAILVAULT_CLIENT_ID` (`d4e1c192-...`). Keep `MAILVAULT_MS_CLIENT_ID` env var override for CI/custom deployments.
2. `src/components/AccountModal.jsx` — Add optional "Advanced" section for Microsoft accounts with custom client ID and tenant ID fields. Persisted per-account.
3. `src-tauri/src/oauth2.rs` — Support per-account tenant ID in auth/token endpoint URLs (e.g., `/{tenant_id}/oauth2/v2.0/authorize` instead of `/common`).
4. Account data model — New optional fields: `oauth2CustomClientId`, `oauth2TenantId`.

### Part B — Microsoft Graph API Transport (Read-Only)

**Use Graph REST API instead of IMAP for personal Microsoft accounts, bypassing the IMAP regression.**

**New module:** `src-tauri/src/graph.rs`

**Graph API endpoints:**

| Operation | Endpoint | Method |
|-----------|----------|--------|
| List mailboxes | `/me/mailFolders` | GET |
| Fetch headers (paginated) | `/me/mailFolders/{id}/messages` | GET |
| Fetch full email | `/me/messages/{id}` | GET |
| Mark read/unread | `/me/messages/{id}` | PATCH |

**OAuth2 scopes for Graph:** `Mail.ReadWrite` + `offline_access` (already registered in Azure app).

**Auto-detection:** When a Microsoft account's email domain is `outlook.com`, `hotmail.com`, `live.com`, or `msn.com`, the app requests Graph scopes and routes through Graph transport. Corporate domains use IMAP scopes as before.

**Data mapping:** Graph API returns JSON. The module converts responses to the same `EmailHeader` and email body structs that IMAP produces. The frontend, store, caching pipeline, and Maildir storage remain unchanged.

**Sending:** SMTP retained for now. If SMTP also fails for personal accounts, show a user-facing message.

## Testing

### Part A — OAuth2 Client ID Swap
- Manual test with a corporate M365 account
- Verify auth URL, consent screen, token exchange, and refresh with new client ID
- Verify `MAILVAULT_MS_CLIENT_ID` env var override still works

### Part B — Graph API Transport
**Rust unit tests (`src-tauri/src/graph.rs`):**
- JSON response parsing to `EmailHeader` struct mapping
- Pagination logic (`$top`, `$skip`, `@odata.nextLink`)
- Error handling (401 expired token, 429 rate limit, 5xx server errors)
- Domain detection (Graph vs IMAP routing)

**Integration tests (mock HTTP server):**
- List mailboxes — verify folder names/IDs
- Fetch headers — verify subject, from, date, flags
- Fetch full body — verify HTML/text body + attachments metadata
- Mark read/unread — verify PATCH succeeds

**Frontend tests:**
- Graph-backed accounts render identically to IMAP accounts
- Pipeline coordinator handles Graph accounts correctly

## Ship Order

| Part | Scope | Priority |
|------|-------|----------|
| A — Client ID swap | Small (constant change + optional UI fields) | Ship first |
| B — Graph transport | Medium (new Rust module, scope branching, data mapping) | Ship second |

## Key Principle

The frontend and store layer don't change. Graph is an alternative backend that produces the same data structures as IMAP.
