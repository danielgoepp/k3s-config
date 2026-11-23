#!/usr/bin/env bash
# Sync pgAdmin's server list and pgpass with the CNPG clusters in the cluster.
#
# Builds servers.json and a pgpass file from every clusters.postgresql.cnpg.io
# resource (using each cluster's <name>-app secret), then:
#   1. writes them to the ConfigMap / Secret the pgAdmin deployment mounts,
#      so they survive pod restarts, and
#   2. loads them into the running pgAdmin pod (no restart needed).
#
# Usage: ./sync-cnpg-servers.sh [--dry-run]
#   --dry-run   print the generated servers.json and exit
#
# Requires: kubectl (with cluster-admin-ish context), jq
set -euo pipefail

NS="${PGADMIN_NAMESPACE:-pgadmin}"
DEPLOY="${PGADMIN_DEPLOYMENT:-pgadmin-pgadmin4}"
SERVERS_CM="${PGADMIN_SERVERS_CONFIGMAP:-pgadmin-cnpg-servers}"
PGPASS_SECRET="${PGADMIN_PGPASS_SECRET:-pgpassfile}"
PGPASS_PATH="/var/lib/pgadmin/pgpass"   # must match env.pgpassfile in the Helm values
GROUP="${PGADMIN_GROUP:-CNPG}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

kubectl get clusters.postgresql.cnpg.io -A -o json > "$tmp/clusters.json"

# servers.json — one entry per CNPG cluster, pointed at its -rw service
jq --arg group "$GROUP" --arg passfile "$PGPASS_PATH" '
  [.items | sort_by(.metadata.namespace, .metadata.name)[] | {
    Name: .metadata.name,
    Group: $group,
    Host: "\(.metadata.name)-rw.\(.metadata.namespace).svc.cluster.local",
    Port: 5432,
    MaintenanceDB: (.spec.bootstrap.initdb.database // "app"),
    Username: (.spec.bootstrap.initdb.owner // "app"),
    SSLMode: "prefer",
    PassFile: $passfile
  }]
  | {Servers: (to_entries | map({key: (.key + 1 | tostring), value: .value}) | from_entries)}
' "$tmp/clusters.json" > "$tmp/servers.json"

if [[ "${1:-}" == "--dry-run" ]]; then
  cat "$tmp/servers.json"
  exit 0
fi

# pgpass — built from each cluster's <name>-app secret, using the FQDN host
: > "$tmp/pgpass"
jq -r '.items[] | "\(.metadata.namespace) \(.metadata.name)"' "$tmp/clusters.json" |
while read -r ns name; do
  if ! kubectl get secret -n "$ns" "$name-app" -o json > "$tmp/app.json" 2>/dev/null; then
    echo "warn: no secret $ns/$name-app, skipping pgpass entry" >&2
    continue
  fi
  jq -r --arg host "$name-rw.$ns.svc.cluster.local" '
    .data | map_values(@base64d)
    | "\($host):5432:\(.dbname):\(.username):\(.password)"
  ' "$tmp/app.json" >> "$tmp/pgpass"
done

# 1. Persist to the objects the deployment mounts
kubectl create configmap "$SERVERS_CM" -n "$NS" \
  --from-file=servers.json="$tmp/servers.json" --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic "$PGPASS_SECRET" -n "$NS" \
  --from-file=pgpassfile="$tmp/pgpass" --dry-run=client -o yaml | kubectl apply -f -

# 2. Load into the running pod
email=$(kubectl get deploy -n "$NS" "$DEPLOY" -o json |
  jq -r '.spec.template.spec.containers[0].env[] | select(.name=="PGADMIN_DEFAULT_EMAIL") | .value')

kubectl exec -i -n "$NS" "deploy/$DEPLOY" -c pgadmin4 -- \
  sh -c "umask 077 && cat > $PGPASS_PATH" < "$tmp/pgpass"
kubectl exec -i -n "$NS" "deploy/$DEPLOY" -c pgadmin4 -- \
  sh -c "cat > /tmp/servers.json && /venv/bin/python3 /pgadmin4/setup.py load-servers /tmp/servers.json --user '$email' --replace && rm -f /tmp/servers.json" \
  < "$tmp/servers.json"

echo "Synced $(jq '.Servers | length' "$tmp/servers.json") CNPG server(s) to pgAdmin:"
jq -r '.Servers[] | "  - \(.Name) (\(.Host))"' "$tmp/servers.json"
