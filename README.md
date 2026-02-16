# SupaClaw 

A basic version of OpenClaw but built *entirely* on Supabase built-in features.

***Why?***

Because why not.

I use Supabase daily. I know it. I trust it. I'm already self-hosting it for production projects. It already ships with every primitive needed. 

And because:

- Store and host everything in Supabase, no other Cloud provider or infrastructure needed
- Minimal Dependency: Supabase, Vercel AI SDK and your LLM Provider, thats it
- Production ready, battle tested & secure tech, not re-inventing the wheel
- Cloud or self hosting: Fast cloud setup, port to private self hosting later

# Quickstart

Get SupaClaw running in under 10 minutes.

## Prerequisites

1. **Supabase CLI installed**: Install via `brew install supabase/tap/supabase`
2. **Deno CLI installed**: Install via `brew install deno`
3. **Docker Desktop App**: Must be running on your machine
4. **AI API Key**: Get one from [Anthropic](https://console.anthropic.com) or [OpenAI](https://platform.openai.com)

## Interactive setup walkthrough

Use this script to get guided through all steps. It discovers already set config and running services and idempotently installs/migrates/starts everything step by step.

```bash
bash ./scripts/install.sh
```

In a nutshell this script basically runs:

```bash
supabase start
supabase db push --local
ngrok http 54321
supabase storage cp (agent files)
select vault.create_secret(...)
curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook"
supabase functions serve
```

For a detailed walkthrough documentation (for local or cloud deployment) look at [DEPLOY.md](DEPLOY.md)

**That's it.** No daemon setup, no complex config, no VPS, no security headaches.

## Architecture

For fancy diagrams look into [ARCHITECTURE.md](ARCHITECTURE.md)

Check out [PRD.md](PRD.md) to see how I briefed my coding agents.

For security-minded folks, see [SECURITY.md](SECURITY.md).

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

...are welcome! 

Fork it, tweak it, PR it, repeat!

## Credits

Inspired by [OpenClaw](https://github.com/openclaw/openclaw) - amazing project

Built with: 
- [Supabase](https://supabase.com) - the goat
- [Vercel AI SDK](https://ai-sdk.dev/) - awesome multi provider support

## License

MIT License - see missing [LICENSE](LICENSE) file for details.

---

**SupaClaw**: Keep it yours. 🦀