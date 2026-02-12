# SupaClaw 

A nano version of OpenClaw that's **Supabase-native** and uses Supabase built-in features to minimize setup.

***The Core Idea***

- **Supabase-first**: Store and host everything in Supabase (DB, files, cron)
- **Minimal setup**: One Supabase project = ready to go
- **Cloud or Self hosting**: Easy and fast cloud setup, private self hosting later

# Quickstart

Get SupaClaw running in under 10 minutes.

## Prerequisites

1. **Supabase Account**: Sign up at [supabase.com](https://supabase.com)
2. **Supabase CLI installed**: Install via `brew install supabase/tap/supabase`
3. **AI API Key**: Get one from [Anthropic](https://console.anthropic.com) or [OpenAI](https://platform.openai.com)

## Step 1: Set Up Supabase Project

### Option A: Using Supabase Dashboard (Easiest)

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

### Using Dashboard

1. In Supabase dashboard, go to **SQL Editor**
2. Click "New Query"
3. Copy contents of `supabase/migrations/001_initial_schema.sql`
4. Paste and click "Run"

### Using locally via CLI

```bash
cd supaclaw
supabase db push --linked
# OR local docker
supabase db push --local
```

## Step 3: Create Storage Buckets

## Step 4: Configure Environment

## Step 5: Configure Channels

**That's it.** No daemon setup, no complex config, no VPS, no security headaches.

## Roadmap

### Current (v0.1.0)
- ✅ Core architecture
- ✅ Supabase integration
- ✅ Basic tools (read/write/web)
- ✅ Telegram channel
- ✅ Deployment configs

### Planned (v0.2.0)
- [ ] Slack channel
- [ ] WhatsApp channel
- [ ] Web chat UI
- [ ] Memory improvements (semantic search)
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