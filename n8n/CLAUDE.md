# n8n

Guidance for the n8n deployment in this directory (namespace `n8n`).

- **n8n**: Workflow automation (`manifests/n8n-prod.yaml`), exposed via IngressRoute
  - `N8N_EDITOR_BASE_URL` / `N8N_WEBHOOK_URL` must be the public `https://` URL. n8n uses them in its MCP OAuth discovery metadata. Without them it advertises `http://<host>:5678`, which clients can't reach through the ingress.
  - Task runners (external mode) run as the `runners` sidecar in the n8n pod, connecting to the broker on `127.0.0.1:5679`; the broker is not exposed via a Service. The `ghcr.io/n8n-io/runners` tag must match the n8n version. Auth token lives in the gitignored `manifests/n8n-runners-secrets.yaml` (Secret `n8n-runners`)
  - `N8N_RUNNERS_TASK_TIMEOUT` must be set on both containers: the runner enforces it itself and defaults to 60s, ignoring the n8n container's value
  - The n8n pod sets `enableServiceLinks: false` so the `n8n` Service doesn't inject `N8N_PORT=tcp://...` into the sidecar
  - `N8N_ENCRYPTION_KEY` and `N8N_USER_MANAGEMENT_JWT_SECRET` come from the gitignored `manifests/n8n-core-secrets.yaml` (Secret `n8n-core`). The key must match `encryptionKey` in `/home/node/.n8n/config`, or n8n refuses to start
  - Never just swap the encryption key: n8n 2.x wraps internal keys in the `deployment_key` table (signing, data-encryption, OAuth/JWE) with it and crashes on startup if they can't be unwrapped. To rotate it, stop n8n, back up the data folder, run `scripts/rotate-encryption-key.js` (dry run first, then `--apply`) against the database using the n8n image, update the config file, then start n8n. The script targets n8n 2.49's storage format; re-check it against the n8n code before using it on a newer version
- **MCP server**: `https://n8n-prod.goepp.net/mcp-server/http` (OAuth). Instance-level MCP access is enabled in the UI (stored in the DB, not the manifest)
  - Workflows created through MCP are exposed automatically; workflows built in the editor need their per-workflow MCP toggle turned on before MCP clients can see them
  - The "auto-expose new workflows" setting exists but is hidden behind a feature flag in the UI; per-workflow toggles are the intended approach here
- **AI assistant (Instance AI)**: model API key comes from the gitignored `manifests/n8n-instance-ai-secrets.yaml` (Secret `n8n-instance-ai`, optional ref). The default model is `anthropic/claude-opus-5-5`; override with `N8N_INSTANCE_AI_MODEL` (and `N8N_INSTANCE_AI_MODEL_URL` for other endpoints). Web search uses SearXNG; code execution uses the sandbox service
- **Sandbox service** (`manifests/n8n-sandbox-prod.yaml`): code sandbox for the n8n AI assistant, ported from n8n's reference compose file
  - `sandbox-api` (HTTP 8080, gRPC 9090) and `sandbox-runner-1` (privileged Docker-in-Docker, HTTPS 8080, control gRPC 9091); cluster-internal only, no ingress
  - mTLS certs are generated once by the `n8n-sandbox-certs` Job into the `n8n-sandbox-tls-api` / `n8n-sandbox-tls-runner` Secrets (rotation steps are in the manifest header)
  - Shared keys live in the gitignored `n8n-sandbox-secrets.yaml` (Secret `n8n-sandbox`); n8n reads `SANDBOX_API_KEYS` as `N8N_SANDBOX_SERVICE_API_KEY`
  - Service names `sandbox-api` / `sandbox-runner-1` are baked into the cert SANs; don't rename them
  - Sandbox pods set `enableServiceLinks: false` so injected `SANDBOX_API_*` service env vars don't collide with app config
  - API, runner and `SANDBOX_RUNNER_DOCKER_SANDBOX_IMAGE` must stay on the same sandbox release
- **SearXNG** (`manifests/n8n-searxng-prod.yaml`): web-search backend for the AI assistant, reached by n8n at `http://searxng:8080` (`N8N_INSTANCE_AI_SEARXNG_URL`); cluster-internal only, no ingress
  - `settings.yml` and `limiter.toml` come from the `searxng-settings` ConfigMap; the `json` format must stay enabled for n8n's queries. Limiter is off; Tor engines (ahmia, torch) are removed
  - ConfigMap files are `subPath` mounts, which don't auto-update: bump the `n8n.goepp.net/settings-rev` pod annotation when editing them
  - `SEARXNG_SECRET` and the optional `SEARXNG_CONTACT_URL` (required by the wikipedia, wikidata and openstreetmap engines) live in the gitignored `manifests/n8n-searxng-secrets.yaml` (Secret `n8n-searxng`)
  - "X-Forwarded-For nor X-Real-IP header is set!" is logged once per worker because n8n calls SearXNG directly; harmless with the limiter off
  - The pod sets `enableServiceLinks: false`: the injected `SEARXNG_PORT=tcp://...` would override SearXNG's listen port
