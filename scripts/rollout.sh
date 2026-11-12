#!/bin/sh
# Restarts the deployment so it pulls the new :latest, then waits for it. Runs from image.yml, which
# passes the secrets and variables through the environment. Never turn on `set -x` here: it would
# print the token.
#
# KUBE_DEPLOY_TOKEN        service account token; without it the rollout is skipped
# KUBE_DEPLOY_CA_CERT      CA certificate of the cluster API server
# KUBE_DEPLOY_SERVER       API server address, for example https://kubernetes.example.com:6443
# KUBE_DEPLOY_NAMESPACE    namespace of the deployment (default: agent-artifacts)
# KUBE_DEPLOY_DEPLOYMENT   name of the deployment (default: agent-artifacts)
set -eu

# These only exist once the cluster has been set up for it.
if [ -z "${KUBE_DEPLOY_TOKEN:-}" ]; then
  echo "::notice::Rollout skipped: KUBE_DEPLOY_TOKEN is not set"
  exit 0
fi

if [ -z "${KUBE_DEPLOY_CA_CERT:-}" ]; then
  echo "::error::KUBE_DEPLOY_TOKEN is set, but KUBE_DEPLOY_CA_CERT is not"
  exit 1
fi

if [ -z "${KUBE_DEPLOY_SERVER:-}" ]; then
  echo "::error::KUBE_DEPLOY_TOKEN is set, but KUBE_DEPLOY_SERVER is not"
  exit 1
fi

namespace="${KUBE_DEPLOY_NAMESPACE:-agent-artifacts}"
deployment="${KUBE_DEPLOY_DEPLOYMENT:-agent-artifacts}"

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
  - name: deploy-cluster
    cluster:
      server: "$KUBE_DEPLOY_SERVER"
      certificate-authority: "$ca_file"
users:
  - name: github-deployer
    user:
      token: "$KUBE_DEPLOY_TOKEN"
contexts:
  - name: rollout
    context:
      cluster: deploy-cluster
      user: github-deployer
      namespace: "$namespace"
current-context: rollout
EOF

kubectl rollout restart "deploy/$deployment"
kubectl rollout status "deploy/$deployment" --timeout=5m
