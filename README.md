# SupaClaw 

A nano version of OpenClaw that's **Supabase-native** and uses Supabase built-in features to minimize setup.

***The Core Idea***

- **Supabase-first**: Store and host everything in Supabase (DB, files, cron)
- **Minimal setup**: One Supabase project = ready to go
- **Cloud or Self hosting**: Easy and fast cloud setup, private self hosting later

# Quickstart

Get SupaClaw running in under 10 minutes.

## Prerequisites

1. **Supabase Account**: (Optional) Sign up at [supabase.com](https://supabase.com)
2. **Supabase CLI installed**: Install via `brew install supabase/tap/supabase`
3. **AI API Key**: Get one from [Anthropic](https://console.anthropic.com) or [OpenAI](https://platform.openai.com)

## Step 1: Set Up Supabase Project

### Option A: Using Supabase Dashboard

1. Go to [app.supabase.com](https://app.supabase.com)
2. Click "New Project"
3. Fill in:
   - **Name**: `supaclaw`
   - **Database Password**: Generate a strong password (save it!)
   - **Region**: Choose closest to you
4. Wait 2 minutes for provisioning
5. Go to **Project Settings** → **API**
   - Copy your `URL` (looks like `https://xxx.supabase.co`)
   - Copy your `anon` key
   - Copy your `service_role` key (under "Service role")

### Option B: Using Supabase CLI

```bash
supabase login
supabase projects create supaclaw
supabase link --project-ref <your-project-id>
# OR Self hosting locally
supabase init
supabase start
```

### Option C: Running Locally

```bash
supabase start
```

## Step 2: Initialize Database

### Using Dashboard

1. In Supabase dashboard, go to **SQL Editor**
2. Click "New Query"
3. Copy contents of `supabase/schemas/01_schema.sql`
4. Paste and click "Run"

### Using Supabase CLI locally

```bash
cd supaclaw
supabase db push --linked
# OR local docker
supabase db push --local
```

## Step 3: Create Storage Buckets

Create a **private** bucket named `workspace`.

Inside that bucket, SupaClaw expects:

```text
.agents/AGENTS.md
.agents/SOUL.md
.agents/agents/<slug>/**
.agents/tools/<slug>/**
.agents/skills/<slug>/**
.agents/workflows/<slug>/**
```

## Step 4: Configure Environment

Copy the template and fill in values:

```bash
cp supabase/.env.example supabase/.env.local
```

At minimum, set:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_ALLOWED_USER_ID` (required; webhook fails closed if missing)
- `WORKER_SECRET`
- `TRIGGER_WEBHOOK_SECRET` (required if you want to use `trigger-webhook`)
- One LLM provider:
  - `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`)
  - OR `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_MODEL`)

## Step 5: Deploy Edge Functions

Deploy functions and set secrets:

```bash
supabase secrets set --env-file ./supabase/.env.local
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

### Planned (v0.2.0)
- [ ] Slack channel
- [ ] WhatsApp channel
- [ ] Web chat UI
- [ ] Tools (read/write/web)
- [ ] More tools (calendar, email, etc.)

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