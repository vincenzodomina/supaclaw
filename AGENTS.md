# Docs

Look through the /docs folder to learn details about:
- Architecture
- Product Requirements
- Security
- Deployment
- Tests
- Philosophy and Goals of this Project (Blog Post)

# Tech stack

## Supabase

Docs:
https://supabase.com/docs
Guides: 
https://supabase.com/docs/guides/platform
Best Practices:
https://supabase.com/blog/postgres-best-practices-for-ai-agents
Official skills from supabase to guide development with supabase:
https://github.com/supabase/agent-skills

Install skill if not already installed:
```bash
npx skills add https://github.com/supabase/agent-skills --skill supabase-postgres-best-practices
```

## Vercel AI SDK

Repository: https://github.com/vercel/ai
Documentation: https://ai-sdk.dev/docs

***Docs and Source Code in node_modules***
Once you've installed the ai package, you already have the full AI SDK documentation and source code available locally inside node_modules. Your coding agent can read these directly — no internet access required. Install the ai package if you haven't already:

```bash
npm add ai
```

After installation, your agent can reference the bundled source code and documentation at paths like:

node_modules/ai/src/              # Full source code organized by module
node_modules/ai/docs/             # Official documentation with examples

This means your agent can look up accurate API signatures, implementations, and usage examples directly from the installed package — ensuring it always uses the version of the SDK that's actually installed in your project.

## Vercel Chat SDK

Add the skill if not installed already to get access to latest docs and best practices regarding the implementation of channel providers:

```bash
npx skills add vercel/chat
```

