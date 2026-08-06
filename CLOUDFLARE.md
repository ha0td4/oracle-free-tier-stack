# Cloudflare (Free plan only)

All of part B happens in the Cloudflare dashboard, before the VM runs anything. Access goes in before the routes, so no setup page is ever
reachable without a login. **Never edit the DNS records of the root domain (your blog).**

Where things are: **Networking → Tunnels** for the tunnel, **Zero Trust** for Access, **Domains → Overview → your domain** for SSL/TLS and Security.
Labels change often; if one differs, the [Cloudflare docs](#sources-cloudflare-docs) have the current name.

## B. Cloudflare dashboard (for you alone)

Access in three pieces, built in this order: **rule groups** (who: `admins`, `members`) → **policies** (what happens to them) → **applications**
(which hostnames a policy protects). Anything that matches no Allow policy is refused.

### B1. Create the tunnel (token only)

1. **Networking → Tunnels → Create a tunnel** → name `oracle-stack` → **Create Tunnel**.
2. On the install step, copy only the **token**: the long string after `--token` (starts with `eyJ`). Do **not** run the command: the stack
   runs cloudflared.
3. Leave the wizard. The tunnel stays *Inactive* until D2.
<!-- needs: alloy -->
4. The monitoring VM gets a tunnel of its own, so its dashboards stay reachable when the main VM is down: create a second one the same way,
   named `oracle-observe`, and keep its token apart (D8 hands it to `deploy-hub.sh` on the monitoring VM). It stays *Inactive* until D8.
<!-- /needs -->

**Check:** `oracle-stack` is listed, and its token is in your password manager.
<!-- needs: alloy -->
So are `oracle-observe` and its token.
<!-- /needs -->

### B2. Login method

**Zero Trust → Integrations → Identity providers → Add new identity provider → One-time PIN** (a code by email).
<!-- needs: pocket-id -->
F2 adds Pocket ID (passkeys) later; One-time PIN stays as the fallback.
<!-- /needs -->

**Check:** One-time PIN is listed.

### B3. Rule groups `admins` and `members`

**Access controls → Policies → Rule groups → Add a group**, once per column:

| Field | `admins` | `members` |
|---|---|---|
| Name | `admins` | `members` |
| Rule type | Include | Include |
| Selector | Emails | Emails |
| Value | ADMIN_EMAIL | ADMIN_EMAIL (a group needs one rule; members get added in G) |

### B4. Policies `admins-only`, `admins-and-members` and `bypass`

**Access controls → Policies → Add a policy**, once per column:

| Field | `admins-only` | `admins-and-members` | `bypass` |
|---|---|---|---|
| Action | Allow | Allow | Bypass |
| Session duration | 24 hours | 24 hours | default |
| Include → Selector | Rule groups | Rule groups | Everyone |
| Include → Value | `admins` | `admins`, plus a second Include rule with `members` | - |

**Check:** Policies lists `admins-only`, `admins-and-members` and `bypass`; Rule groups lists `admins` and `members`.

### B5. Applications

**Access controls → Applications → Create new application → Self-hosted and private**, once per row:
name, **Add public hostname** (Subdomain, your Domain, Path), the policy, login method **One-time PIN**, **Create**.

| Application | Subdomain | Path | Policy | Component |
|---|---|---|---|---|
| `stack-admin` | `*` | (empty) | `admins-only` | always |
| `pocket-id` | `id` | (empty) | `bypass` (Pocket ID protects itself with passkeys, and apps call it server-side) | pocket-id |
| `n8n-webhook` | `n8n` | `webhook` | `bypass` | n8n |
| `n8n-webhook-test` | `n8n` | `webhook-test` | `bypass` (remove when you stop building workflows) | n8n |
| `n8n-health` | `n8n` | `healthz` | `bypass` | n8n |

`stack-admin` locks every subdomain, including ones you add later, to `admins`; it does not cover the root domain, so the blog stays public.
The more specific application wins, which D3 checks.
<!-- needs: n8n -->
Using n8n Form triggers? Add one more `bypass` application for `n8n` · `form`.
<!-- /needs -->

**Check:** Applications lists every row, and your blog on `DOMAIN` still opens.

### B6. Publish the routes

**Networking → Tunnels** → `oracle-stack` → **Routes → Add route → Published application**, once per row: Subdomain, your Domain, Service URL.

| Subdomain | Service URL | Component |
|---|---|---|
| `n8n` | `http://n8n:5678` | n8n |
| `ai` | `http://omniroute:20128` | omniroute |
| `hermes` | `http://hermes:9119` | hermes |
| `chat` | `http://open-webui:8080` | open-webui |
| `monitor` | `http://localhost:3000` | alloy |
| `id` | `http://pocket-id:1411` | pocket-id |
| `dash` | `http://homer:8080` | homer |

<!-- needs: alloy -->
`monitor` is the only route of `oracle-observe` (**Networking → Tunnels → `oracle-observe` → Routes**; after D8 if the dashboard waits
for a connected tunnel); every other row goes on `oracle-stack`. Grafana runs there as a system service on `127.0.0.1:3000`, so the
Service URL is `http://localhost:3000`.
<!-- /needs -->
Only one-level subdomains: the free certificate does not cover `a.b.DOMAIN`. If the dashboard only offers routes once the tunnel is
connected, do this step right after D2.

**Check:** the Routes tab lists every row, and the DNS tab shows each as a CNAME while the root record is unchanged.

### B7. SSL/TLS

In **Domains → Overview → your domain**:

- **SSL/TLS → Overview**: **Full (strict)** (pick *Custom* if *Automatic* is selected).
- **SSL/TLS → Edge Certificates**: **Always Use HTTPS** on, **Minimum TLS Version** 1.2. Leave HSTS off.

**Check:** your blog still opens over `https://`.

### B8. Tunnel alert

**Notifications → Add** (or **Alerts → Create an Alert**) → *Tunnel Health Alert* → your email → **Create**.

**Check:** the alert is listed.

**Next:** [C. Prepare the host](DEPLOY.md#c-prepare-the-host).

---

<!-- needs: omniroute -->
## Optional: API access from outside (service token)

For your own tools (an editor, a chat client, scripts) calling `ai.DOMAIN/v1`; team members use the same token (G1).

1. **Access controls → Service credentials → Service Tokens → Create Service Token** → copy the Client ID and Client Secret (shown once).
2. **Policies → Add a policy**: `service-auth`, Action **Service Auth**, Include → *Service Token* → that token.
3. **Applications** (as in B5): `ai-api`, Subdomain `ai`, Path `v1`, policy `service-auth`.

Callers send `CF-Access-Client-Id`, `CF-Access-Client-Secret` and their own OmniRoute key. Containers on the VM call
`http://omniroute:20128/v1` directly.
<!-- /needs -->

## Optional: security hardening (free WAF)

In **Domains → Overview → your domain → Security**:
<!-- needs: n8n -->
- **Rate limiting rule** (the free plan allows one): expression
  `(http.host eq "n8n.DOMAIN" and starts_with(http.request.uri.path, "/webhook")) or (http.host eq "id.DOMAIN")`, 100 requests per 10 s,
  action *Block* for 10 s.
<!-- /needs -->
- **Custom rule** (geo-block before the login): `(http.host in {"monitor.DOMAIN" "ai.DOMAIN"} and ip.src.country ne "XX")` → *Block*.
  List every admin subdomain you run and use your ISO country code; turn it off while travelling.
- **Bot Fight Mode: off** (**Security → Settings**, *Bot traffic*). It blocks webhooks and API clients, and the free plan has no exceptions.

## Free-plan limits

| Limit | Impact | Component |
|---|---|---|
| 100 MB per upload | Larger files go over Tailscale | always |
| The origin must answer within ~100-125 s (error 524) | Long calls: stream (`stream: true`), reply early, or use Tailscale | always |
| Idle WebSockets may be cut | Reopen the tab | always |
| No raw TCP/UDP, no video or bulk file streaming | Not for game servers, torrents or media | always |
| Zero Trust: 50 users | Plenty for a team of ~15 | always |

<!-- needs: n8n -->
For n8n webhooks that run long, put a *Respond to Webhook* node first and finish the work afterwards.
<!-- /needs -->

## Sources (Cloudflare docs)

- [Create a remotely-managed tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)
- [Self-hosted public application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
  and [application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
- [One-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)
  and [other identity providers](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/generic-oidc/)
- [Policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/policy-management/)
  and [rule groups](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/groups/)
- [Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [Access wildcard and multi-hostname support](https://blog.cloudflare.com/access-wildcard-and-multi-hostname/)
- [Rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/create-zone-dashboard/),
  [custom rules](https://developers.cloudflare.com/waf/custom-rules/)
  and [Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/)
- [SSL/TLS modes](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/),
  [Always Use HTTPS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/)
  and [Minimum TLS version](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/minimum-tls/)
- [Tunnel notifications](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/monitor-tunnels/notifications/)
  and [creating alerts](https://developers.cloudflare.com/notifications/get-started/)
