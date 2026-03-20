package k8s

import (
	"context"
	"fmt"
	"log"
	"sort"
	"sync"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	k8swatch "k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
)

type PodInfo struct {
	Name          string            `json:"name"`
	Namespace     string            `json:"namespace"`
	Status        string            `json:"status"`
	Ready         bool              `json:"ready"`
	Restarts      int32             `json:"restarts"`
	Age           string            `json:"age"`
	NodeName      string            `json:"nodeName"`
	CPURequest    int64             `json:"cpuRequest"`    // millicores
	MemoryRequest int64             `json:"memoryRequest"` // bytes
	OwnerKind     string            `json:"ownerKind,omitempty"`
	OwnerName     string            `json:"ownerName,omitempty"`
	Labels        map[string]string `json:"labels,omitempty"`
	PVCNames       []string          `json:"pvcNames,omitempty"`
	ConfigMapRefs  []string          `json:"configMapRefs,omitempty"`
	SecretRefs     []string          `json:"secretRefs,omitempty"`
}

type NamespaceInfo struct {
	Name   string    `json:"name"`
	Status string    `json:"status"`
	Pods   []PodInfo `json:"pods"`
}

type NodeInfo struct {
	Name           string `json:"name"`
	Status         string `json:"status"`         // "Ready" or "NotReady"
	CPUCapacity    int64  `json:"cpuCapacity"`    // millicores
	MemoryCapacity int64  `json:"memoryCapacity"` // bytes
}

type ServiceInfo struct {
	Name      string            `json:"name"`
	Namespace string            `json:"namespace"`
	Type      string            `json:"type"`
	ClusterIP string            `json:"clusterIP"`
	Selector  map[string]string `json:"selector,omitempty"`
}

type WorkloadInfo struct {
	Name              string `json:"name"`
	Namespace         string `json:"namespace"`
	Kind              string `json:"kind"`
	DesiredReplicas   int32  `json:"desiredReplicas"`
	ReadyReplicas     int32  `json:"readyReplicas"`
	AvailableReplicas int32  `json:"availableReplicas,omitempty"`
}

type IngressRulePathInfo struct {
	Path        string `json:"path"`
	PathType    string `json:"pathType"`
	ServiceName string `json:"serviceName"`
	ServicePort string `json:"servicePort"`
}

type IngressRuleInfo struct {
	Host  string                `json:"host,omitempty"`
	Paths []IngressRulePathInfo `json:"paths"`
}

type PVCInfo struct {
	Name             string   `json:"name"`
	Namespace        string   `json:"namespace"`
	Status           string   `json:"status"`
	VolumeName       string   `json:"volumeName,omitempty"`
	StorageClassName string   `json:"storageClassName,omitempty"`
	AccessModes      []string `json:"accessModes,omitempty"`
	Capacity         string   `json:"capacity,omitempty"`
	RequestedStorage string   `json:"requestedStorage,omitempty"`
}

type PVInfo struct {
	Name             string   `json:"name"`
	Status           string   `json:"status"`
	StorageClassName string   `json:"storageClassName,omitempty"`
	Capacity         string   `json:"capacity,omitempty"`
	AccessModes      []string `json:"accessModes,omitempty"`
	ReclaimPolicy    string   `json:"reclaimPolicy,omitempty"`
	ClaimRef         string   `json:"claimRef,omitempty"`
}

type IngressInfo struct {
	Name             string            `json:"name"`
	Namespace        string            `json:"namespace"`
	IngressClassName string            `json:"ingressClassName,omitempty"`
	Rules            []IngressRuleInfo `json:"rules"`
	DefaultBackend   string            `json:"defaultBackend,omitempty"`
}

type K8sEventInfo struct {
	Name               string `json:"name"`
	Namespace          string `json:"namespace"`
	Type               string `json:"type"`
	Reason             string `json:"reason"`
	Message            string `json:"message"`
	InvolvedObjectKind string `json:"involvedObjectKind"`
	InvolvedObjectName string `json:"involvedObjectName"`
	Source             string `json:"source"`
	Count              int32  `json:"count"`
	FirstTimestamp     int64  `json:"firstTimestamp"`
	LastTimestamp       int64  `json:"lastTimestamp"`
}

type Event struct {
	Type      string          `json:"type"`
	Namespace string          `json:"namespace,omitempty"`
	Pod       *PodInfo        `json:"pod,omitempty"`
	Snapshot  []NamespaceInfo `json:"snapshot,omitempty"`
	Node      *NodeInfo       `json:"node,omitempty"`
	Nodes     []NodeInfo      `json:"nodes,omitempty"`
	Service   *ServiceInfo    `json:"service,omitempty"`
	Services  []ServiceInfo   `json:"services,omitempty"`
	Workload  *WorkloadInfo   `json:"workload,omitempty"`
	Workloads []WorkloadInfo  `json:"workloads,omitempty"`
	Ingress    *IngressInfo    `json:"ingress,omitempty"`
	Ingresses  []IngressInfo   `json:"ingresses,omitempty"`
	K8sEvent   *K8sEventInfo   `json:"k8sEvent,omitempty"`
	K8sEvents  []K8sEventInfo  `json:"k8sEvents,omitempty"`
	PVC        *PVCInfo        `json:"pvc,omitempty"`
	PVCs       []PVCInfo       `json:"pvcs,omitempty"`
	PV         *PVInfo         `json:"pv,omitempty"`
	PVs        []PVInfo        `json:"pvs,omitempty"`
	MetricsAvailable     bool          `json:"metricsAvailable,omitempty"`
	PodMetricsAvailable  bool          `json:"podMetricsAvailable,omitempty"`
	NodeMetricsAvailable bool          `json:"nodeMetricsAvailable,omitempty"`
	PodMetrics           []PodMetrics  `json:"podMetrics,omitempty"`
	NodeMetrics          []NodeMetrics `json:"nodeMetrics,omitempty"`
}

type Watcher struct {
	clientset       *kubernetes.Clientset
	namespace       string // if set, scope all watches to this namespace
	configNamespace string // namespace from kubeconfig context, used as fallback
	mu                  sync.RWMutex
	metricsAvailable     bool
	nodeMetricsAvailable bool
	podMetrics           map[string]*PodMetrics  // key: "namespace/podName"
	nodeMetrics          map[string]*NodeMetrics // key: nodeName
	namespaces map[string]*NamespaceInfo
	pods       map[string]map[string]*PodInfo // ns -> pod name -> pod
	nodes      map[string]*NodeInfo
	services   map[string]map[string]*ServiceInfo // ns -> svc name -> svc
	ingresses  map[string]map[string]*IngressInfo // ns -> ingress name -> ingress
	k8sEvents  map[string]map[string]*K8sEventInfo // ns -> event name -> event
	workloads  map[string]map[string]*WorkloadInfo
	pvcs       map[string]map[string]*PVCInfo // ns -> pvc name -> pvc
	pvs        map[string]*PVInfo
	rsOwners   map[string]map[string]string // ns -> replicaset name -> deployment name
	eventCh    chan Event
	stopCh     chan struct{}
}

const watchRetryDelay = 2 * time.Second

