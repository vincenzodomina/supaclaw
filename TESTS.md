## Tests

### Locally Running Project

Verify that the local project is running correctly

#### Run interactive walkthrough

Use the install.sh script to walk interactively through all steps, it discovers already set config and running services and idempotently installs/migrate/starts everything step by step.

```bash
bash ./scripts/install.sh
```

#### Verify Ngrok

```bash
pgrep -af ngrok
# Should print an integer
curl -s http://127.0.0.1:4040/api/tunnels | python3 -m json.tool
# Should print a json config of the running ngrok tunnel with public_url which should match with set telegram webhook
```

#### Verify Functions

After the `supabase functions serve ...` command, the running terminal process should show something like:
```bash
Serving functions on http://127.0.0.1:54321/functions/v1/<function-name>
Using supabase-edge-runtime-1.67.4 (compatible with Deno v1.45.2)
```

To test if functions run correctly, run in another terminal session:

```bash
   set -a; source supabase/.env.local; set +a
   curl -sS -X POST "http://127.0.0.1:54321/functions/v1/agent-worker" \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
     -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
     -H "x-worker-secret: ${WORKER_SECRET}" \
     -d '{}'
```

This should return `{"results":[]}`, if not, check running functions terminal logs for error messages.

This is also great to manually trigger the worker to bypass cron (for debugging)

### Follow local Edge Function runtime logs

```bash
docker logs -f --tail 200 supabase_edge_runtime_supaclaw
# Filter just worker events:
docker logs --tail 500 supabase_edge_runtime_supaclaw 2>&1 | rg '"msg":"worker\.|job\.'
```

#### Inspect queue/worker state from DB

If jobs stay queued, worker is probably not claiming (cron/auth/URL issue).
If jobs flip to running and sit there, worker likely hangs inside processing (LLM, storage, Telegram, etc.).

```sql
select
  id, type, status, attempts, max_attempts,
  run_at, locked_at, locked_by,
  left(coalesce(last_error, ''), 200) as last_error
from jobs
order by run_at asc, id asc
limit 100;
```

#### Check if cron is actually calling the worker

The schema schedules supaclaw-agent-worker via pg_cron + net.http_post.
Run this inside the SQL editor:

```sql
select jobid, jobname, schedule, active
from cron.job
where jobname = 'supaclaw-agent-worker';
--and then
select
  jobid, status, start_time, end_time, return_message
from cron.job_run_details
where jobid = (
  select jobid from cron.job where jobname = 'supaclaw-agent-worker'
)
order by start_time desc
limit 20;
```

Check if return_message shows non-2xx or connection errors
