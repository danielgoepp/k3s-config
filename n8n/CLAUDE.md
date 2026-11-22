# n8n

Guidance for the n8n deployment in this directory (namespace `n8n`).

- **n8n**: Workflow automation (`manifests/n8n-prod.yaml`), exposed via IngressRoute
  - `N8N_EDITOR_BASE_URL` / `N8N_WEBHOOK_URL` must be the public `https://` URL. n8n uses them in its MCP OAuth discovery metadata. Without them it advertises `http://<host>:5678`, which clients can't reach through the ingress.
  - Task runners (external mode) run as the `runners` sidecar in the n8n pod, connecting to the broker on `127.0.0.1:5679`; the broker is not exposed via a Service. The `ghcr.io/n8n-io/runners` tag must match the n8n version. Auth token lives in the gitignored `manifests/n8n-runners-secrets.yaml` (Secret `n8n-runners`)
  - The n8n pod sets `enableServiceLinks: false` so the `n8n` Service doesn't inject `N8N_PORT=tcp://...` into the sidecar
- **Sandbox service** (`manifests/n8n-sandbox-prod.yaml`): code sandbox for the n8n AI assistant, ported from n8n's reference compose file
  - `sandbox-api` (HTTP 8080, gRPC 9090) and `sandbox-runner-1` (privileged Docker-in-Docker, HTTPS 8080, control gRPC 9091); cluster-internal only, no ingress
  - mTLS certs are generated once by the `n8n-sandbox-certs` Job into the `n8n-sandbox-tls-api` / `n8n-sandbox-tls-runner` Secrets (rotation steps are in the manifest header)
  - Shared keys live in the gitignored `n8n-sandbox-secrets.yaml` (Secret `n8n-sandbox`); n8n reads `SANDBOX_API_KEYS` as `N8N_SANDBOX_SERVICE_API_KEY`
  - Service names `sandbox-api` / `sandbox-runner-1` are baked into the cert SANs; don't rename them
  - Sandbox pods set `enableServiceLinks: false` so injected `SANDBOX_API_*` service env vars don't collide with app config
  - API, runner and `SANDBOX_RUNNER_DOCKER_SANDBOX_IMAGE` must stay on the same sandbox release