func NewWatcher(kubeconfig, kubecontext, namespace string) (*Watcher, error) {
	rules := clientcmd.NewDefaultClientConfigLoadingRules()
	if kubeconfig != "" {
		rules.ExplicitPath = kubeconfig
	}
	overrides := &clientcmd.ConfigOverrides{}
	if kubecontext != "" {
		overrides.CurrentContext = kubecontext
	}
	clientConfig := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, overrides)
	config, err := clientConfig.ClientConfig()
	if err != nil {
		return nil, fmt.Errorf("k8s config: %w", err)
	}

	configNamespace, _, _ := clientConfig.Namespace()

	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("k8s client: %w", err)
	}

	return &Watcher{
		clientset:       clientset,
		namespace:       namespace,
		configNamespace: configNamespace,
		podMetrics:  make(map[string]*PodMetrics),
		nodeMetrics: make(map[string]*NodeMetrics),
		namespaces: make(map[string]*NamespaceInfo),
		pods:       make(map[string]map[string]*PodInfo),
		nodes:      make(map[string]*NodeInfo),
		services:   make(map[string]map[string]*ServiceInfo),
		ingresses:  make(map[string]map[string]*IngressInfo),
		k8sEvents:  make(map[string]map[string]*K8sEventInfo),
		workloads:  make(map[string]map[string]*WorkloadInfo),
		pvcs:       make(map[string]map[string]*PVCInfo),
		pvs:        make(map[string]*PVInfo),
		rsOwners:   make(map[string]map[string]string),
		eventCh:    make(chan Event, 256),
		stopCh:     make(chan struct{}),
	}, nil
}

func (w *Watcher) Events() <-chan Event {
	return w.eventCh
}

func (w *Watcher) Snapshot() []NamespaceInfo {
	w.mu.RLock()
	defer w.mu.RUnlock()

	result := make([]NamespaceInfo, 0, len(w.namespaces))
	for _, ns := range w.namespaces {
		nsCopy := NamespaceInfo{Name: ns.Name, Status: ns.Status}
		if pods, ok := w.pods[ns.Name]; ok {
			for _, p := range pods {
				nsCopy.Pods = append(nsCopy.Pods, *p)
			}
		}
		result = append(result, nsCopy)
	}
	return result
}

func (w *Watcher) SnapshotNodes() []NodeInfo {
	w.mu.RLock()
	defer w.mu.RUnlock()

	result := make([]NodeInfo, 0, len(w.nodes))
	for _, n := range w.nodes {
		result = append(result, *n)
	}
	return result
}

func (w *Watcher) SnapshotServices() []ServiceInfo {
	w.mu.RLock()
	defer w.mu.RUnlock()

	result := make([]ServiceInfo, 0)
	for _, svcs := range w.services {
		for _, s := range svcs {
			result = append(result, *s)
		}
	}
	return result
}

func (w *Watcher) SnapshotWorkloads() []WorkloadInfo {
	w.mu.RLock()
	defer w.mu.RUnlock()

	result := make([]WorkloadInfo, 0)
	for _, workloads := range w.workloads {
		for _, workload := range workloads {
			result = append(result, *workload)
		}
	}

	sort.Slice(result, func(i, j int) bool {
		if result[i].Namespace != result[j].Namespace {
			return result[i].Namespace < result[j].Namespace
		}
		if result[i].Kind != result[j].Kind {
			return result[i].Kind < result[j].Kind
		}
		return result[i].Name < result[j].Name
	})

	return result
}

func (w *Watcher) SnapshotIngresses() []IngressInfo {
	w.mu.RLock()
	defer w.mu.RUnlock()

	result := make([]IngressInfo, 0)
	for _, ingresses := range w.ingresses {
		for _, ing := range ingresses {
			result = append(result, *ing)
		}
	}
	return result
}

func (w *Watcher) SnapshotK8sEvents() []K8sEventInfo {
	w.mu.RLock()
	defer w.mu.RUnlock()

	result := make([]K8sEventInfo, 0)
	for _, events := range w.k8sEvents {
		for _, e := range events {
			result = append(result, *e)
		}
	}
	return result
}

func k8sEventToInfo(event *corev1.Event) K8sEventInfo {
	info := K8sEventInfo{
		Name:               event.Name,
		Namespace:          event.Namespace,
		Type:               event.Type,
		Reason:             event.Reason,
		Message:            event.Message,
		InvolvedObjectKind: event.InvolvedObject.Kind,
		InvolvedObjectName: event.InvolvedObject.Name,
		Count:              event.Count,
	}
	if event.Source.Component != "" {
		info.Source = event.Source.Component
	}
	if !event.FirstTimestamp.IsZero() {
		info.FirstTimestamp = event.FirstTimestamp.Unix()
	}
	if !event.LastTimestamp.IsZero() {
		info.LastTimestamp = event.LastTimestamp.Unix()
	}
	return info
}

