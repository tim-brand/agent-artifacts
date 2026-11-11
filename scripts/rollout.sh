#!/bin/sh
# Restarts the deployment so it pulls the new :latest, then waits for it. Runs from image.yml, which
# passes the secrets through the environment. Never turn on `set -x` here: it would print the token.
set -eu

# These secrets only exist once the infrastructure has been applied.
if [ -z "${KUBE_DEPLOY_TOKEN:-}" ]; then
  echo "::notice::Rollout skipped: KUBE_DEPLOY_TOKEN is not set"
  exit 0
fi

if [ -z "${KUBE_DEPLOY_CA_CERT:-}" ]; then
  echo "::error::KUBE_DEPLOY_TOKEN is set, but KUBE_DEPLOY_CA_CERT is not"
  exit 1
fi

# The token goes in a file that only this user can read, because other processes on a machine can
# see a command line.
umask 077
ca_file="$RUNNER_TEMP/ca.crt"
printf '%s\n' "$KUBE_DEPLOY_CA_CERT" > "$ca_file"

export KUBECONFIG="$RUNNER_TEMP/kubeconfig"
trap 'rm -f "$KUBECONFIG"' EXIT
cat > "$KUBECONFIG" <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: talos
    cluster:
      server: https://talos.stinosa.com:6443
      certificate-authority: "$ca_file"
users:
  - name: github-deployer
    user:
      token: "$KUBE_DEPLOY_TOKEN"
contexts:
  - name: rollout
    context:
      cluster: talos
      user: github-deployer
      namespace: agent-artifacts
current-context: rollout
EOF

kubectl rollout restart deploy/agent-artifacts
kubectl rollout status deploy/agent-artifacts --timeout=5m
