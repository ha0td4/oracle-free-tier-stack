<!-- needs: pocket-id -->

# Identity

Part F adds passkey login through Pocket ID: first for Cloudflare Access, then for each app that supports it. Pocket ID holds the people,
their passkeys and the groups (`admins`, `members`); Access stays the gate and asks Pocket ID who you are.
Every app **keeps** the login it got in D, as the fallback when Pocket ID is down.

## F. Pocket ID and single sign-on

### F1. Pocket ID

D2 set Pocket ID up: the admin (username `admin`, email ADMIN_EMAIL, verified, in `admins`), the groups `admins`
and `members`, **Emails verified by default**, a **Session Duration** of one day, and the OIDC clients of the [Reference](#reference).
Only the passkey is left.

1. Open the one-time link `./stack.sh up` printed in D2 (valid for one hour). Expired? **[Remote_VM]** print a new one:

```bash
docker exec stack-pocket-id-1 /app/pocket-id one-time-access-token ADMIN_EMAIL
```

2. **My Account → Passkeys → Add**. A passkey only works on `https://id.DOMAIN` (an RP ID or origin error means `DOMAIN` in `.env` is wrong).
   Add a second passkey on another device.

**Check:** sign out, then sign in at `https://id.DOMAIN` with your passkey.

`https://id.DOMAIN` shows a setup page instead? `ADMIN_EMAIL` was empty or Pocket ID was still starting: set it, `./stack.sh up`.
`./stack.sh up` said `setup stopped`? Add what it lists as missing under **Administration**: the groups (exactly these **Names**: Access and
the apps match on them), **Users → admin** (in `admins`, email verified), **Application Configuration → Email → Emails verified by
default**, **Application Configuration → Session Duration** `1440` (minutes), and the clients of the Reference. It does this only on the run
that creates the admin.

**One login a day.** With a Pocket ID session of a day and Access sessions of a day (F2), you use the passkey once: every app after it
passes through Pocket ID without asking. Pocket ID set up before this (its default is 60 minutes, so a passkey again each hour)? Set
**Application Configuration → Session Duration** to `1440` by hand.
Lost every passkey later? The command in step 1 gives you a new link.

### F2. Pocket ID as the Access login

Only the login to **your pages** changes: the Cloudflare dashboard keeps its own login, and SSH stays on Tailscale.

1. The Pocket ID client: ID `cloudflare-access`, secret from **[Remote_VM]** `grep '^ACCESS_OIDC_CLIENT_SECRET=' .env` (D2 created both).
   Empty? `CF_TEAM_NAME` was not set at D2: Pocket ID → **Administration → OIDC Clients** → add `cloudflare-access` as in the Reference.
2. Zero Trust → **Integrations → Identity providers → Add new → OpenID Connect**:

| Field | Value |
|---|---|
| Name | `Pocket ID` |
| App ID | `cloudflare-access` (Pocket ID calls it the **Client ID**) |
| Client secret | `ACCESS_OIDC_CLIENT_SECRET` from `.env` (step 1) |
| Auth URL | `https://id.DOMAIN/authorize` |
| Token URL | `https://id.DOMAIN/api/oidc/token` |
| Certificate URL | `https://id.DOMAIN/.well-known/jwks.json` |
| PKCE | on |
| OIDC Scopes | add `groups` |
| OIDC Claims | `groups` |

3. **Test** next to Pocket ID. The result must contain `"oidc_fields": { "groups": ["admins"] }`.
4. **Access controls → Applications → `stack-admin` → Edit** → login methods: add **Pocket ID**, keep **One-time PIN**. Same for every other
   Allow application. Leave the `bypass` applications alone, above all `pocket-id` (a login in front of `id.DOMAIN` is a redirect loop).
5. **Policies → Rule groups → `admins`** → add an Include rule: **OIDC Claim**, provider Pocket ID, claim `groups`, value `admins`. Keep the
   Emails rule (the PIN fallback needs it). Same on `members` with `members`. From then on, adding someone to the Pocket ID group is all
   Access needs.
6. Sessions of a day, like Pocket ID's (F1): **Settings → Authentication → Global session timeout** `24 hours`, and on each Allow
   application (`stack-admin`, and `team-chat`, `team-n8n` after G1) → **Edit → Session Duration** `24 hours`. While the global session
   lasts, the next application lets you in without asking.

**Check:** in a private window an admin page offers **Pocket ID**, and the passkey gets you in. Another admin page then opens without
asking. In another private window, One-time PIN still works.

| Symptom | Cause |
|---|---|
| Callback or redirect error | Wrong `CF_TEAM_NAME` in the client's callback URL (step 1) |
| "You are not allowed to access this service" | You are not in `admins`, or the client's Allowed User Groups is wrong |
| Test shows no `groups` | `groups` missing from OIDC Scopes (step 2) |
| Loop between Access and Pocket ID | `id.DOMAIN` lost its `bypass` application (B5) |
| Pocket ID works, then Access denies | The claim value in step 5 differs from the group Name (exact, case included) |

<!-- needs: alloy -->
### F3. Pocket ID login for Grafana

Done in D2: the client `grafana` (callback `https://monitor.DOMAIN/login/generic_oauth`, group `admins` only), its secret in the main VM's
`.env`. Grafana runs on the monitoring VM, so the secret moves there:

1. **[Remote_VM]** `grep '^GRAFANA_OIDC_CLIENT_SECRET=' .env` and copy the value.
2. **[Hub_VM]** put it in a file only you can read, run the install again with it, then delete the file. The hub name, the domain and
   your email come from the settings D8 saved:

   ```bash
   install -m 600 /dev/null ~/gf-oidc && nano ~/gf-oidc
   sudo bash /opt/stack/host/hub/deploy-hub.sh install --grafana-oidc-secret-file ~/gf-oidc
   rm ~/gf-oidc
   ```

   The script keeps the secret in Grafana's settings from then on: later installs need neither the file nor the flag.

Empty in step 1 (Pocket ID was set up before Grafana joined the stack)? Pocket ID → **Administration → OIDC Clients → Add** the client
`grafana` as in the [Reference](#reference), and paste the secret it shows once straight into the file of step 2.

Your Pocket ID email is the one D8 gave the Grafana admin (`--admin-email`), so you land in the D9 `admin` account; group `admins`
makes you a Grafana admin. Once the secret is there, Grafana sends you straight to Pocket ID instead of showing its login page.

**Check:** in a private window `https://monitor.DOMAIN` → Access → your dashboards, with no Grafana login page. The password form stays
as the fallback at `https://monitor.DOMAIN/login?disableAutoLogin`.

| Symptom | Cause |
|---|---|
| Grafana's login page instead of Pocket ID | The hub has no domain or no secret: `status` → Settings must show your `DOMAIN`; if not, run step 2 with `--domain DOMAIN` too |
| "You are not allowed to access this service" | You are not in `admins`, or the client's Allowed User Groups is wrong |
| `Login failed` after Pocket ID, a second empty user | The Grafana admin has another email than your Pocket ID account (the hub was installed without `--admin-email`, and passing it later changes nothing: Grafana sets it only when it creates the admin). Log in with the password at `https://monitor.DOMAIN/login?disableAutoLogin`, **Profile** → Email = your Pocket ID email → **Save**, delete the empty user (**Administration → Users and access → Users**), sign in again |
| `invalid_client` in `sudo journalctl -u grafana-server` | Wrong secret: copy it again (step 1), step 2 |
<!-- /needs -->

<!-- needs: hermes -->
### F4. OIDC for the Hermes dashboard (optional, next to basic auth)

Done in D2: the client `hermes-dashboard` (callback `https://hermes.DOMAIN/auth/callback`) and `config/hermes/dashboard-oidc.env`.
No such file (Pocket ID set up by hand)? Add the client as in the Reference, then **[Remote_VM]** fill in `DOMAIN` and the client ID:

```bash
cp config/hermes/dashboard-oidc.env.example config/hermes/dashboard-oidc.env && nano config/hermes/dashboard-oidc.env && ./stack.sh up
```

**Check:** the `hermes.DOMAIN` login offers Pocket ID, and choosing it lets you in (no passkey while your Pocket ID session lasts). Basic
auth stays as the fallback. If the Pocket ID login fails: delete `dashboard-oidc.env`, `./stack.sh up`.
<!-- /needs -->

<!-- needs: open-webui -->
### F5. Pocket ID login for Open WebUI

The group decides the role (`admins` → admin, `members` → user). Same email, so you land in your D7 account.
Done in D2: the client `open-webui` (callback `https://chat.DOMAIN/oauth/oidc/callback`), its ID and secret in `.env`.

Open WebUI sends you straight to Pocket ID, without its login page, once its login form is off. `.env` turns it off only on the first
start: an install from before turns it off in Admin Panel → Settings → Authentication → **Login Form**.

**Check:** in a private window `https://chat.DOMAIN` → Access → your admin account, with your chats, and no Open WebUI login page.
Your password stays as the fallback at `https://chat.DOMAIN/auth?form=true`; members cannot use it (nobody can sign up with a password).

| Symptom | Cause | Component |
|---|---|---|
| Open WebUI's login page instead of Pocket ID | The login form is still on (above), or `OPENWEBUI_OIDC_CLIENT_ID` is empty in `.env` (Pocket ID set up by hand): add the client as in the Reference, fill in both lines, `./stack.sh up` | open-webui |
| Bounced back and forth, never signed in | `https://chat.DOMAIN/auth?form=true` → your password, then check the client and the log line below | open-webui |
| "Sign-in with your identity provider failed" | `docker logs stack-open-webui-1 2>&1 \| grep -i "oauth callback"`: `invalid_client` = wrong secret, `redirect_uri` = callback differs from the Reference | open-webui |
| Refused, or the wrong role | The user is in neither `admins` nor `members` in Pocket ID | open-webui |
| A second, empty account | Your Pocket ID email differs from the D7 account: fix it under **Settings → Account**, sign in again | open-webui |
<!-- /needs -->

## Reference

`./stack.sh up` creates these on the run that creates the admin (`cloudflare-access` only with `CF_TEAM_NAME` in `.env`). By hand:
**Administration → OIDC Clients → Add**, Client ID and name as below, PKCE on.

| Client in Pocket ID | Public | Callback URL | Allowed User Groups | Used by | Component |
|---|---|---|---|---|---|
| `cloudflare-access` | no | `https://CF_TEAM_NAME.cloudflareaccess.com/cdn-cgi/access/callback` | `admins`, `members` | Access login (F2) | pocket-id |
| `grafana` | no | `https://monitor.DOMAIN/login/generic_oauth` | `admins` | Grafana login (F3) | alloy |
| `hermes-dashboard` | yes (PKCE, no secret) | `https://hermes.DOMAIN/auth/callback` | `admins` | Hermes dashboard (F4) | hermes |
| `open-webui` | no | `https://chat.DOMAIN/oauth/oidc/callback` | `admins`, `members` | Open WebUI login (F5) | open-webui |

- Allowed User Groups follows the group itself; only claim values use the group **Name**: the Access rules (F2 step 5) and the apps' OIDC settings.
<!-- needs: open-webui -->
- Open WebUI matches the Names in `OAUTH_ALLOWED_ROLES` and `OAUTH_ADMIN_ROLES` (docker-compose.yml).
<!-- /needs -->
- Never turn on Open Signup or emailed login codes: an admin adds each person and sends them a Login Code (G).
- Pocket ID down: Access falls back to One-time PIN, and every app to its own password login (D1).

<!-- needs: hermes -->
**Next:** [G. Team](TEAM.md), only when other people join.
<!-- /needs -->

<!-- /needs -->