func (w *Watcher) Start(ctx context.Context) error {
	ns := w.namespace // empty string means all namespaces

	// Initial namespace list
	var nsResourceVersion string
	namespaces := make(map[string]*NamespaceInfo)
	pods := make(map[string]map[string]*PodInfo)
	if ns != "" {
		namespaces[ns] = &NamespaceInfo{Name: ns, Status: "Active"}
		pods[ns] = make(map[string]*PodInfo)
	} else {
		nsList, err := w.clientset.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
		if err != nil {
			if w.configNamespace != "" {
				log.Printf("Cannot list namespaces, falling back to kubeconfig namespace %q: %v", w.configNamespace, err)
				ns = w.configNamespace
				w.namespace = ns
				namespaces[ns] = &NamespaceInfo{Name: ns, Status: "Active"}
				pods[ns] = make(map[string]*PodInfo)
			} else {
				return fmt.Errorf("list namespaces: %w", err)
			}
		} else {
			nsResourceVersion = nsList.ResourceVersion
			for i := range nsList.Items {
				n := &nsList.Items[i]
				namespaces[n.Name] = &NamespaceInfo{Name: n.Name, Status: string(n.Status.Phase)}
				pods[n.Name] = make(map[string]*PodInfo)
			}
		}
	}

	podList, err := w.clientset.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list pods: %w", err)
	}
	for i := range podList.Items {
		pod := &podList.Items[i]
		info := w.podToInfo(pod)
		if pods[pod.Namespace] == nil {
			pods[pod.Namespace] = make(map[string]*PodInfo)
		}
		pods[pod.Namespace][pod.Name] = &info
	}

	// Nodes are cluster-scoped; skip if we don't have permission
	nodes := make(map[string]*NodeInfo)
	var nodesResourceVersion string
	nodeList, err := w.clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		if ns != "" {
			log.Printf("Skipping nodes (no cluster-scope permission)")
		} else {
			return fmt.Errorf("list nodes: %w", err)
		}
	} else {
		nodesResourceVersion = nodeList.ResourceVersion
		for i := range nodeList.Items {
			node := &nodeList.Items[i]
			info := nodeToInfo(node)
			nodes[node.Name] = &info
		}
	}

	svcList, err := w.clientset.CoreV1().Services(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list services: %w", err)
	}
	ingList, err := w.clientset.NetworkingV1().Ingresses(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list ingresses: %w", err)
	}
	pvcList, err := w.clientset.CoreV1().PersistentVolumeClaims(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list pvcs: %w", err)
	}

	pvs := make(map[string]*PVInfo)
	var pvsResourceVersion string
	pvList, err := w.clientset.CoreV1().PersistentVolumes().List(ctx, metav1.ListOptions{})
	if err != nil {
		log.Printf("Skipping persistent volumes: %v", err)
	} else {
		pvsResourceVersion = pvList.ResourceVersion
		for i := range pvList.Items {
			pv := &pvList.Items[i]
			info := pvToInfo(pv)
			pvs[pv.Name] = &info
		}
	}
	if err := w.refreshReplicaSetOwners(ctx); err != nil {
		return fmt.Errorf("list replica sets: %w", err)
	}
	if err := w.refreshWorkloads(ctx); err != nil {
		return fmt.Errorf("list workloads: %w", err)
	}

	services := make(map[string]map[string]*ServiceInfo)
	for i := range svcList.Items {
		svc := &svcList.Items[i]
		info := serviceToInfo(svc)
		if services[svc.Namespace] == nil {
			services[svc.Namespace] = make(map[string]*ServiceInfo)
		}
		services[svc.Namespace][svc.Name] = &info
	}

	ingresses := make(map[string]map[string]*IngressInfo)
	for i := range ingList.Items {
		ing := &ingList.Items[i]
		info := ingressToInfo(ing)
		if ingresses[ing.Namespace] == nil {
			ingresses[ing.Namespace] = make(map[string]*IngressInfo)
		}
		ingresses[ing.Namespace][ing.Name] = &info
	}

	pvcs := make(map[string]map[string]*PVCInfo)
	for i := range pvcList.Items {
		pvc := &pvcList.Items[i]
		info := pvcToInfo(pvc)
		if pvcs[pvc.Namespace] == nil {
			pvcs[pvc.Namespace] = make(map[string]*PVCInfo)
		}
		pvcs[pvc.Namespace][pvc.Name] = &info
	}

	k8sEvents := make(map[string]map[string]*K8sEventInfo)
	var eventsResourceVersion string
	eventList, err := w.clientset.CoreV1().Events(ns).List(ctx, metav1.ListOptions{
		FieldSelector: "type=Warning",
	})
	if err != nil {
		log.Printf("Skipping events: %v", err)
	} else {
		eventsResourceVersion = eventList.ResourceVersion
		cutoff := time.Now().Add(-30 * time.Minute).Unix()
		for i := range eventList.Items {
			evt := &eventList.Items[i]
			info := k8sEventToInfo(evt)
			if info.LastTimestamp > 0 && info.LastTimestamp < cutoff {
				continue
			}
			if k8sEvents[evt.Namespace] == nil {
				k8sEvents[evt.Namespace] = make(map[string]*K8sEventInfo)
			}
			k8sEvents[evt.Namespace][evt.Name] = &info
		}
	}

	w.mu.Lock()
	w.namespaces = namespaces
	w.pods = pods
	w.nodes = nodes
	w.services = services
	w.ingresses = ingresses
	w.k8sEvents = k8sEvents
	w.pvcs = pvcs
	w.pvs = pvs
	w.mu.Unlock()

	// Send initial snapshot
	w.emitSnapshot()

	if ns == "" {
		go w.watchNamespaces(ctx, nsResourceVersion)
	}
	go w.watchPods(ctx, podList.ResourceVersion)
	if nodesResourceVersion != "" {
		go w.watchNodes(ctx, nodesResourceVersion)
	}
	go w.watchServices(ctx, svcList.ResourceVersion)
	go w.watchIngresses(ctx, ingList.ResourceVersion)
	go w.watchPVCs(ctx, pvcList.ResourceVersion)
	if pvsResourceVersion != "" {
		go w.watchPVs(ctx, pvsResourceVersion)
	}
	if eventsResourceVersion != "" {
		go w.watchK8sEvents(ctx, eventsResourceVersion)
	}
	go w.pollWorkloads(ctx)

	if w.probeMetrics(ctx) {
		w.mu.Lock()
		w.metricsAvailable = true
		w.nodeMetricsAvailable = true
		w.mu.Unlock()
		log.Printf("metrics-server detected, starting metrics poller")
		go w.pollMetrics(ctx)
	} else {
		log.Printf("metrics-server unavailable, skipping metrics collection")
	}

	return nil
}

func (w *Watcher) emitSnapshot() {
	w.emit(Event{
		Type:                 "snapshot",
		Snapshot:             w.Snapshot(),
		Nodes:                w.SnapshotNodes(),
		Services:             w.SnapshotServices(),
		Workloads:            w.SnapshotWorkloads(),
		Ingresses:            w.SnapshotIngresses(),
		K8sEvents:            w.SnapshotK8sEvents(),
		PVCs:                 w.SnapshotPVCs(),
		PVs:                  w.SnapshotPVs(),
		MetricsAvailable:     w.MetricsAvailable(),
		PodMetricsAvailable:  w.MetricsAvailable(),
		NodeMetricsAvailable: w.NodeMetricsAvailable(),
		PodMetrics:           w.SnapshotPodMetrics(),
		NodeMetrics:          w.SnapshotNodeMetrics(),
	})
}

func (w *Watcher) isStopped() bool {
	select {
	case <-w.stopCh:
		return true
	default:
		return false
	}
}

func workloadsEqual(left, right []WorkloadInfo) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func (w *Watcher) pollWorkloads(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	last := w.SnapshotWorkloads()

	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		case <-ticker.C:
			if err := w.refreshReplicaSetOwners(ctx); err != nil {
				if ctx.Err() == nil && !w.isStopped() {
					log.Printf("workload refresh (replicasets): %v", err)
				}
				continue
			}
			if err := w.refreshWorkloads(ctx); err != nil {
				if ctx.Err() == nil && !w.isStopped() {
					log.Printf("workload refresh: %v", err)
				}
				continue
			}
			current := w.SnapshotWorkloads()
			if workloadsEqual(last, current) {
				continue
			}
			last = current
			w.emit(Event{
				Type:      "workloads_snapshot",
				Workloads: current,
			})
		}
	}
}

func (w *Watcher) refreshReplicaSetOwners(ctx context.Context) error {
	rsList, err := w.clientset.AppsV1().ReplicaSets(w.namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return err
	}

	newOwners := make(map[string]map[string]string)
	for i := range rsList.Items {
		rs := &rsList.Items[i]
		for _, owner := range rs.OwnerReferences {
			if owner.Kind != "Deployment" {
				continue
			}
			if newOwners[rs.Namespace] == nil {
				newOwners[rs.Namespace] = make(map[string]string)
			}
			newOwners[rs.Namespace][rs.Name] = owner.Name
			break
		}
	}

	w.mu.Lock()
	w.rsOwners = newOwners
	w.mu.Unlock()
	return nil
}

