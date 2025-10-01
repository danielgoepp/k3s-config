# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This repository contains Kubernetes manifests and Helm values for a k3s-based home infrastructure deployment running on a Proxmox cluster. The infrastructure includes home automation, monitoring, logging, and various self-hosted services.

## Architecture

### Core Infrastructure Components

**Network & Ingress**
- **Traefik**: Ingress controller deployed as DaemonSet with LoadBalancer service (10.1.11.51)
  - Custom TCP/UDP entry points: MQTT (1883), SMTP (587), Syslog UDP (1514), GELF UDP (12201), Syncthing (22000)
  - Uses Traefik IngressRoute/IngressRouteTCP CRDs for routing
  - Wildcard TLS certificate managed via cert-manager (wildcard-goepp-net-tls)
- **MetalLB**: L2 load balancer providing IP pool 10.1.11.51-10.1.11.59
  - Node selectors target specific k3s nodes (k3s-prod-11, 12, 13, 15)
- **cert-manager**: Manages TLS certificates with Cloudflare DNS challenge

**Storage & Data Persistence**
- Most applications use `hostPath` volumes pointing to `/mnt/k3s-prod-data/<app-name>`
- PostgreSQL databases managed by CloudNativePG (CNPG) operator
- Node affinity pins workloads to specific nodes for data locality

**Monitoring & Logging**
- **VictoriaMetrics**: Time-series database for metrics (InfluxDB v2 compatible endpoint)
- **Telegraf**: Metrics collection from MQTT, SNMP, UPSd
- **Grafana**: Visualization (backed by PostgreSQL, uses VictoriaMetrics datasource plugin)
- **Graylog**: Log aggregation (StatefulSet)
- **AlertManager**: Alert routing

### Home Automation Stack

- **Home Assistant**: Smart home platform with `hostNetwork: true` for mDNS/HomeKit support
- **Zigbee2MQTT**: Multiple instances (zigbee11, zigbee15) with privileged containers for USB access
- **Mosquitto**: MQTT broker with password authentication
- **ESPHome**: ESP device management

### Data Pipeline

1. IoT sensors → MQTT (Mosquitto)
2. Telegraf subscribes to MQTT topics:
   - AirThings/ESP-CO2 sensors
   - Acurite weather stations
   - Zigbee devices (via zigbee11/zigbee15 coordinators)
3. Telegraf processes data (topic parsing, pivoting, Starlark processors)
4. Output to VictoriaMetrics (InfluxDB v2 API) and back to MQTT for processed metrics
5. Grafana visualizes metrics from VictoriaMetrics

### Deployment Patterns

**Multi-Environment Support**
- Manifests use environment suffixes: `-prod`, `-morgspi`, `-mudderpi`
- Separate Helm values files per environment
- Different node selectors and hostPaths per environment

**Common Resource Patterns**
- All Deployments use `revisionHistoryLimit: 0` to minimize storage
- `strategy.type: Recreate` for stateful workloads
- `dnsConfig.options.ndots: "1"` to optimize DNS lookups
- Secrets often inline in manifests (use `.gitignore` to exclude `*-secrets.yaml`)

## Directory Structure

```
<service-name>/
├── manifests/          # Raw Kubernetes YAML manifests
│   └── <service>-<env>.yaml
└── helm/              # Helm values files
    └── <service>-values-<env>.yaml
```

Each top-level directory represents a service/application. Some use raw manifests, others use Helm charts with custom values.

## Common Commands

### Applying Configurations

```bash
# Apply a specific manifest
kubectl apply -f <service>/manifests/<manifest-file>.yaml

# Apply all manifests for a service
kubectl apply -f <service>/manifests/

# Install/upgrade Helm chart
helm upgrade --install <release-name> <chart-repo>/<chart> \
  -f <service>/helm/<values-file>.yaml \
  --namespace <namespace> --create-namespace
```

### Checking Resources

```bash
# Get all resources in a namespace
kubectl get all -n <namespace>

# Check Traefik IngressRoutes
kubectl get ingressroute -A
kubectl get ingressroutetcp -A

# Check MetalLB IP pools
kubectl get ipaddresspools -n metallb-system

# View pod logs
kubectl logs -n <namespace> <pod-name> -f
```

## Key Configuration Details

### DNS Configuration
All pods use `ndots: "1"` to prevent unnecessary DNS queries. Services are accessed via FQDN (e.g., `mosquitto-prod.goepp.net.`).

### Security & Secrets
- Secrets managed via inline YAML (gitignored via `*-secrets.yaml` patterns)
- Mosquitto uses hashed passwords in ConfigMap
- Grafana database credentials in Secrets referenced by environment variables

### Telegraf Data Processing
Telegraf uses advanced processors:
- **Topic parsing**: Extracts device/field tags from MQTT topic hierarchy
- **Pivot**: Transforms field tags into metric fields
- **Starlark**: Custom scripting for temperature conversion, sea level pressure calculation
- **Lookup**: Maps sensor names to target MQTT topics for feedback loops (e.g., remote temperature to Mitsubishi heat pumps)

### Node Selection & Affinity
- Workloads with USB devices (Zigbee2MQTT) must target specific nodes
- MetalLB L2Advertisement uses node selectors for IP pool availability
- Check node labels: `kubectl get nodes --show-labels`

## Integration Points

- **Ansible (AWX)**: Automation platform for infrastructure configuration management
- **Home Assistant → MQTT → Telegraf → VictoriaMetrics**: Smart home metrics pipeline
- **Zigbee2MQTT → MQTT → Home Assistant**: Zigbee device integration
- **cert-manager → Cloudflare**: Automated DNS-01 challenge for wildcard certificates
- **Traefik → Services**: All HTTP/HTTPS ingress routing via IngressRoute CRDs
