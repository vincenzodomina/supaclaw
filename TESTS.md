## Tests

### Locally Running Project

Verify that the local project is running correctly

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