func (w *Watcher) refreshWorkloads(ctx context.Context) error {
	deployments, err := w.clientset.AppsV1().Deployments(w.namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return err
	}
	statefulsets, err := w.clientset.AppsV1().StatefulSets(w.namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return err
	}
	daemonsets, err := w.clientset.AppsV1().DaemonSets(w.namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return err
	}
	jobs, err := w.clientset.BatchV1().Jobs(w.namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return err
	}
	cronjobs, err := w.clientset.BatchV1().CronJobs(w.namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return err
	}

	newWorkloads := make(map[string]map[string]*WorkloadInfo)
	upsert := func(info WorkloadInfo) {
		if newWorkloads[info.Namespace] == nil {
			newWorkloads[info.Namespace] = make(map[string]*WorkloadInfo)
		}
		key := workloadKey(info.Kind, info.Name)
		workload := info
		newWorkloads[info.Namespace][key] = &workload
	}

	for i := range deployments.Items {
		upsert(workloadFromDeployment(&deployments.Items[i]))
	}
	for i := range statefulsets.Items {
		upsert(workloadFromStatefulSet(&statefulsets.Items[i]))
	}
	for i := range daemonsets.Items {
		upsert(workloadFromDaemonSet(&daemonsets.Items[i]))
	}
	for i := range jobs.Items {
		upsert(workloadFromJob(&jobs.Items[i]))
	}
	for i := range cronjobs.Items {
		upsert(workloadFromCronJob(&cronjobs.Items[i]))
	}

	w.mu.Lock()
	w.workloads = newWorkloads
	w.mu.Unlock()
	return nil
}

func (w *Watcher) refreshNamespaces(ctx context.Context) (string, error) {
	nsList, err := w.clientset.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return "", fmt.Errorf("list namespaces: %w", err)
	}

	w.mu.Lock()
	newNamespaces := make(map[string]*NamespaceInfo, len(nsList.Items))
	newPods := make(map[string]map[string]*PodInfo, len(nsList.Items))
	newServices := make(map[string]map[string]*ServiceInfo, len(nsList.Items))
	newWorkloads := make(map[string]map[string]*WorkloadInfo, len(nsList.Items))
	newPVCs := make(map[string]map[string]*PVCInfo, len(nsList.Items))
	for i := range nsList.Items {
		ns := &nsList.Items[i]
		newNamespaces[ns.Name] = &NamespaceInfo{Name: ns.Name, Status: string(ns.Status.Phase)}
		if pods, ok := w.pods[ns.Name]; ok {
			newPods[ns.Name] = pods
		} else {
			newPods[ns.Name] = make(map[string]*PodInfo)
		}
		if services, ok := w.services[ns.Name]; ok {
			newServices[ns.Name] = services
		}
		if workloads, ok := w.workloads[ns.Name]; ok {
			newWorkloads[ns.Name] = workloads
		}
		if pvcs, ok := w.pvcs[ns.Name]; ok {
			newPVCs[ns.Name] = pvcs
		}
	}
	w.namespaces = newNamespaces
	w.pods = newPods
	w.services = newServices
	w.workloads = newWorkloads
	w.pvcs = newPVCs
	w.mu.Unlock()

	return nsList.ResourceVersion, nil
}

func (w *Watcher) refreshPods(ctx context.Context) (string, error) {
	podList, err := w.clientset.CoreV1().Pods(w.namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return "", fmt.Errorf("list pods: %w", err)
	}

	w.mu.Lock()
	newPods := make(map[string]map[string]*PodInfo, len(w.namespaces))
	for nsName := range w.namespaces {
		newPods[nsName] = make(map[string]*PodInfo)
	}
	for i := range podList.Items {
		pod := &podList.Items[i]
		info := w.podToInfo(pod)
		if newPods[pod.Namespace] == nil {
			newPods[pod.Namespace] = make(map[string]*PodInfo)
		}
		newPods[pod.Namespace][pod.Name] = &info
	}
	w.pods = newPods
	w.mu.Unlock()

	return podList.ResourceVersion, nil
}

func (w *Watcher) refreshNodes(ctx context.Context) (string, error) {
	nodeList, err := w.clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return "", fmt.Errorf("list nodes: %w", err)
	}

	w.mu.Lock()
	newNodes := make(map[string]*NodeInfo, len(nodeList.Items))
	for i := range nodeList.Items {
		node := &nodeList.Items[i]
		info := nodeToInfo(node)
		newNodes[node.Name] = &info
	}
	w.nodes = newNodes
	w.mu.Unlock()

	return nodeList.ResourceVersion, nil
}

func (w *Watcher) refreshServices(ctx context.Context) (string, error) {
	svcList, err := w.clientset.CoreV1().Services(w.namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return "", fmt.Errorf("list services: %w", err)
	}

	w.mu.Lock()
	newServices := make(map[string]map[string]*ServiceInfo)
	for i := range svcList.Items {
		svc := &svcList.Items[i]
		info := serviceToInfo(svc)
		if newServices[svc.Namespace] == nil {
			newServices[svc.Namespace] = make(map[string]*ServiceInfo)
		}
		newServices[svc.Namespace][svc.Name] = &info
	}
	w.services = newServices
	w.mu.Unlock()

	return svcList.ResourceVersion, nil
}

func (w *Watcher) refreshIngresses(ctx context.Context) (string, error) {
	ingList, err := w.clientset.NetworkingV1().Ingresses(w.namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return "", fmt.Errorf("list ingresses: %w", err)
	}

	w.mu.Lock()
	newIngresses := make(map[string]map[string]*IngressInfo)
	for i := range ingList.Items {
		ing := &ingList.Items[i]
		info := ingressToInfo(ing)
		if newIngresses[ing.Namespace] == nil {
			newIngresses[ing.Namespace] = make(map[string]*IngressInfo)
		}
		newIngresses[ing.Namespace][ing.Name] = &info
	}
	w.ingresses = newIngresses
	w.mu.Unlock()

	return ingList.ResourceVersion, nil
}

func (w *Watcher) watchNamespaces(ctx context.Context, rv string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}

		watcher, err := w.clientset.CoreV1().Namespaces().Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			if ctx.Err() != nil || w.isStopped() {
				return
			}
			log.Printf("namespace watch: %v", err)
			if rv, err = w.refreshNamespaces(ctx); err == nil {
				w.emitSnapshot()
				continue
			}
			if ctx.Err() != nil || w.isStopped() {
				return
			}
			log.Printf("namespace resync: %v", err)
			time.Sleep(watchRetryDelay)
			continue
		}

		needsResync := false
		for event := range watcher.ResultChan() {
			if event.Type == k8swatch.Error {
				needsResync = true
				if status, ok := event.Object.(*metav1.Status); ok {
					log.Printf("namespace watch error: %s", status.Message)
				}
				break
			}

			ns, ok := event.Object.(*corev1.Namespace)
			if !ok {
				continue
			}
			rv = ns.ResourceVersion

			switch event.Type {
			case k8swatch.Added, k8swatch.Modified:
				w.mu.Lock()
				w.namespaces[ns.Name] = &NamespaceInfo{Name: ns.Name, Status: string(ns.Status.Phase)}
				if w.pods[ns.Name] == nil {
					w.pods[ns.Name] = make(map[string]*PodInfo)
				}
				if w.workloads[ns.Name] == nil {
					w.workloads[ns.Name] = make(map[string]*WorkloadInfo)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "ns_added", Namespace: ns.Name})

			case k8swatch.Deleted:
				w.mu.Lock()
				delete(w.namespaces, ns.Name)
				delete(w.pods, ns.Name)
				delete(w.services, ns.Name)
				delete(w.workloads, ns.Name)
				delete(w.k8sEvents, ns.Name)
				delete(w.pvcs, ns.Name)
				w.mu.Unlock()
				w.emit(Event{Type: "ns_deleted", Namespace: ns.Name})
			}
		}

		watcher.Stop()
		if ctx.Err() != nil || w.isStopped() {
			return
		}
		if rv, err = w.refreshNamespaces(ctx); err != nil {
			if ctx.Err() != nil || w.isStopped() {
				return
			}
			if needsResync {
				log.Printf("namespace resync: %v", err)
			}
			time.Sleep(watchRetryDelay)
			continue
		}
		w.emitSnapshot()
	}
}

