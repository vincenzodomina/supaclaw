# SupaClaw 

A nano version of OpenClaw that's **Supabase-native** and uses Supabase built-in features to minimize setup.

***The Core Idea***

- **Supabase-first**: Store and host everything in Supabase (DB, files, cron)
- **Minimal setup**: One Supabase project = ready to go
- **Cloud or Self hosting**: Easy and fast cloud setup, private self hosting later

# Quickstart

Get SupaClaw running in under 10 minutes.

## Prerequisites

1. **Supabase CLI installed**: Install via `brew install supabase/tap/supabase`
2. **AI API Key**: Get one from [Anthropic](https://console.anthropic.com) or [OpenAI](https://platform.openai.com)

## Step 1: Run Supabase

```bash
cd supaclaw
supabase start
```

## Step 2: Initialize Database

```bash
supabase db push --local
```

## Step 4: Configure Environment

Copy the template and fill values, see explanation and how to get in [.env.example](supabase/.env.example) file:

```bash
cp supabase/.env.example supabase/.env.local
```

## Step 5: Deploy Edge Functions

Set secrets and deploy functions:

```bash
supabase functions deploy --no-verify-jwt telegram-webhook
supabase functions deploy --no-verify-jwt agent-worker
supabase functions deploy --no-verify-jwt trigger-webhook
```

## Step 6: Configure Telegram Webhook

Set Telegram webhook with a secret token (Telegram will send the header `X-Telegram-Bot-Api-Secret-Token` on every request):

```bash
curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"${SUPABASE_URL}/functions/v1/telegram-webhook\",
    \"secret_token\": \"${TELEGRAM_WEBHOOK_SECRET}\"
  }"
```

Docs: [`setWebhook`](https://core.telegram.org/bots/api#setwebhook)

### Local development with Docker + ngrok

Telegram requires a public HTTPS URL for webhooks. If you run Supabase locally in Docker, expose your local Supabase API (`http://127.0.0.1:54321`) via a tunnel and set the webhook URL to that tunnel.

Use the helper script:

```bash
./scripts/set-local-telegram-webhook.sh
```

The script will:
- load `supabase/.env.local`
- start `ngrok` for port `54321` (if needed)
- call Telegram `setWebhook` with `TELEGRAM_WEBHOOK_SECRET`
- verify with `getWebhookInfo`

Requirements:
- `ngrok` account + cli installed and authenticated (`brew install ngrok && ngrok config add-authtoken <token>`)
- local Supabase running (`supabase start`)

## Step 7: Schedule the Worker (Cron)

The worker only calls the LLM when there are due jobs, so this acts as a minimal “heartbeat”.

In Supabase Dashboard → SQL Editor, run (adapted from Supabase docs):

```sql
-- Store secrets (Vault)
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<WORKER_SECRET>', 'worker_secret');

-- Schedule worker every minute
select cron.schedule(
  'supaclaw-agent-worker',
  '* * * * *',
  $$
  select extensions.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='project_url')
           || '/functions/v1/agent-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name='worker_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
```

Docs:
- [Scheduling Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions)
- [Cron](https://supabase.com/docs/guides/cron)
- [pg_net](https://supabase.com/docs/guides/database/extensions/pg_net)
- [Vault](https://supabase.com/docs/guides/database/vault)

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
- [ ] Connectors (calendar, email, etc.)

## Support

- **Issues**: [GitHub Issues](https://github.com/vincenzodomina/supaclaw/issues)

## Credits

Inspired by [OpenClaw](https://github.com/openclaw/openclaw) - the full-featured self-hosted AI agent.

Built with:
- [Supabase](https://supabase.com) - Backend as a service

## License

MIT License - see [LICENSE](LICENSE) file for details.

---

**SupaClaw**: Less is more. Keep it yours. 🦀