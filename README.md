# SupaClaw 

A nano version of OpenClaw that's **Supabase-native** and uses Supabase built-in features to minimize setup and code to maintain.

***Why?***

Because i love supabase. And because:

- **Supabase-only**: Store and host everything in Supabase (DB, files, cron, API)
- **Minimal Dependency**: Supabase + LLM Provider (if not self hosting), no other Cloud provider or infrastructure needed
- **Production ready**: Battle tested & secure tech, not re-inventing the wheel
- **Cloud & Self hosting**: Easy and fast cloud setup, port to private self hosting later

# Quickstart

Get SupaClaw running in under 10 minutes.

## Prerequisites

1. **Supabase CLI installed**: Install via `brew install supabase/tap/supabase`
2. **Docker Desktop App**: Must be running on your machine
3. **AI API Key**: Get one from [Anthropic](https://console.anthropic.com) or [OpenAI](https://platform.openai.com)

## Step 1: Run Supabase

```bash
cd supaclaw
supabase start
```

## Step 2: Initialize Database

This will migrate and seed the database schema to the running Postgres instance in your local docker

```bash
supabase db push --local
```

## Step 3: Configure Environment

Copy the template and fill values, see explanation and how to get in [.env.example](supabase/.env.example) file:

```bash
cp supabase/.env.example supabase/.env.local
```

## Step 4: Run Edge Functions

Run the functions in a local terminal session:

```bash
cd supaclaw/supabase/functions/_shared
deno install
supabase functions serve \
  --env-file supabase/.env.local \
  --import-map supabase/functions/_shared/deno.json \
  --no-verify-jwt
```

## Step 5: Configure Telegram Webhook

Telegram requires a public HTTPS URL for webhooks. If you run Supabase locally in Docker, expose your local Supabase API (`http://127.0.0.1:54321`) via a tunnel and set the webhook URL to that tunnel.

Use the helper script to achieve this with ngrok:

```bash
./scripts/set-local-telegram-webhook.sh
```

The script will:
- start `ngrok` for port `54321` using `supabase/.env.local` secrets
- call Telegram `setWebhook` with `TELEGRAM_WEBHOOK_SECRET` and verify with `getWebhookInfo`

Requirements:
- `ngrok` account + cli installed and authenticated (`brew install ngrok && ngrok config add-authtoken <token>`)

## Step 6: Set Vault secrets for scheduled cron worker

The worker only calls the LLM when there are due jobs, so this acts as a minimal “heartbeat”.

### Option A: Store secrets in Supabase Vault (Dashboard)

1. In Supabase Dashboard, open **Database** -> **Vault** -> Click **Add secret**.
2. Enter the secret value, and optionally set a unique **name** and description.
3. Save. Use named secrets later from SQL via `vault.decrypted_secrets`.

### Option B: Set Vault secrets via SQL Editor

```sql
select vault.create_secret('http://127.0.0.1:54323', 'project_url');
select vault.create_secret('<WORKER_SECRET>', 'worker_secret');
select vault.create_secret('<SUPABASE_SERVICE_ROLE_KEY>', 'service_role_key');
```

## Step 7: Hello world!

**That's it.** No daemon setup, no complex config, no VPS, no security headaches.

## Roadmap

### Current (v0.1.0)
- ✅ Core architecture
- ✅ Supabase integration (schema + jobs)
- ✅ Telegram webhook + worker
- ✅ Memory tables + hybrid search (FTS + pgvector)
- ✅ Tools (read/write/list/edit)
- ✅ Skills

### Planned (v0.2.0)
- [ ] Slack channel
- [ ] WhatsApp channel
- [ ] Web chat UI
- [ ] Tools (web/task/search)
- [ ] Sandbox shell execution
- [ ] Connectors (calendar, email, etc.)

## Support

- **Issues**: [GitHub Issues](https://github.com/vincenzodomina/supaclaw/issues)

## Credits

Inspired by [OpenClaw](https://github.com/openclaw/openclaw) - amazing project!
Built with: 
- [Supabase](https://supabase.com) - Because we love it
- [Vercel AI SDK](https://ai-sdk.dev/) - Awesome multi provider support

## License

MIT License - see [LICENSE](LICENSE) file for details.

---

**SupaClaw**: Less is more. Keep it yours. 🦀