func (w *Watcher) watchPods(ctx context.Context, rv string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}

		watcher, err := w.clientset.CoreV1().Pods(w.namespace).Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			if ctx.Err() != nil || w.isStopped() {
				return
			}
			log.Printf("pod watch: %v", err)
			if rv, err = w.refreshPods(ctx); err == nil {
				w.emitSnapshot()
				continue
			}
			if ctx.Err() != nil || w.isStopped() {
				return
			}
			log.Printf("pod resync: %v", err)
			time.Sleep(watchRetryDelay)
			continue
		}

		needsResync := false
		for event := range watcher.ResultChan() {
			if event.Type == k8swatch.Error {
				needsResync = true
				if status, ok := event.Object.(*metav1.Status); ok {
					log.Printf("pod watch error: %s", status.Message)
				}
				break
			}

			pod, ok := event.Object.(*corev1.Pod)
			if !ok {
				continue
			}
			rv = pod.ResourceVersion
			info := w.podToInfo(pod)

			switch event.Type {
			case k8swatch.Added:
				w.mu.Lock()
				if w.pods[pod.Namespace] == nil {
					w.pods[pod.Namespace] = make(map[string]*PodInfo)
				}
				w.pods[pod.Namespace][pod.Name] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "pod_added", Namespace: pod.Namespace, Pod: &info})

			case k8swatch.Modified:
				w.mu.Lock()
				if w.pods[pod.Namespace] == nil {
					w.pods[pod.Namespace] = make(map[string]*PodInfo)
				}
				w.pods[pod.Namespace][pod.Name] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "pod_modified", Namespace: pod.Namespace, Pod: &info})

			case k8swatch.Deleted:
				w.mu.Lock()
				if w.pods[pod.Namespace] != nil {
					delete(w.pods[pod.Namespace], pod.Name)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "pod_deleted", Namespace: pod.Namespace, Pod: &info})
			}
		}

		watcher.Stop()
		if ctx.Err() != nil || w.isStopped() {
			return
		}
		if rv, err = w.refreshPods(ctx); err != nil {
			if ctx.Err() != nil || w.isStopped() {
				return
			}
			if needsResync {
				log.Printf("pod resync: %v", err)
			}
			time.Sleep(watchRetryDelay)
			continue
		}
		w.emitSnapshot()
	}
}

func (w *Watcher) emit(e Event) {
	select {
	case w.eventCh <- e:
	default:
		// Drop event if channel full
	}
}

func (w *Watcher) Stop() {
	close(w.stopCh)
}

func workloadKey(kind, name string) string {
	return kind + "/" + name
}

func workloadFromDeployment(deployment *appsv1.Deployment) WorkloadInfo {
	desired := int32(1)
	if deployment.Spec.Replicas != nil {
		desired = *deployment.Spec.Replicas
	}
	return WorkloadInfo{
		Name:              deployment.Name,
		Namespace:         deployment.Namespace,
		Kind:              "Deployment",
		DesiredReplicas:   desired,
		ReadyReplicas:     deployment.Status.ReadyReplicas,
		AvailableReplicas: deployment.Status.AvailableReplicas,
	}
}

func workloadFromStatefulSet(statefulset *appsv1.StatefulSet) WorkloadInfo {
	desired := int32(1)
	if statefulset.Spec.Replicas != nil {
		desired = *statefulset.Spec.Replicas
	}
	return WorkloadInfo{
		Name:              statefulset.Name,
		Namespace:         statefulset.Namespace,
		Kind:              "StatefulSet",
		DesiredReplicas:   desired,
		ReadyReplicas:     statefulset.Status.ReadyReplicas,
		AvailableReplicas: statefulset.Status.AvailableReplicas,
	}
}

func workloadFromDaemonSet(daemonset *appsv1.DaemonSet) WorkloadInfo {
	return WorkloadInfo{
		Name:              daemonset.Name,
		Namespace:         daemonset.Namespace,
		Kind:              "DaemonSet",
		DesiredReplicas:   daemonset.Status.DesiredNumberScheduled,
		ReadyReplicas:     daemonset.Status.NumberReady,
		AvailableReplicas: daemonset.Status.NumberAvailable,
	}
}

func workloadFromJob(job *batchv1.Job) WorkloadInfo {
	desired := int32(1)
	if job.Spec.Parallelism != nil && *job.Spec.Parallelism > 0 {
		desired = *job.Spec.Parallelism
	}
	ready := int32(0)
	if job.Status.Ready != nil {
		ready = *job.Status.Ready
	}
	return WorkloadInfo{
		Name:            job.Name,
		Namespace:       job.Namespace,
		Kind:            "Job",
		DesiredReplicas: desired,
		ReadyReplicas:   ready,
	}
}

func workloadFromCronJob(cronjob *batchv1.CronJob) WorkloadInfo {
	desired := int32(1)
	if cronjob.Spec.Suspend != nil && *cronjob.Spec.Suspend {
		desired = 0
	}
	return WorkloadInfo{
		Name:            cronjob.Name,
		Namespace:       cronjob.Namespace,
		Kind:            "CronJob",
		DesiredReplicas: desired,
		ReadyReplicas:   int32(len(cronjob.Status.Active)),
	}
}

func resolvePodOwner(owners []metav1.OwnerReference) (string, string) {
	for _, owner := range owners {
		if owner.Controller != nil && *owner.Controller {
			return owner.Kind, owner.Name
		}
	}
	if len(owners) > 0 {
		return owners[0].Kind, owners[0].Name
	}
	return "", ""
}

func (w *Watcher) resolveReplicaSetOwner(namespace, replicaSetName string) string {
	w.mu.RLock()
	defer w.mu.RUnlock()

	if owners, ok := w.rsOwners[namespace]; ok {
		return owners[replicaSetName]
	}
	return ""
}

