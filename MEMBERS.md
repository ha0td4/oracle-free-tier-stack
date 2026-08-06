<!-- needs: hermes pocket-id -->

# Member guide

For people an admin has added to the team. It explains what you receive, how to log in, and how to work with the assistant.
Admins: send this page to each new member (G, checklist).

You need:

- A device that supports **passkeys**: a phone, a computer with Windows Hello / Touch ID, or a password manager such as Bitwarden or 1Password.
- A Discord account.

## 1. Set up your login (once)

1. The admin sends you a **Login Code** link that looks like `https://id.DOMAIN/lc/...`. It works **once** and **for one hour**:
   open it soon, and ask for a new one if it expired. Never forward it.
2. You are signed in to Pocket ID, the team's login service. Open **My Account → Passkeys → Add passkey** and follow your device's prompt.
   Give the passkey the name of the device.
3. Add a **second passkey** on another device (or in your password manager). If you lose one device, the other still lets you in.

You log in with a passkey only: there is no password to remember or leak.

## 2. Web pages

Every page asks Cloudflare first. On its login page choose **Pocket ID** and confirm with your passkey: that is the only login of the day.
For about 24 hours every other page opens without asking. Always use **Pocket ID**: One-time PIN only lets you in if the admin also added
your email in Access.

<!-- needs: open-webui -->
- **Chat**: `https://chat.DOMAIN` opens straight into your account. Your chats are your own: admins cannot open them. Pick a model at the top;
  `hermes-agent` is the same assistant as on Discord, with the same shared memory. Turn on web search or a tool in the chat box, or attach a
  file to ask about it.
<!-- /needs -->
<!-- needs: n8n -->
- **n8n**: `https://n8n.DOMAIN` → your own n8n account: the admin sends you an invite link, you open it and set your password. Your workflows
  and credentials stay hidden from the other members (the admin who owns n8n can see them); to hand one to someone else, export it as JSON.
<!-- /needs -->

The monitoring and the other dashboards are for admins and answer "access denied" to you; that is expected. `https://id.DOMAIN` is where you
manage your passkeys. If a service seems down, tell an admin in Discord.

## 3. Work with the assistant on Discord

1. Accept the invite to the team's Discord server. The admin gives you the role that lets the bot answer you.
2. Write in `#hermes` (no @mention needed), or mention the bot in a project channel. Each request opens **its own thread**, and your
   conversation is separate from everyone else's.
3. Slash commands: `/new` (fresh conversation) and `/status` everywhere; `/model` and `/history` in a direct message to the bot. Other
   commands are for admins.
4. Ask it to search, summarize, draft, explain or run small tasks: it works inside its own sandboxed container, not on your computer.

**Do not tell the bot secrets** (passwords, keys, personal data). Its long-term memory is shared by the whole team: what you teach it can
come up for others.

Telegram (optional): message the bot directly; it replies with a pairing code. Send that code to an admin, who approves it.

<!-- needs: omniroute -->
## 4. Use the AI models from your own tools (optional)

If you asked for API access, the admin sends you three values over a secure channel: an **access client ID**, an **access client secret** and
**your own API key**. Keep them in your password manager, never in a chat or a shared file. Your tool (an editor, a script) calls
`https://ai.DOMAIN/v1` with all three, for example:

```bash
curl https://ai.DOMAIN/v1/models -H "CF-Access-Client-Id: <ACCESS_CLIENT_ID>" -H "CF-Access-Client-Secret: <ACCESS_CLIENT_SECRET>" -H "Authorization: Bearer <YOUR_KEY>"
```

Your key has its own limits. Long answers: turn on streaming (`stream: true`) or the connection may be cut after about two minutes.
<!-- /needs -->

## 5. When something does not work

| Symptom | What to do | Component |
|---|---|---|
| The Login Code link says it expired or was used | Ask the admin for a new one | always |
| Pocket ID: "You are not allowed to access this service" | You are not in the `members` group: tell the admin | always |
| Cloudflare lets you log in, then says you have no access | Expected on admin pages. On a page meant for members: you used One-time PIN, or you are not in `members` yet: use Pocket ID, or tell the admin | always |
| Lost or replaced a device | Log in with your other passkey and remove the old one under **My Account → Passkeys**. No other passkey: ask the admin for a new Login Code | always |
| The bot does not answer you on Discord | Your role is missing: tell the admin | always |
| The chat shows no model to pick | The admin has not given the team a model: tell the admin | open-webui |
| The n8n login fails | Use **Forgot password** if the admin set up email; otherwise ask the admin to reset your account | n8n |

When you leave the team, the admin removes your access everywhere. You can also delete your passkeys under **My Account → Passkeys**.

<!-- /needs -->
