# k3s-config

Kubernetes manifests and Helm values for a k3s-based home infrastructure running on Proxmox.

Yes, I am aware this is probably stupid and a security risk to me. However, I'm going to do it anyway in the spirit of sharing. I have secured it the best I can, and I'm pretty sure this will be okay. This material does contain information about my private network include domains, hostname and IP addresses. This material does contain some clear text passwords to my UPSd processes. Even with this information, you would need to get access to my private network, and if you got that far, you probalby can already get everything you need.

If you have questions or comment on any of this, please email me.

## Overview

This repository manages a complete home infrastructure stack including:

- **Home Automation**: Home Assistant, Zigbee2MQTT, ESPHome, Mosquitto MQTT
- **Monitoring**: VictoriaMetrics, Telegraf, Grafana, AlertManager
- **Logging**: Graylog, Fluent-bit
- **Infrastructure**: Traefik ingress, MetalLB load balancer, cert-manager
- **Automation**: AWX (Ansible)
- **Services**: Uptime Kuma, Syncthing, n8n, Kopia backup, and more

## Architecture

### Core Components

- **k3s**: Lightweight Kubernetes distribution
- **Traefik**: Ingress controller with custom TCP/UDP entry points
- **MetalLB**: Layer 2 load balancer (IP pool: 10.1.11.51-59)
- **cert-manager**: Automated TLS certificate management via Cloudflare DNS
- **CloudNativePG**: PostgreSQL operator for database workloads

## Repository Structure

```
<service-name>/
├── manifests/          # Raw Kubernetes YAML
└── helm/              # Helm values files
```

Each directory represents a service with environment-specific configurations (`-prod`, `-morgspi`, `-mudderpi`).

## Quick Start

### Prerequisites

- k3s cluster running on Proxmox
- kubectl configured
- Helm 3.x installed

### Deploy a Service

**Using raw manifests:**
```bash
kubectl apply -f <service>/manifests/<service>-prod.yaml
```

**Using Helm:**
```bash
helm upgrade --install <release> <chart-repo>/<chart> \
  -f <service>/helm/<values>-prod.yaml \
  --namespace <namespace> --create-namespace
```

## Notes

- All deployments use `revisionHistoryLimit: 0` to conserve storage
- DNS optimization: `ndots: "1"` in all pod specs
- Storage: Most apps use hostPath volumes at `/mnt/k3s-prod-data/`
- Secrets are gitignored (`*-secrets.yaml`)

## Related Infrastructure

- **Hypervisor**: Proxmox cluster
- **Network**: OPNsense firewall/router
- **Automation**: Ansible playbooks (managed via AWX)