func (w *Watcher) podToInfo(pod *corev1.Pod) PodInfo {
	status := string(pod.Status.Phase)
	ready := true
	var restarts int32

	for _, cs := range pod.Status.ContainerStatuses {
		restarts += cs.RestartCount
		if !cs.Ready {
			ready = false
		}
		if cs.State.Waiting != nil && cs.State.Waiting.Reason != "" {
			status = cs.State.Waiting.Reason
		}
		if cs.State.Terminated != nil && cs.State.Terminated.Reason != "" {
			status = cs.State.Terminated.Reason
		}
	}

	age := time.Since(pod.CreationTimestamp.Time).Truncate(time.Second).String()

	var cpuMillis, memBytes int64
	for _, c := range pod.Spec.Containers {
		if cpu, ok := c.Resources.Requests[corev1.ResourceCPU]; ok {
			cpuMillis += cpu.MilliValue()
		}
		if mem, ok := c.Resources.Requests[corev1.ResourceMemory]; ok {
			memBytes += mem.Value()
		}
	}

	ownerKind, ownerName := resolvePodOwner(pod.OwnerReferences)
	if ownerKind == "ReplicaSet" {
		if deploymentName := w.resolveReplicaSetOwner(pod.Namespace, ownerName); deploymentName != "" {
			ownerKind = "Deployment"
			ownerName = deploymentName
		}
	}

	var pvcNames []string
	for _, vol := range pod.Spec.Volumes {
		if vol.PersistentVolumeClaim != nil {
			pvcNames = append(pvcNames, vol.PersistentVolumeClaim.ClaimName)
		}
	}

	configMapRefs, secretRefs := extractConfigRefs(pod)

	return PodInfo{
		Name:          pod.Name,
		Namespace:     pod.Namespace,
		Status:        status,
		Ready:         ready,
		Restarts:      restarts,
		Age:           age,
		NodeName:      pod.Spec.NodeName,
		CPURequest:    cpuMillis,
		MemoryRequest: memBytes,
		OwnerKind:     ownerKind,
		OwnerName:     ownerName,
		Labels:        pod.Labels,
		PVCNames:      pvcNames,
		ConfigMapRefs: configMapRefs,
		SecretRefs:    secretRefs,
	}
}

func extractConfigRefs(pod *corev1.Pod) (configMaps, secrets []string) {
	cmSet := make(map[string]struct{})
	secSet := make(map[string]struct{})

	for _, vol := range pod.Spec.Volumes {
		if vol.ConfigMap != nil {
			cmSet[vol.ConfigMap.Name] = struct{}{}
		}
		if vol.Secret != nil {
			secSet[vol.Secret.SecretName] = struct{}{}
		}
	}

	allContainers := append(pod.Spec.InitContainers, pod.Spec.Containers...)
	for _, c := range allContainers {
		for _, ef := range c.EnvFrom {
			if ef.ConfigMapRef != nil {
				cmSet[ef.ConfigMapRef.Name] = struct{}{}
			}
			if ef.SecretRef != nil {
				secSet[ef.SecretRef.Name] = struct{}{}
			}
		}
		for _, env := range c.Env {
			if env.ValueFrom != nil {
				if env.ValueFrom.ConfigMapKeyRef != nil {
					cmSet[env.ValueFrom.ConfigMapKeyRef.Name] = struct{}{}
				}
				if env.ValueFrom.SecretKeyRef != nil {
					secSet[env.ValueFrom.SecretKeyRef.Name] = struct{}{}
				}
			}
		}
	}

	for name := range cmSet {
		configMaps = append(configMaps, name)
	}
	for name := range secSet {
		secrets = append(secrets, name)
	}
	sort.Strings(configMaps)
	sort.Strings(secrets)
	return
}

func nodeToInfo(node *corev1.Node) NodeInfo {
	status := "NotReady"
	for _, cond := range node.Status.Conditions {
		if cond.Type == corev1.NodeReady && cond.Status == corev1.ConditionTrue {
			status = "Ready"
			break
		}
	}

	var cpuMillis, memBytes int64
	if cpu, ok := node.Status.Capacity[corev1.ResourceCPU]; ok {
		cpuMillis = cpu.MilliValue()
	}
	if mem, ok := node.Status.Capacity[corev1.ResourceMemory]; ok {
		memBytes = mem.Value()
	}

	return NodeInfo{
		Name:           node.Name,
		Status:         status,
		CPUCapacity:    cpuMillis,
		MemoryCapacity: memBytes,
	}
}

func serviceToInfo(svc *corev1.Service) ServiceInfo {
	return ServiceInfo{
		Name:      svc.Name,
		Namespace: svc.Namespace,
		Type:      string(svc.Spec.Type),
		ClusterIP: svc.Spec.ClusterIP,
		Selector:  svc.Spec.Selector,
	}
}

func ingressToInfo(ing *networkingv1.Ingress) IngressInfo {
	info := IngressInfo{
		Name:      ing.Name,
		Namespace: ing.Namespace,
	}
	if ing.Spec.IngressClassName != nil {
		info.IngressClassName = *ing.Spec.IngressClassName
	}
	if ing.Spec.DefaultBackend != nil && ing.Spec.DefaultBackend.Service != nil {
		info.DefaultBackend = ing.Spec.DefaultBackend.Service.Name
	}
	for _, rule := range ing.Spec.Rules {
		ri := IngressRuleInfo{Host: rule.Host}
		if rule.HTTP != nil {
			for _, p := range rule.HTTP.Paths {
				rp := IngressRulePathInfo{Path: p.Path}
				if p.PathType != nil {
					rp.PathType = string(*p.PathType)
				}
				if p.Backend.Service != nil {
					rp.ServiceName = p.Backend.Service.Name
					if p.Backend.Service.Port.Name != "" {
						rp.ServicePort = p.Backend.Service.Port.Name
					} else {
						rp.ServicePort = fmt.Sprintf("%d", p.Backend.Service.Port.Number)
					}
				}
				ri.Paths = append(ri.Paths, rp)
			}
		}
		info.Rules = append(info.Rules, ri)
	}
	return info
}

func pvcToInfo(pvc *corev1.PersistentVolumeClaim) PVCInfo {
	info := PVCInfo{
		Name:       pvc.Name,
		Namespace:  pvc.Namespace,
		Status:     string(pvc.Status.Phase),
		VolumeName: pvc.Spec.VolumeName,
	}
	if pvc.Spec.StorageClassName != nil {
		info.StorageClassName = *pvc.Spec.StorageClassName
	}
	for _, am := range pvc.Spec.AccessModes {
		info.AccessModes = append(info.AccessModes, string(am))
	}
	if cap, ok := pvc.Status.Capacity[corev1.ResourceStorage]; ok {
		info.Capacity = cap.String()
	}
	if req, ok := pvc.Spec.Resources.Requests[corev1.ResourceStorage]; ok {
		info.RequestedStorage = req.String()
	}
	return info
}

func pvToInfo(pv *corev1.PersistentVolume) PVInfo {
	info := PVInfo{
		Name:             pv.Name,
		Status:           string(pv.Status.Phase),
		StorageClassName: pv.Spec.StorageClassName,
		ReclaimPolicy:    string(pv.Spec.PersistentVolumeReclaimPolicy),
	}
	for _, am := range pv.Spec.AccessModes {
		info.AccessModes = append(info.AccessModes, string(am))
	}
	if cap, ok := pv.Spec.Capacity[corev1.ResourceStorage]; ok {
		info.Capacity = cap.String()
	}
	if pv.Spec.ClaimRef != nil {
		info.ClaimRef = pv.Spec.ClaimRef.Namespace + "/" + pv.Spec.ClaimRef.Name
	}
	return info
}

func (w *Watcher) SnapshotPVCs() []PVCInfo {
	w.mu.RLock()
	defer w.mu.RUnlock()

	result := make([]PVCInfo, 0)
	for _, pvcs := range w.pvcs {
		for _, pvc := range pvcs {
			result = append(result, *pvc)
		}
	}
	return result
}

