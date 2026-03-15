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
        resources:
          requests:
            cpu: 10m
            memory: 32Mi
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
        resources:
          requests:
            cpu: 10m
            memory: 16Mi
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
        resources:
          requests:
            cpu: 10m
            memory: 16Mi
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
        resources:
          requests:
            cpu: 10m
            memory: 16Mi
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
kubectl wait --for=condition=available deployment --all --all-namespaces --timeout=120s 2>/dev/null || true

echo ""
echo "📊 Cluster state:"
kubectl get pods --all-namespaces --no-headers | awk '{print $1}' | sort | uniq -c | sort -rn
echo ""
echo "Total pods: $(kubectl get pods --all-namespaces --no-headers | wc -l | tr -d ' ')"
echo "Services:   $(kubectl get svc --all-namespaces --no-headers --no-headers | wc -l | tr -d ' ')"
echo "Ingresses:  $(kubectl get ingress --all-namespaces --no-headers 2>/dev/null | wc -l | tr -d ' ')"
echo ""
echo "✅ Ready! Run:"
echo "  kube3d --context kind-${CLUSTER_NAME}"
