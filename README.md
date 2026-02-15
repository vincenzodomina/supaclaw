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
2. **Deno CLI installed**: Install via `brew install deno`
3. **Docker Desktop App**: Must be running on your machine
4. **AI API Key**: Get one from [Anthropic](https://console.anthropic.com) or [OpenAI](https://platform.openai.com)

## Interactive setup walkthrough

Use this script to get guided through all steps. It discovers already set config and running services and idempotently installs/migrate/starts everything step by step.

```bash
bash ./scripts/install.sh
```

In a nutshell this script actively runs:

```bash
supabase start
supabase db push --local
ngrok http 54321
select vault.create_secret(...)
curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook"
supabase functions serve
```

For a detailed walkthrough documentation (for local or cloud deployment) look at [DEPLOY.md](DEPLOY.md)

**That's it.** No daemon setup, no complex config, no VPS, no security headaches.

## Roadmap

### Done (v0.1.0)
- ✅ Core architecture
- ✅ Supabase integration (schema + jobs)
- ✅ Telegram webhook + worker
- ✅ Memory tables + hybrid search (FTS + pgvector)
- ✅ Tools (read/write/list/edit)
- ✅ Skills

### Missing (v0.2.0)
- [ ] More channels (Slack, Whatsapp, ..)
- [ ] More tools (web/task/search)
- [ ] Sandbox shell execution
- [ ] Self access via Github
- [ ] Connectors (calendar, email, etc.)
- [ ] Web chat UI

## Support

- **Issues**: [GitHub Issues](https://github.com/vincenzodomina/supaclaw/issues)

## Contributions

Are welcome! Fork it, tweak it, PR it!

## Credits

Inspired by [OpenClaw](https://github.com/openclaw/openclaw) - amazing project!
Built with: 
- [Supabase](https://supabase.com) - Because we love it
- [Vercel AI SDK](https://ai-sdk.dev/) - Awesome multi provider support

## License

MIT License - see [LICENSE](LICENSE) file for details.

---

**SupaClaw**: Less is more. Keep it yours. 🦀