func (w *Watcher) SnapshotPVs() []PVInfo {
	w.mu.RLock()
	defer w.mu.RUnlock()

	result := make([]PVInfo, 0)
	for _, pv := range w.pvs {
		result = append(result, *pv)
	}
	return result
}

func (w *Watcher) refreshPVCs(ctx context.Context) (string, error) {
	pvcList, err := w.clientset.CoreV1().PersistentVolumeClaims(w.namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return "", fmt.Errorf("list pvcs: %w", err)
	}

	w.mu.Lock()
	newPVCs := make(map[string]map[string]*PVCInfo)
	for i := range pvcList.Items {
		pvc := &pvcList.Items[i]
		info := pvcToInfo(pvc)
		if newPVCs[pvc.Namespace] == nil {
			newPVCs[pvc.Namespace] = make(map[string]*PVCInfo)
		}
		newPVCs[pvc.Namespace][pvc.Name] = &info
	}
	w.pvcs = newPVCs
	w.mu.Unlock()

	return pvcList.ResourceVersion, nil
}

func (w *Watcher) refreshPVs(ctx context.Context) (string, error) {
	pvList, err := w.clientset.CoreV1().PersistentVolumes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return "", fmt.Errorf("list pvs: %w", err)
	}

	w.mu.Lock()
	newPVs := make(map[string]*PVInfo)
	for i := range pvList.Items {
		pv := &pvList.Items[i]
		info := pvToInfo(pv)
		newPVs[pv.Name] = &info
	}
	w.pvs = newPVs
	w.mu.Unlock()

	return pvList.ResourceVersion, nil
}

func (w *Watcher) watchPVCs(ctx context.Context, rv string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}

		watcher, err := w.clientset.CoreV1().PersistentVolumeClaims(w.namespace).Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			if ctx.Err() != nil || w.isStopped() {
				return
			}
			log.Printf("pvc watch: %v", err)
			if rv, err = w.refreshPVCs(ctx); err == nil {
				w.emitSnapshot()
				continue
			}
			if ctx.Err() != nil || w.isStopped() {
				return
			}
			log.Printf("pvc resync: %v", err)
			time.Sleep(watchRetryDelay)
			continue
		}

		needsResync := false
		for event := range watcher.ResultChan() {
			if event.Type == k8swatch.Error {
				needsResync = true
				if status, ok := event.Object.(*metav1.Status); ok {
					log.Printf("pvc watch error: %s", status.Message)
				}
				break
			}

			pvc, ok := event.Object.(*corev1.PersistentVolumeClaim)
			if !ok {
				continue
			}
			rv = pvc.ResourceVersion
			info := pvcToInfo(pvc)

			switch event.Type {
			case k8swatch.Added, k8swatch.Modified:
				w.mu.Lock()
				if w.pvcs[pvc.Namespace] == nil {
					w.pvcs[pvc.Namespace] = make(map[string]*PVCInfo)
				}
				w.pvcs[pvc.Namespace][pvc.Name] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "pvc_updated", Namespace: pvc.Namespace, PVC: &info})

			case k8swatch.Deleted:
				w.mu.Lock()
				if w.pvcs[pvc.Namespace] != nil {
					delete(w.pvcs[pvc.Namespace], pvc.Name)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "pvc_deleted", Namespace: pvc.Namespace, PVC: &info})
			}
		}

		watcher.Stop()
		if ctx.Err() != nil || w.isStopped() {
			return
		}
		if rv, err = w.refreshPVCs(ctx); err != nil {
			if ctx.Err() != nil || w.isStopped() {
				return
			}
			if needsResync {
				log.Printf("pvc resync: %v", err)
			}
			time.Sleep(watchRetryDelay)
			continue
		}
		w.emitSnapshot()
	}
}

func (w *Watcher) watchPVs(ctx context.Context, rv string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}

		watcher, err := w.clientset.CoreV1().PersistentVolumes().Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			if ctx.Err() != nil || w.isStopped() {
				return
			}
			log.Printf("pv watch: %v", err)
			if rv, err = w.refreshPVs(ctx); err == nil {
				w.emitSnapshot()
				continue
			}
			if ctx.Err() != nil || w.isStopped() {
				return
			}
			log.Printf("pv resync: %v", err)
			time.Sleep(watchRetryDelay)
			continue
		}

		needsResync := false
		for event := range watcher.ResultChan() {
			if event.Type == k8swatch.Error {
				needsResync = true
				if status, ok := event.Object.(*metav1.Status); ok {
					log.Printf("pv watch error: %s", status.Message)
				}
				break
			}

			pv, ok := event.Object.(*corev1.PersistentVolume)
			if !ok {
				continue
			}
			rv = pv.ResourceVersion
			info := pvToInfo(pv)

			switch event.Type {
			case k8swatch.Added, k8swatch.Modified:
				w.mu.Lock()
				w.pvs[pv.Name] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "pv_updated", PV: &info})

			case k8swatch.Deleted:
				w.mu.Lock()
				delete(w.pvs, pv.Name)
				w.mu.Unlock()
				w.emit(Event{Type: "pv_deleted", PV: &info})
			}
		}

		watcher.Stop()
		if ctx.Err() != nil || w.isStopped() {
			return
		}
		if rv, err = w.refreshPVs(ctx); err != nil {
			if ctx.Err() != nil || w.isStopped() {
				return
			}
			if needsResync {
				log.Printf("pv resync: %v", err)
			}
			time.Sleep(watchRetryDelay)
			continue
		}
		w.emitSnapshot()
	}
}

func (w *Watcher) refreshK8sEvents(ctx context.Context) (string, error) {
	eventList, err := w.clientset.CoreV1().Events(w.namespace).List(ctx, metav1.ListOptions{
		FieldSelector: "type=Warning",
	})
	if err != nil {
		return "", fmt.Errorf("list events: %w", err)
	}

	cutoff := time.Now().Add(-30 * time.Minute).Unix()
	newEvents := make(map[string]map[string]*K8sEventInfo)
	for i := range eventList.Items {
		evt := &eventList.Items[i]
		info := k8sEventToInfo(evt)
		if info.LastTimestamp > 0 && info.LastTimestamp < cutoff {
			continue
		}
		if newEvents[evt.Namespace] == nil {
			newEvents[evt.Namespace] = make(map[string]*K8sEventInfo)
		}
		newEvents[evt.Namespace][evt.Name] = &info
	}

	w.mu.Lock()
	w.k8sEvents = newEvents
	w.mu.Unlock()

	return eventList.ResourceVersion, nil
}

