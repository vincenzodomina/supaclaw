# Deploy SupaClaw

Get SupaClaw running in production in under 10 minutes.

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

## Step 2: Initialize Database

### Option A: Using Dashboard

1. In Supabase dashboard, go to **SQL Editor**
2. Click "New Query"
3. Copy contents of `supabase/schemas/01_schema.sql`
4. Paste and click "Run"

### Option B: Using Supabase CLI

```bash
cd supaclaw
supabase db push --linked
```

## Step 4: Configure Environment

Copy the template and fill values, see explanation and how to get in [.env.example](supabase/.env.example) file:

```bash
cp supabase/.env.example supabase/.env.local
```

## Step 5: Deploy Edge Functions

Set secrets and deploy functions:

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