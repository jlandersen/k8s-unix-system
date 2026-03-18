#!/usr/bin/env bash
set -euo pipefail

CLUSTER_NAME="k8s-unix-system"

echo "🦖 Setting up kind cluster: $CLUSTER_NAME"

# Create cluster if it doesn't exist
if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
  echo "Cluster already exists, skipping creation"
else
  kind create cluster --name "$CLUSTER_NAME" --wait 60s
fi

kubectl cluster-info --context "kind-${CLUSTER_NAME}"

# Create some namespaces
for ns in frontend backend database monitoring logging; do
  kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f -
done

# Deploy sample workloads across namespaces
kubectl apply -f - <<'EOF'
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: frontend
spec:
  replicas: 4
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: nginx
        image: nginx:alpine
        resources:
          requests:
            cpu: 10m
            memory: 16Mi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-gateway
  namespace: frontend
spec:
  replicas: 2
  selector:
    matchLabels:
      app: api-gateway
  template:
    metadata:
      labels:
        app: api-gateway
    spec:
      containers:
      - name: nginx
        image: nginx:alpine
        resources:
          requests:
            cpu: 10m
            memory: 16Mi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: users-api
  namespace: backend
spec:
  replicas: 3
  selector:
    matchLabels:
      app: users-api
  template:
    metadata:
      labels:
        app: users-api
    spec:
      containers:
      - name: nginx
        image: nginx:alpine
        resources:
          requests:
            cpu: 10m
            memory: 16Mi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders-api
  namespace: backend
spec:
  replicas: 2
  selector:
    matchLabels:
      app: orders-api
  template:
    metadata:
      labels:
        app: orders-api
    spec:
      containers:
      - name: nginx
        image: nginx:alpine
        resources:
          requests:
            cpu: 10m
            memory: 16Mi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-worker
  namespace: backend
spec:
  replicas: 2
  selector:
    matchLabels:
      app: payments-worker
  template:
    metadata:
      labels:
        app: payments-worker
    spec:
      containers:
      - name: nginx
        image: nginx:alpine
        resources:
          requests:
            cpu: 10m
            memory: 16Mi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
  namespace: database
spec:
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
      - name: postgres
        image: postgres:16-alpine
        env:
        - name: POSTGRES_PASSWORD
          value: devonly
        - name: PGDATA
          value: /var/lib/postgresql/data/pgdata
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
        resources:
          requests:
            cpu: 10m
            memory: 32Mi
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: postgres-data
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
  namespace: database
spec:
  replicas: 2
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
      - name: redis
        image: redis:7-alpine
        volumeMounts:
        - name: data
          mountPath: /data
        resources:
          requests:
            cpu: 10m
            memory: 16Mi
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: redis-data
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: prometheus
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: prometheus
  template:
    metadata:
      labels:
        app: prometheus
    spec:
      containers:
      - name: prom
        image: nginx:alpine
        volumeMounts:
        - name: data
          mountPath: /prometheus
        resources:
          requests:
            cpu: 10m
            memory: 16Mi
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: prometheus-data
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: grafana
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: grafana
  template:
    metadata:
      labels:
        app: grafana
    spec:
      containers:
      - name: grafana
        image: nginx:alpine
        volumeMounts:
        - name: data
          mountPath: /var/lib/grafana
        resources:
          requests:
            cpu: 10m
            memory: 16Mi
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: grafana-data
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fluentd
  namespace: logging
spec:
  replicas: 3
  selector:
    matchLabels:
      app: fluentd
  template:
    metadata:
      labels:
        app: fluentd
    spec:
      containers:
      - name: fluentd
        image: nginx:alpine
        resources:
          requests:
            cpu: 10m
            memory: 16Mi
---
# A pod that will crash (for visual variety)
apiVersion: v1
kind: Pod
metadata:
  name: crasher
  namespace: backend
spec:
  containers:
  - name: crash
    image: busybox
    command: ["sh", "-c", "exit 1"]
    resources:
      requests:
        cpu: 10m
        memory: 8Mi
  restartPolicy: Always
---
# Pod with bad image → ImagePullBackOff warnings
apiVersion: v1
kind: Pod
metadata:
  name: bad-image
  namespace: backend
  labels:
    app: bad-image
spec:
  containers:
  - name: broken
    image: nginx:does-not-exist-99
    resources:
      requests:
        cpu: 10m
        memory: 8Mi
---
# Pod referencing missing configmap → CreateContainerConfigError warnings
apiVersion: v1
kind: Pod
metadata:
  name: missing-config
  namespace: monitoring
  labels:
    app: missing-config
spec:
  containers:
  - name: app
    image: nginx:alpine
    envFrom:
    - configMapRef:
        name: does-not-exist
    resources:
      requests:
        cpu: 10m
        memory: 8Mi
---
# Deployment requesting impossible resources → FailedScheduling warnings
apiVersion: apps/v1
kind: Deployment
metadata:
  name: memory-hog
  namespace: logging
spec:
  replicas: 1
  selector:
    matchLabels:
      app: memory-hog
  template:
    metadata:
      labels:
        app: memory-hog
    spec:
      containers:
      - name: hog
        image: nginx:alpine
        resources:
          requests:
            cpu: 10m
            memory: 128Gi
---
# ── Services ────────────────────────────────────────────────────
apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: frontend
spec:
  selector:
    app: web
  ports:
  - port: 80
    targetPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: api-gateway
  namespace: frontend
spec:
  selector:
    app: api-gateway
  ports:
  - port: 80
    targetPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: users-api
  namespace: backend
spec:
  selector:
    app: users-api
  ports:
  - port: 80
    targetPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: orders-api
  namespace: backend
spec:
  selector:
    app: orders-api
  ports:
  - port: 80
    targetPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: database