func (w *Watcher) watchK8sEvents(ctx context.Context, rv string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}

		watcher, err := w.clientset.CoreV1().Events(w.namespace).Watch(ctx, metav1.ListOptions{
			ResourceVersion: rv,
			FieldSelector:   "type=Warning",
		})
		if err != nil {
			if ctx.Err() != nil || w.isStopped() {
				return
			}
			log.Printf("event watch: %v", err)
			if rv, err = w.refreshK8sEvents(ctx); err == nil {
				w.emitSnapshot()
				continue
			}
			if ctx.Err() != nil || w.isStopped() {
				return
			}
			log.Printf("event resync: %v", err)
			time.Sleep(watchRetryDelay)
			continue
		}

		needsResync := false
		for event := range watcher.ResultChan() {
			if event.Type == k8swatch.Error {
				needsResync = true
				if status, ok := event.Object.(*metav1.Status); ok {
					log.Printf("event watch error: %s", status.Message)
				}
				break
			}

			evt, ok := event.Object.(*corev1.Event)
			if !ok {
				continue
			}
			rv = evt.ResourceVersion
			info := k8sEventToInfo(evt)

			switch event.Type {
			case k8swatch.Added, k8swatch.Modified:
				w.mu.Lock()
				if w.k8sEvents[evt.Namespace] == nil {
					w.k8sEvents[evt.Namespace] = make(map[string]*K8sEventInfo)
				}
				w.k8sEvents[evt.Namespace][evt.Name] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "k8s_event_added", Namespace: evt.Namespace, K8sEvent: &info})

			case k8swatch.Deleted:
				w.mu.Lock()
				if w.k8sEvents[evt.Namespace] != nil {
					delete(w.k8sEvents[evt.Namespace], evt.Name)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "k8s_event_deleted", Namespace: evt.Namespace, K8sEvent: &info})
			}
		}

		watcher.Stop()
		if ctx.Err() != nil || w.isStopped() {
			return
		}
		if rv, err = w.refreshK8sEvents(ctx); err != nil {
			if ctx.Err() != nil || w.isStopped() {
				return
			}
			if needsResync {
				log.Printf("event resync: %v", err)
			}
			time.Sleep(watchRetryDelay)
			continue
		}
		w.emitSnapshot()
	}
}

func (w *Watcher) watchNodes(ctx context.Context, rv string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}

		watcher, err := w.clientset.CoreV1().Nodes().Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			if ctx.Err() != nil || w.isStopped() {
				return
			}
			log.Printf("node watch: %v", err)
			if rv, err = w.refreshNodes(ctx); err == nil {
				w.emitSnapshot()
				continue
			}
			if ctx.Err() != nil || w.isStopped() {
				return
			}
			log.Printf("node resync: %v", err)
			time.Sleep(watchRetryDelay)
			continue
		}

		needsResync := false
		for event := range watcher.ResultChan() {
			if event.Type == k8swatch.Error {
				needsResync = true
				if status, ok := event.Object.(*metav1.Status); ok {
					log.Printf("node watch error: %s", status.Message)
				}
				break
			}

			node, ok := event.Object.(*corev1.Node)
			if !ok {
				continue
			}
			rv = node.ResourceVersion
			info := nodeToInfo(node)

			switch event.Type {
			case k8swatch.Added, k8swatch.Modified:
				w.mu.Lock()
				w.nodes[node.Name] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "node_updated", Node: &info})

			case k8swatch.Deleted:
				w.mu.Lock()
				delete(w.nodes, node.Name)
				w.mu.Unlock()
				w.emit(Event{Type: "node_deleted", Node: &info})
			}
		}

		watcher.Stop()
		if ctx.Err() != nil || w.isStopped() {
			return
		}
		if rv, err = w.refreshNodes(ctx); err != nil {
			if ctx.Err() != nil || w.isStopped() {
				return
			}
			if needsResync {
				log.Printf("node resync: %v", err)
			}
			time.Sleep(watchRetryDelay)
			continue
		}
		w.emitSnapshot()
	}
}

func (w *Watcher) watchServices(ctx context.Context, rv string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}

		watcher, err := w.clientset.CoreV1().Services(w.namespace).Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			if ctx.Err() != nil || w.isStopped() {
				return
			}
			log.Printf("service watch: %v", err)
			if rv, err = w.refreshServices(ctx); err == nil {
				w.emitSnapshot()
				continue
			}
			if ctx.Err() != nil || w.isStopped() {
				return
			}
			log.Printf("service resync: %v", err)
			time.Sleep(watchRetryDelay)
			continue
		}

		needsResync := false
		for event := range watcher.ResultChan() {
			if event.Type == k8swatch.Error {
				needsResync = true
				if status, ok := event.Object.(*metav1.Status); ok {
					log.Printf("service watch error: %s", status.Message)
				}
				break
			}

			svc, ok := event.Object.(*corev1.Service)
			if !ok {
				continue
			}
			rv = svc.ResourceVersion
			info := serviceToInfo(svc)

			switch event.Type {
			case k8swatch.Added, k8swatch.Modified:
				w.mu.Lock()
				if w.services[svc.Namespace] == nil {
					w.services[svc.Namespace] = make(map[string]*ServiceInfo)
				}
				w.services[svc.Namespace][svc.Name] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "svc_updated", Namespace: svc.Namespace, Service: &info})

			case k8swatch.Deleted:
				w.mu.Lock()
				if w.services[svc.Namespace] != nil {
					delete(w.services[svc.Namespace], svc.Name)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "svc_deleted", Namespace: svc.Namespace, Service: &info})
			}
		}

		watcher.Stop()
		if ctx.Err() != nil || w.isStopped() {
			return
		}
		if rv, err = w.refreshServices(ctx); err != nil {
			if ctx.Err() != nil || w.isStopped() {
				return
			}
			if needsResync {
				log.Printf("service resync: %v", err)
			}
			time.Sleep(watchRetryDelay)
			continue
		}
		w.emitSnapshot()
	}
}

func (w *Watcher) watchIngresses(ctx context.Context, rv string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}

		watcher, err := w.clientset.NetworkingV1().Ingresses(w.namespace).Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			if ctx.Err() != nil || w.isStopped() {
				return
			}
			log.Printf("ingress watch: %v", err)
			if rv, err = w.refreshIngresses(ctx); err == nil {
				w.emitSnapshot()
				continue
			}
			if ctx.Err() != nil || w.isStopped() {
				return
			}
			log.Printf("ingress resync: %v", err)
			time.Sleep(watchRetryDelay)
			continue
		}

		needsResync := false
		for event := range watcher.ResultChan() {
			if event.Type == k8swatch.Error {
				needsResync = true
				if status, ok := event.Object.(*metav1.Status); ok {
					log.Printf("ingress watch error: %s", status.Message)
				}
				break
			}

			ing, ok := event.Object.(*networkingv1.Ingress)
			if !ok {
				continue
			}
			rv = ing.ResourceVersion
			info := ingressToInfo(ing)

			switch event.Type {
			case k8swatch.Added, k8swatch.Modified:
				w.mu.Lock()
				if w.ingresses[ing.Namespace] == nil {
					w.ingresses[ing.Namespace] = make(map[string]*IngressInfo)
				}
				w.ingresses[ing.Namespace][ing.Name] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "ingress_updated", Namespace: ing.Namespace, Ingress: &info})

			case k8swatch.Deleted:
				w.mu.Lock()
				if w.ingresses[ing.Namespace] != nil {
					delete(w.ingresses[ing.Namespace], ing.Name)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "ingress_deleted", Namespace: ing.Namespace, Ingress: &info})
			}
		}

		watcher.Stop()
		if ctx.Err() != nil || w.isStopped() {
			return
		}
		if rv, err = w.refreshIngresses(ctx); err != nil {
			if ctx.Err() != nil || w.isStopped() {
				return
			}
			if needsResync {
				log.Printf("ingress resync: %v", err)
			}
			time.Sleep(watchRetryDelay)
			continue
		}
		w.emitSnapshot()
	}
}
