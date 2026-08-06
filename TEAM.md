<!-- needs: hermes pocket-id -->
<!-- catalog -->

# Team

Part G is **optional**: do it only when other people join (up to ~15). Before it, [F1 and F2](IDENTITY.md) must be done, and F5 if you run
Open WebUI. Members get their own guide: [MEMBERS.md](MEMBERS.md).

## Design

The team works through **Discord** (Hermes) and two web pages, the chat (`chat.`) and n8n. Everything else, monitoring included, stays admins-only.
No new public route is needed: Hermes calls out to Discord.

### Role matrix

| Access point | `admins` | `members` | Public |
|---|---|---|---|
| **Discord** (main interface) | role `hermes-admin`: all commands | role `hermes-user`: chat, own session and thread, limited commands | - |
| Telegram (optional) | ID in the allowlist | DM pairing, approved by an admin | - |
| `chat.DOMAIN` Open WebUI | admin role | user role, the models and tools you grant | - |
| `n8n.DOMAIN` | owner account | own member account | `/webhook*`, `/healthz` |
| `ai.DOMAIN` OmniRoute | dashboard | own API key only | `/v1` with the service token |
| `id.DOMAIN` Pocket ID | yes | own passkeys | bypass, rate-limited |
| `hermes.`, `monitor.`, `dash.` | yes | no | - |

Pocket ID groups decide everything: Access lets `admins` and `members` in (F2), Open WebUI maps them to roles (F5), and the admin-only OIDC
clients refuse members.

### Decisions and accepted risks