spec:
  selector:
    app: postgres
  ports:
  - port: 5432
    targetPort: 5432
---
apiVersion: v1
kind: Service
metadata:
  name: redis
  namespace: database
spec:
  selector:
    app: redis
  ports:
  - port: 6379
    targetPort: 6379
---
apiVersion: v1
kind: Service
metadata:
  name: prometheus
  namespace: monitoring
spec:
  selector:
    app: prometheus
  ports:
  - port: 9090
    targetPort: 9090
---
apiVersion: v1
kind: Service
metadata:
  name: grafana
  namespace: monitoring
spec:
  selector:
    app: grafana
  ports:
  - port: 3000
    targetPort: 3000
---
# ── PVCs ────────────────────────────────────────────────────────
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: database
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 5Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: redis-data
  namespace: database
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: prometheus-data
  namespace: monitoring
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 10Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: grafana-data
  namespace: monitoring
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 512Mi
---
# Orphaned PVC — not mounted by any pod, shows disconnected storage in the visualization
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: old-backup
  namespace: backend
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 20Gi
---
# ── Ingresses ───────────────────────────────────────────────────
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: frontend-ingress
  namespace: frontend
spec:
  rules:
  - host: app.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: web
            port:
              number: 80
      - path: /api
        pathType: Prefix
        backend:
          service:
            name: api-gateway
            port:
              number: 80
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: backend-ingress
  namespace: backend
spec:
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /users
        pathType: Prefix
        backend:
          service:
            name: users-api
            port:
              number: 80
      - path: /orders
        pathType: Prefix
        backend:
          service:
            name: orders-api
            port:
              number: 80
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: monitoring-ingress
  namespace: monitoring
spec:
  rules:
  - host: monitoring.example.com
    http:
      paths:
      - path: /prometheus
        pathType: Prefix
        backend:
          service:
            name: prometheus
            port:
              number: 9090
      - path: /grafana
        pathType: Prefix
        backend:
          service:
            name: grafana
            port:
              number: 3000
EOF

echo ""
echo "⏳ Waiting for pods to be ready..."
kubectl get deployments --all-namespaces --no-headers -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name \
  | grep -v memory-hog \
  | while read -r ns name; do
      kubectl wait --for=condition=available deployment/"$name" -n "$ns" --timeout=120s 2>/dev/null || true
    done

# ── Restricted user: monitoring-viewer ─────────────────────────
VIEWER_NS="monitoring"
VIEWER_SA="monitoring-viewer"
KUBECONFIG_OUT="$(cd "$(dirname "$0")" && pwd)/monitoring-viewer.kubeconfig"

echo ""
echo "🔒 Creating restricted user '${VIEWER_SA}' scoped to namespace '${VIEWER_NS}'..."

kubectl apply -f - <<'RBAC'
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: monitoring-viewer
  namespace: monitoring
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: namespace-viewer
  namespace: monitoring
rules:
- apiGroups: [""]
  resources: ["pods", "services", "endpoints", "configmaps"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["apps"]
  resources: ["deployments", "replicasets", "statefulsets", "daemonsets"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["batch"]
  resources: ["jobs", "cronjobs"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["networking.k8s.io"]
  resources: ["ingresses"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: monitoring-viewer-binding
  namespace: monitoring
subjects:
- kind: ServiceAccount
  name: monitoring-viewer
  namespace: monitoring
roleRef:
  kind: Role
  name: namespace-viewer
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: v1
kind: Secret
metadata:
  name: monitoring-viewer-token
  namespace: monitoring
  annotations:
    kubernetes.io/service-account.name: monitoring-viewer
type: kubernetes.io/service-account-token
RBAC

echo "Waiting for token to be populated..."
for i in $(seq 1 10); do
  TOKEN=$(kubectl get secret monitoring-viewer-token -n monitoring -o jsonpath='{.data.token}' 2>/dev/null || true)
  if [ -n "$TOKEN" ]; then break; fi
  sleep 1
done

TOKEN=$(echo "$TOKEN" | base64 --decode)
CA=$(kubectl get secret monitoring-viewer-token -n monitoring -o jsonpath='{.data.ca\.crt}')
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')

cat > "$KUBECONFIG_OUT" <<KUBECONFIG
apiVersion: v1
kind: Config
clusters:
- name: kind-${CLUSTER_NAME}
  cluster:
    certificate-authority-data: ${CA}
    server: ${SERVER}
contexts:
- name: monitoring-viewer
  context:
    cluster: kind-${CLUSTER_NAME}
    namespace: ${VIEWER_NS}
    user: ${VIEWER_SA}
current-context: monitoring-viewer
users:
- name: ${VIEWER_SA}
  user:
    token: ${TOKEN}
KUBECONFIG

echo "Kubeconfig written to: ${KUBECONFIG_OUT}"

echo ""
echo "📊 Cluster state:"
kubectl get pods --all-namespaces --no-headers | awk '{print $1}' | sort | uniq -c | sort -rn
echo ""
echo "Total pods: $(kubectl get pods --all-namespaces --no-headers | wc -l | tr -d ' ')"
echo "Services:   $(kubectl get svc --all-namespaces --no-headers | wc -l | tr -d ' ')"
echo "Ingresses:  $(kubectl get ingress --all-namespaces --no-headers 2>/dev/null | wc -l | tr -d ' ')"
echo "PVCs:       $(kubectl get pvc --all-namespaces --no-headers 2>/dev/null | wc -l | tr -d ' ')"
echo ""
echo "✅ Ready! Run:"
echo "  kube3d --context kind-${CLUSTER_NAME}"
echo ""
echo "  Or test with restricted user (monitoring namespace only):"
echo "  kube3d --kubeconfig ${KUBECONFIG_OUT}"
