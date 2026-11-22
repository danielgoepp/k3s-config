# n8n

Guidance for the n8n deployment in this directory (namespace `n8n`).

- **n8n**: Workflow automation (`manifests/n8n-prod.yaml`), exposed via IngressRoute
- **Sandbox service** (`manifests/n8n-sandbox-prod.yaml`): code sandbox for the n8n AI assistant, ported from n8n's reference compose file
  - `sandbox-api` (HTTP 8080, gRPC 9090) and `sandbox-runner-1` (privileged Docker-in-Docker, HTTPS 8080, control gRPC 9091); cluster-internal only, no ingress
  - mTLS certs are generated once by the `n8n-sandbox-certs` Job into the `n8n-sandbox-tls-api` / `n8n-sandbox-tls-runner` Secrets (rotation steps are in the manifest header)
  - Shared keys live in the gitignored `n8n-sandbox-secrets.yaml` (Secret `n8n-sandbox`); n8n reads `SANDBOX_API_KEYS` as `N8N_SANDBOX_SERVICE_API_KEY`
  - Service names `sandbox-api` / `sandbox-runner-1` are baked into the cert SANs; don't rename them
  - Sandbox pods set `enableServiceLinks: false` so injected `SANDBOX_API_*` service env vars don't collide with app config
  - API, runner and `SANDBOX_RUNNER_DOCKER_SANDBOX_IMAGE` must stay on the same sandbox release
