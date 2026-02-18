# Deploy SupaClaw to the Cloud

Get SupaClaw running in the cloud in under 10 minutes.

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

## Step 3: Seed `.agents` files (manual)

Use the helper script to seed `workspace/.agents` into the workspace bucket:

```bash
bash ./scripts/seed-agents-storage.sh --env-file supabase/.env --source-dir workspace/.agents
```

Note: this uses the Storage HTTP API (`curl`) as a temporary workaround because
`supabase storage` CLI currently has unstable auth behavior in some setups. Revisit later.

## Step 4: Configure Environment

Copy the template and fill values, see explanation and how to get in [.env.example](supabase/.env.example) file:

```bash
cp supabase/.env.example supabase/.env
```

## Step 5: Deploy Edge Functions

Set secrets and deploy functions:

```bash
supabase secrets set --env-file ./supabase/.env
supabase functions deploy telegram-webhook
supabase functions deploy agent-worker
supabase functions deploy trigger-webhook
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

## Step 7: Set Vault secrets for scheduled cron worker

The worker only calls the LLM when there are due jobs, so this acts as a minimal “heartbeat”.

### Option A: Store secrets in Supabase Vault (Dashboard)

1. In Supabase Dashboard, open **Database** -> **Vault** -> Click **Add secret**.
2. Enter the secret value, and optionally set a unique **name** and description.
3. Save. Use named secrets later from SQL via `vault.decrypted_secrets`.

### Option B: Set Vault secrets via SQL Editor

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<WORKER_SECRET>', 'worker_secret');
select vault.create_secret('<SUPABASE_SERVICE_ROLE_KEY>', 'service_role_key');
```

## Step 8: Hello world!

**That's it.** No daemon setup, no complex config, no VPS, no security headaches.


Docs:
- [Scheduling Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions)
- [Cron](https://supabase.com/docs/guides/cron)
- [pg_net](https://supabase.com/docs/guides/database/extensions/pg_net)
- [Vault](https://supabase.com/docs/guides/database/vault)


# Run SupaClaw locally

## Prerequisites

1. **Supabase CLI installed**: Install via `brew install supabase/tap/supabase`
2. **Deno CLI installed**: Install via `brew install deno`
3. **Docker Desktop App**: Must be running on your machine
4. **AI API Key**: Get one from [Anthropic](https://console.anthropic.com) or [OpenAI](https://platform.openai.com)

Detailed walkthrough documentation (to manually follow along):

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

## Step 3: Seed `.agents` files (manual)

Use the helper script to seed `workspace/.agents` into the local workspace bucket:

```bash
bash ./scripts/seed-agents-storage.sh --env-file supabase/.env.local --source-dir workspace/.agents
```

Note: this uses the Storage HTTP API (`curl`) as a temporary workaround because
`supabase storage` CLI currently has unstable auth behavior in some setups. Revisit later.

## Step 4: Configure Environment

Copy the template and fill values, see explanation and how to get in [.env.example](supabase/.env.example) file:

```bash
cp supabase/.env.example supabase/.env.local
```

## Step 5: Run Edge Functions

Run the functions in a local terminal session:

```bash
cd supaclaw/supabase/functions/_shared
deno install
supabase functions serve \
  --env-file supabase/.env.local \
  --no-verify-jwt
```

## Step 6: Configure Telegram Webhook

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

## Step 7: Set Vault secrets for scheduled cron worker

The worker only calls the LLM when there are due jobs, so this acts as a minimal “heartbeat”.

### Option A: Store secrets in Supabase Vault (Dashboard)

1. In Supabase Dashboard, open **Database** -> **Vault** -> Click **Add secret**.
2. Enter the secret value, and optionally set a unique **name** and description.
3. Save. Use named secrets later from SQL via `vault.decrypted_secrets`.

### Option B: Set Vault secrets via SQL Editor

```sql
---note the docker host. That hostname is reachable from Docker on macOS.
select vault.create_secret('http://host.docker.internal:54321', 'project_url'); 
select vault.create_secret('<WORKER_SECRET>', 'worker_secret');
select vault.create_secret('<SUPABASE_SERVICE_ROLE_KEY>', 'service_role_key');
```

## Step 8: Hello world!

**That's it.** No daemon setup, no complex config, no VPS, no security headaches.