- **Hermes is one shared identity.** Every member's commands run in the same container, with every toolset (terminal included) and one
  shared long-term memory. Accepted for a trusted team; what contains it is in [OPERATIONS.md](OPERATIONS.md#security). For the team,
  Discord roles and slash-command limits come on top, and members are told not to give it secrets.
- **One OmniRoute key per person** with a spend limit; OmniRoute knows keys, not users, so name each key after its person.
- **One n8n member account per person.** n8n Community shows a workflow only to its creator and the owner; members cannot share with each other.
- **Monitoring is admins-only:** no status page and no Grafana accounts for members. Outages reach the team through you or an alert in Discord.
- **RAM:** the standard tier already sizes Hermes (3 GB, `max_concurrent_sessions: 4`), Open WebUI and Pocket ID for ~15 people. Watch
  `./stack.sh stats` the first week.

## G. Open it to the team

### G1. Access for the team

The `members` rule group and the `admins-and-members` policy exist since B3/B4, and F2 tied `members` to the Pocket ID group.
**Access controls → Applications**, as in B5, with login methods **Pocket ID** and **One-time PIN**, and a Session Duration of
`24 hours` (F2 step 6):

| Application | Subdomain | Path | Policy | Component |
|---|---|---|---|---|
| `team-chat` | `chat` | (empty) | `admins-and-members` | open-webui |
| `team-n8n` | `n8n` | (empty) | `admins-and-members` | n8n |

The n8n Bypass applications have a path, so they still win for webhooks. Every other subdomain stays under `stack-admin`.
Members who call the API from their own tools also need the [service token](CLOUDFLARE.md#optional-api-access-from-outside-service-token).

**Check:** both applications are listed, and your own login still opens every page.

### G2. Discord

1. Discord → **User Settings → Advanced → Developer Mode** on (to copy IDs).
2. Create a server with roles `hermes-admin` and `hermes-user`, and channels `#hermes`, `#hermes-ops` (admins only) and any project channels.
3. **Discord Developer Portal → New Application → Bot**: *Reset Token* and copy it; turn on **Message Content Intent** and **Server Members Intent**.
4. **OAuth2 → URL Generator**: scopes `bot`, `applications.commands`; permissions *View Channels, Send Messages, Send Messages in Threads,
   Create Public Threads, Read Message History, Embed Links, Attach Files, Use Slash Commands* → open the URL → add the bot to your server.
5. Copy the IDs of both roles, both channels and each admin.

**Check:** the bot is listed as a member of the server (offline until G3).

### G3. Configure Hermes for the team

**[Remote_VM]**

1. `sudo nano data/hermes/.env` → add the lines of `config/hermes/env.team.example` with your token and IDs.
2. `sudo nano data/hermes/config.yaml` → merge in the blocks of `config/hermes/config.team.example.yaml` that are missing (D6 already
   wrote `model` and `dashboard`).
3. Shared context for every session:

```bash
sudo cp config/hermes/AGENTS.example.md data/hermes/AGENTS.md && sudo nano data/hermes/AGENTS.md
```

4. Apply:

```bash
./stack.sh restart hermes
```

**Check:** the bot is online in Discord and answers you in `#hermes`.

### G4. The team's pages: chat and n8n
<!-- needs: open-webui -->
**Open WebUI.** A member gets an account at their first Pocket ID login, in group `members` (role user). Grant what they may use:

1. **Admin Panel → Users → Groups**: create `members` (exactly this name) if no member has logged in.
2. **Admin Panel → Settings → Models**: give `members` the models it may use (and `hermes-agent` if wanted). Ungranted models stay admin-only.
<!-- needs: n8n -->
3. **Admin Panel → Settings → Integrations**: give `members` the n8n tools (D7).
<!-- /needs -->
<!-- /needs -->

<!-- needs: n8n -->
**n8n.** Each member gets a member account (step 3 of the checklist below). Keep n8n's defaults (*Execute Command* off, Code nodes in task runners).
A member's workflow can call any address n8n reaches, so never put an admin-only secret in a credential a member can use.
<!-- /needs -->

### G5. Per-person keys

OmniRoute → **API keys** → one named key per person who needs the API, with a spend limit. They call it with the service token:

```bash
curl https://ai.DOMAIN/v1/models -H "CF-Access-Client-Id: <ACCESS_CLIENT_ID>" -H "CF-Access-Client-Secret: <ACCESS_CLIENT_SECRET>" -H "Authorization: Bearer <THEIR_KEY>"
```

### G6. Test with a team account

Add a test person with the checklist below, then check:

- With `hermes-user`: chatting in `#hermes` works and each request opens its own thread; `/update` is refused.
<!-- needs: open-webui -->
- `https://chat.DOMAIN` after their one passkey login at Access opens straight into their account: user role, only the granted models,
  no Admin panel.
<!-- /needs -->
<!-- needs: n8n -->
- `https://n8n.DOMAIN`: their own login, without your workflows.
<!-- /needs -->
- Admin pages (monitoring included) answer "access denied".
- Removing the role makes the bot stop answering.

## Add / remove a person (checklist)

**Add**, in this order:

1. **Pocket ID** → Users → create the user **with an email** (shown as verified), add to group `members` → **Login Code** → send the link
   over a secure channel.
2. **Discord**: invite them, give role `hermes-user`. Telegram (optional): `./stack.sh hermes pairing approve telegram <CODE>` when they
   send their code.
3. **n8n** (as owner) → **Settings → Users → Invite**, role **Member** → send them the invite link n8n shows.
4. **OmniRoute** (only for API use): create their key; send it with the service token over a secure channel.
5. Send them the [member guide](MEMBERS.md).

Access and Open WebUI need nothing: the Pocket ID group covers both.

**Remove:**

1. **Discord**: remove `hermes-user` (immediate). Telegram: `./stack.sh hermes pairing revoke telegram <ID>`.
2. **Pocket ID** and **Access**: end their sessions ([Revoke a session](OPERATIONS.md#revoke-a-session)).
3. **Open WebUI**: Admin Panel → Users → delete them (an open session survives the Pocket ID change).
4. **n8n**: **Settings → Users** → delete, and transfer their workflows and credentials to yourself.
5. **OmniRoute**: delete their key.

## If your versions differ

- Hermes `config.yaml` keys (`gateway.platforms.discord.extra.*`, `group_sessions_per_user`, `unauthorized_dm_behavior`) can move between
  releases: check its docs.
- No invite link shown by n8n: set n8n's SMTP variables in `docker-compose.override.yml`.
- `data/hermes/.env` must not set `API_SERVER_HOST` (it would win over compose's `0.0.0.0` and hide the chat page's model).

<!-- /catalog -->
<!-- /needs -->
