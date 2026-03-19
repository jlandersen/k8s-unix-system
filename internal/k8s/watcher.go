package k8s

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	authv1 "k8s.io/api/authorization/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	k8serrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
)

type PodInfo struct {
	Name           string            `json:"name"`
	Namespace      string            `json:"namespace"`
	Status         string            `json:"status"`
	Ready          bool              `json:"ready"`
	Restarts       int32             `json:"restarts"`
	Age            string            `json:"age"`
	NodeName       string            `json:"nodeName"`
	CPURequest     int64             `json:"cpuRequest"`    // millicores
	MemoryRequest  int64             `json:"memoryRequest"` // bytes
	Labels         map[string]string `json:"labels,omitempty"`
	OwnerKind      string            `json:"ownerKind,omitempty"`
	OwnerName      string            `json:"ownerName,omitempty"`
	ContainerCount int               `json:"containerCount"`
	PVCNames       []string          `json:"pvcNames,omitempty"`
}

type NamespaceInfo struct {
	Name      string    `json:"name"`
	Status    string    `json:"status"`
	Pods      []PodInfo `json:"pods"`
	Forbidden bool      `json:"forbidden,omitempty"`
}

type NodeInfo struct {
	Name           string `json:"name"`
	Status         string `json:"status"` // "Ready" or "NotReady"
	CPUCapacity    int64  `json:"cpuCapacity"`    // millicores
	MemoryCapacity int64  `json:"memoryCapacity"` // bytes
}

type ServicePortInfo struct {
	Name       string `json:"name,omitempty"`
	Port       int32  `json:"port"`
	TargetPort string `json:"targetPort"`
	Protocol   string `json:"protocol"`
}

type ServiceInfo struct {
	Name      string            `json:"name"`
	Namespace string            `json:"namespace"`
	Type      string            `json:"type"`
	ClusterIP string            `json:"clusterIP"`
	Selector  map[string]string `json:"selector,omitempty"`
	Ports     []ServicePortInfo `json:"ports,omitempty"`
}

type IngressInfo struct {
	Name      string            `json:"name"`
	Namespace string            `json:"namespace"`
	Rules     []IngressRuleInfo `json:"rules"`
}

type IngressRuleInfo struct {
	Host             string `json:"host"`
	Path             string `json:"path"`
	ServiceName      string `json:"serviceName"`
	ServicePort      string `json:"servicePort"`
	ServiceNamespace string `json:"serviceNamespace,omitempty"`
}

type PVCInfo struct {
	Name         string `json:"name"`
	Namespace    string `json:"namespace"`
	Status       string `json:"status"` // Bound, Pending, Lost
	StorageClass string `json:"storageClass,omitempty"`
	Capacity     int64  `json:"capacity"` // bytes
	VolumeName   string `json:"volumeName,omitempty"`
}

type WorkloadInfo struct {
	Name            string `json:"name"`
	Namespace       string `json:"namespace"`
	Kind            string `json:"kind"` // Deployment, StatefulSet, DaemonSet, CronJob, Job
	Replicas        int32  `json:"replicas"`
	ReadyReplicas   int32  `json:"readyReplicas"`
	UpdatedReplicas int32  `json:"updatedReplicas"`
	// CronJob-specific fields
	Schedule        string `json:"schedule,omitempty"`
	Suspended       bool   `json:"suspended,omitempty"`
	LastSchedule    string `json:"lastSchedule,omitempty"`
	ActiveJobs      int32  `json:"activeJobs,omitempty"`
}

// ResourceInfo is a generic type for K8s resources that don't need specialized fields.
// Used for ConfigMaps, Secrets, HPAs, NetworkPolicies, PVs, ServiceAccounts, Endpoints,
// ResourceQuotas, LimitRanges, PDBs, ReplicaSets, Roles, RoleBindings, etc.
type ResourceInfo struct {
	Name      string            `json:"name"`
	Namespace string            `json:"namespace,omitempty"` // empty for cluster-scoped
	Kind      string            `json:"kind"`
	Data      map[string]string `json:"data,omitempty"` // kind-specific summary fields
}

type Event struct {
	Type      string          `json:"type"`
	Context   string          `json:"context,omitempty"`
	Namespace string          `json:"namespace,omitempty"`
	Pod       *PodInfo        `json:"pod,omitempty"`
	Snapshot  []NamespaceInfo `json:"snapshot,omitempty"`
	Node      *NodeInfo       `json:"node,omitempty"`
	Nodes     []NodeInfo      `json:"nodes,omitempty"`
	Service   *ServiceInfo    `json:"service,omitempty"`
	Services  []ServiceInfo   `json:"services,omitempty"`
	Ingress   *IngressInfo    `json:"ingress,omitempty"`
	Ingresses []IngressInfo   `json:"ingresses,omitempty"`
	PVC       *PVCInfo        `json:"pvc,omitempty"`
	PVCs      []PVCInfo       `json:"pvcs,omitempty"`
	Workload  *WorkloadInfo   `json:"workload,omitempty"`
	Workloads []WorkloadInfo  `json:"workloads,omitempty"`
	Resource  *ResourceInfo   `json:"resource,omitempty"`
	Resources []ResourceInfo  `json:"resources,omitempty"`
}

// Traefik IngressRoute GVRs (try traefik.io first, fall back to traefik.containo.us)
var traefikGVRs = []schema.GroupVersionResource{
	{Group: "traefik.io", Version: "v1alpha1", Resource: "ingressroutes"},
	{Group: "traefik.containo.us", Version: "v1alpha1", Resource: "ingressroutes"},
}

// Regex to extract Host(`...`) and PathPrefix(`...`) from Traefik match rules
var (
	reTraefikHost = regexp.MustCompile("Host\\(`([^`]+)`\\)")
	reTraefikPath = regexp.MustCompile("PathPrefix\\(`([^`]+)`\\)")
)

type Watcher struct {
	clientset    *kubernetes.Clientset
	dynClient    dynamic.Interface
	traefikGVR   *schema.GroupVersionResource // resolved GVR, nil if unavailable
	contextName  string
	mu           sync.RWMutex
	namespaces   map[string]*NamespaceInfo
	pods         map[string]map[string]*PodInfo       // ns -> pod name -> pod
	nodes        map[string]*NodeInfo
	services     map[string]map[string]*ServiceInfo    // ns -> svc name -> svc
	ingresses    map[string]map[string]*IngressInfo    // ns -> ingress name -> info
	pvcs         map[string]map[string]*PVCInfo        // ns -> pvc name -> info
	workloads    map[string]map[string]*WorkloadInfo   // ns -> "Kind/name" -> info
	resources    map[string]map[string]map[string]*ResourceInfo // kind -> ns -> name -> info (ns="" for cluster-scoped)
	eventCh      chan Event
	stopCh       chan struct{}
}

func NewWatcher(kubecontext string) (*Watcher, error) {
	rules := clientcmd.NewDefaultClientConfigLoadingRules()
	overrides := &clientcmd.ConfigOverrides{}
	if kubecontext != "" {
		overrides.CurrentContext = kubecontext
	}
	clientConfig := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, overrides)

	// Resolve the current context name
	rawConfig, _ := clientConfig.RawConfig()
	contextName := rawConfig.CurrentContext
	if kubecontext != "" {
		contextName = kubecontext
	}

	config, err := clientConfig.ClientConfig()
	if err != nil {
		return nil, fmt.Errorf("k8s config: %w", err)
	}

	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("k8s client: %w", err)
	}

	dynClient, err := dynamic.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("k8s dynamic client: %w", err)
	}

	return &Watcher{
		clientset:   clientset,
		dynClient:   dynClient,
		contextName: contextName,
		namespaces: make(map[string]*NamespaceInfo),
		pods:       make(map[string]map[string]*PodInfo),
		nodes:      make(map[string]*NodeInfo),
		services:   make(map[string]map[string]*ServiceInfo),
		ingresses:  make(map[string]map[string]*IngressInfo),
		pvcs:       make(map[string]map[string]*PVCInfo),
		workloads:  make(map[string]map[string]*WorkloadInfo),
		resources:  make(map[string]map[string]map[string]*ResourceInfo),
		eventCh:    make(chan Event, 256),
		stopCh:     make(chan struct{}),
	}, nil
}

func (w *Watcher) Events() <-chan Event {
	return w.eventCh
}

// emitSnapshot emits a full snapshot event with all currently loaded data.
func (w *Watcher) emitSnapshot() {
	w.emit(Event{
		Type:      "snapshot",
		Context:   w.contextName,
		Snapshot:  w.Snapshot(),
		Nodes:     w.SnapshotNodes(),
		Services:  w.SnapshotServices(),
		Ingresses: w.SnapshotIngresses(),
		PVCs:      w.SnapshotPVCs(),
		Workloads: w.SnapshotWorkloads(),
		Resources: w.SnapshotResources(),
	})
}

// listPerNamespaceParallel runs fn for each namespace concurrently (max 10 goroutines).
func listPerNamespaceParallel(nsList []corev1.Namespace, fn func(ns corev1.Namespace)) {
	var wg sync.WaitGroup
	sem := make(chan struct{}, 10)
	for _, ns := range nsList {
		wg.Add(1)
		sem <- struct{}{}
		go func(n corev1.Namespace) {
			defer wg.Done()
			defer func() { <-sem }()
			fn(n)
		}(ns)
	}
	wg.Wait()
}

func (w *Watcher) ContextName() string {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.contextName
}

// realKubeconfigPath returns the path to the real ~/.kube/config, bypassing
// kubie's KUBECONFIG override (which points to a temp file with only one context).
func realKubeconfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".kube", "config")
}

// ListContexts returns all available kubeconfig contexts and the current one.
// It reads from ~/.kube/config directly to bypass kubie's KUBECONFIG override.
func ListContexts() (contexts []string, current string, err error) {
	rules := &clientcmd.ClientConfigLoadingRules{ExplicitPath: realKubeconfigPath()}
	clientConfig := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, &clientcmd.ConfigOverrides{})
	rawConfig, err := clientConfig.RawConfig()
	if err != nil {
		return nil, "", fmt.Errorf("load kubeconfig: %w", err)
	}
	current = rawConfig.CurrentContext
	for name := range rawConfig.Contexts {
		contexts = append(contexts, name)
	}
	return contexts, current, nil
}

// SwitchContext stops the current watcher, reinitializes with a new context, and restarts.
// It reads from ~/.kube/config directly to bypass kubie's KUBECONFIG override.
func (w *Watcher) SwitchContext(ctx context.Context, newContext string) error {
	// Stop existing watchers
	w.Stop()

	// Reinitialize k8s clients for the new context using the real kubeconfig
	rules := &clientcmd.ClientConfigLoadingRules{ExplicitPath: realKubeconfigPath()}
	overrides := &clientcmd.ConfigOverrides{}
	if newContext != "" {
		overrides.CurrentContext = newContext
	}
	clientConfig := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, overrides)

	rawConfig, _ := clientConfig.RawConfig()
	contextName := rawConfig.CurrentContext
	if newContext != "" {
		contextName = newContext
	}

	config, err := clientConfig.ClientConfig()
	if err != nil {
		return fmt.Errorf("k8s config for context %q: %w", newContext, err)
	}

	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		return fmt.Errorf("k8s client: %w", err)
	}

	dynClient, err := dynamic.NewForConfig(config)
	if err != nil {
		return fmt.Errorf("k8s dynamic client: %w", err)
	}

	// Reset watcher state under lock
	w.mu.Lock()
	w.clientset = clientset
	w.dynClient = dynClient
	w.contextName = contextName
	w.traefikGVR = nil
	w.namespaces = make(map[string]*NamespaceInfo)
	w.pods = make(map[string]map[string]*PodInfo)
	w.nodes = make(map[string]*NodeInfo)
	w.services = make(map[string]map[string]*ServiceInfo)
	w.ingresses = make(map[string]map[string]*IngressInfo)
	w.pvcs = make(map[string]map[string]*PVCInfo)
	w.workloads = make(map[string]map[string]*WorkloadInfo)
	w.resources = make(map[string]map[string]map[string]*ResourceInfo)
	w.stopCh = make(chan struct{})
	w.mu.Unlock()

	// Restart watchers (Start emits progressive snapshots as resources load)
	if err := w.Start(ctx); err != nil {
		return fmt.Errorf("start watcher for context %q: %w", newContext, err)
	}

	return nil
}

func (w *Watcher) Snapshot() []NamespaceInfo {
	w.mu.RLock()
	defer w.mu.RUnlock()

	result := make([]NamespaceInfo, 0, len(w.namespaces))
	for _, ns := range w.namespaces {
		nsCopy := NamespaceInfo{Name: ns.Name, Status: ns.Status, Forbidden: ns.Forbidden}
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

func isForbidden(err error) bool {
	return k8serrors.IsForbidden(err)
}

func (w *Watcher) Start(ctx context.Context) error {
	// Initial list of namespaces
	nsList, err := w.clientset.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list namespaces: %w", err)
	}

	w.mu.Lock()
	for i := range nsList.Items {
		ns := &nsList.Items[i]
		w.namespaces[ns.Name] = &NamespaceInfo{Name: ns.Name, Status: string(ns.Status.Phase)}
		w.pods[ns.Name] = make(map[string]*PodInfo)
	}
	w.mu.Unlock()

	// Try cluster-wide pod list first, fall back to per-namespace
	podList, err := w.clientset.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
	if err != nil {
		if !isForbidden(err) {
			return fmt.Errorf("list pods: %w", err)
		}
		log.Printf("No cluster-wide pod list permission, listing per namespace")
		var podMu sync.Mutex
		var forbiddenPodCount, accessiblePodCount int32
		listPerNamespaceParallel(nsList.Items, func(ns corev1.Namespace) {
			nsPodList, nsErr := w.clientset.CoreV1().Pods(ns.Name).List(ctx, metav1.ListOptions{})
			if nsErr != nil {
				if isForbidden(nsErr) {
					w.mu.Lock()
					if nsInfo, ok := w.namespaces[ns.Name]; ok {
						nsInfo.Forbidden = true
					}
					w.mu.Unlock()
					podMu.Lock()
					forbiddenPodCount++
					podMu.Unlock()
				}
				return
			}
			w.mu.Lock()
			for i := range nsPodList.Items {
				pod := &nsPodList.Items[i]
				info := podToInfo(pod)
				if w.pods[pod.Namespace] == nil {
					w.pods[pod.Namespace] = make(map[string]*PodInfo)
				}
				w.pods[pod.Namespace][pod.Name] = &info
			}
			w.mu.Unlock()
			podMu.Lock()
			accessiblePodCount++
			podMu.Unlock()
		})
		log.Printf("Pods: %d namespaces accessible, %d forbidden", accessiblePodCount, forbiddenPodCount)
	} else {
		w.mu.Lock()
		for i := range podList.Items {
			pod := &podList.Items[i]
			info := podToInfo(pod)
			if w.pods[pod.Namespace] == nil {
				w.pods[pod.Namespace] = make(map[string]*PodInfo)
			}
			w.pods[pod.Namespace][pod.Name] = &info
		}
		w.mu.Unlock()

		// Even though we can list pods cluster-wide (via view-no-logs),
		// determine which namespaces the user cannot edit (mark as forbidden).
		var sarMu sync.Mutex
		var forbiddenCount int32
		listPerNamespaceParallel(nsList.Items, func(ns corev1.Namespace) {
			sar := &authv1.SelfSubjectAccessReview{
				Spec: authv1.SelfSubjectAccessReviewSpec{
					ResourceAttributes: &authv1.ResourceAttributes{
						Namespace: ns.Name,
						Verb:      "delete",
						Resource:  "pods",
					},
				},
			}
			result, sarErr := w.clientset.AuthorizationV1().SelfSubjectAccessReviews().Create(ctx, sar, metav1.CreateOptions{})
			if sarErr != nil {
				return
			}
			if !result.Status.Allowed {
				w.mu.Lock()
				if nsInfo, ok := w.namespaces[ns.Name]; ok {
					nsInfo.Forbidden = true
				}
				w.mu.Unlock()
				sarMu.Lock()
				forbiddenCount++
				sarMu.Unlock()
			}
		})
		log.Printf("Pods: cluster-wide list OK, %d/%d namespaces forbidden (no edit)", forbiddenCount, len(nsList.Items))
	}

	// Emit snapshot with pods — frontend renders immediately while rest loads
	log.Printf("Emitting initial snapshot (namespaces + pods)")
	w.emitSnapshot()

	// Nodes - optional, skip if forbidden
	nodeList, err := w.clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		if !isForbidden(err) {
			return fmt.Errorf("list nodes: %w", err)
		}
		log.Printf("No permission to list nodes, skipping")
		nodeList = &corev1.NodeList{}
	} else {
		w.mu.Lock()
		for i := range nodeList.Items {
			node := &nodeList.Items[i]
			info := nodeToInfo(node)
			w.nodes[node.Name] = &info
		}
		w.mu.Unlock()
	}

	// Try cluster-wide service list first, fall back to per-namespace
	svcList, err := w.clientset.CoreV1().Services("").List(ctx, metav1.ListOptions{})
	if err != nil {
		if !isForbidden(err) {
			return fmt.Errorf("list services: %w", err)
		}
		log.Printf("No cluster-wide service list permission, listing per namespace")
		var svcMu sync.Mutex
		var forbiddenSvcCount, accessibleSvcCount int32
		listPerNamespaceParallel(nsList.Items, func(ns corev1.Namespace) {
			nsSvcList, nsErr := w.clientset.CoreV1().Services(ns.Name).List(ctx, metav1.ListOptions{})
			if nsErr != nil {
				if isForbidden(nsErr) {
					svcMu.Lock()
					forbiddenSvcCount++
					svcMu.Unlock()
				}
				return
			}
			w.mu.Lock()
			for i := range nsSvcList.Items {
				svc := &nsSvcList.Items[i]
				info := serviceToInfo(svc)
				if w.services[svc.Namespace] == nil {
					w.services[svc.Namespace] = make(map[string]*ServiceInfo)
				}
				w.services[svc.Namespace][svc.Name] = &info
			}
			w.mu.Unlock()
			svcMu.Lock()
			accessibleSvcCount++
			svcMu.Unlock()
		})
		log.Printf("Services: %d namespaces accessible, %d forbidden", accessibleSvcCount, forbiddenSvcCount)
	} else {
		w.mu.Lock()
		for i := range svcList.Items {
			svc := &svcList.Items[i]
			info := serviceToInfo(svc)
			if w.services[svc.Namespace] == nil {
				w.services[svc.Namespace] = make(map[string]*ServiceInfo)
			}
			w.services[svc.Namespace][svc.Name] = &info
		}
		w.mu.Unlock()
	}

	// Ingresses — optional, skip if API not available
	ingList, err := w.clientset.NetworkingV1().Ingresses("").List(ctx, metav1.ListOptions{})
	if err != nil {
		if !isForbidden(err) {
			log.Printf("Cannot list ingresses (skipping): %v", err)
		} else {
			log.Printf("No permission to list ingresses, listing per namespace")
			listPerNamespaceParallel(nsList.Items, func(ns corev1.Namespace) {
				nsIngList, nsErr := w.clientset.NetworkingV1().Ingresses(ns.Name).List(ctx, metav1.ListOptions{})
				if nsErr != nil {
					return
				}
				w.mu.Lock()
				for i := range nsIngList.Items {
					ing := &nsIngList.Items[i]
					info := ingressToInfo(ing)
					if w.ingresses[ing.Namespace] == nil {
						w.ingresses[ing.Namespace] = make(map[string]*IngressInfo)
					}
					w.ingresses[ing.Namespace][ing.Name] = &info
				}
				w.mu.Unlock()
			})
		}
	} else {
		w.mu.Lock()
		for i := range ingList.Items {
			ing := &ingList.Items[i]
			info := ingressToInfo(ing)
			if w.ingresses[ing.Namespace] == nil {
				w.ingresses[ing.Namespace] = make(map[string]*IngressInfo)
			}
			w.ingresses[ing.Namespace][ing.Name] = &info
		}
		w.mu.Unlock()
	}

	// Traefik IngressRoutes — optional, try both API groups
	for _, gvr := range traefikGVRs {
		irList, irErr := w.dynClient.Resource(gvr).Namespace("").List(ctx, metav1.ListOptions{})
		if irErr != nil {
			if !isForbidden(irErr) {
				// CRD doesn't exist or other error — try next GVR
				continue
			}
			// Forbidden cluster-wide — try per-namespace
			log.Printf("No cluster-wide IngressRoute list permission (%s), listing per namespace", gvr.Group)
			var irFound int32
			listPerNamespaceParallel(nsList.Items, func(ns corev1.Namespace) {
				nsIRList, nsErr := w.dynClient.Resource(gvr).Namespace(ns.Name).List(ctx, metav1.ListOptions{})
				if nsErr != nil {
					return
				}
				w.mu.Lock()
				irFound++
				for _, item := range nsIRList.Items {
					infos := ingressRouteToInfos(&item)
					for i := range infos {
						info := infos[i]
						if w.ingresses[info.Namespace] == nil {
							w.ingresses[info.Namespace] = make(map[string]*IngressInfo)
						}
						w.ingresses[info.Namespace][info.Name] = &info
					}
				}
				w.mu.Unlock()
			})
			found := irFound > 0
			if found {
				gvrCopy := gvr
				w.traefikGVR = &gvrCopy
				log.Printf("Traefik IngressRoutes found via %s/%s (per-namespace)", gvr.Group, gvr.Version)
			}
			break
		}
		gvrCopy := gvr
		w.traefikGVR = &gvrCopy
		log.Printf("Traefik IngressRoutes found via %s/%s", gvr.Group, gvr.Version)
		w.mu.Lock()
		for _, item := range irList.Items {
			infos := ingressRouteToInfos(&item)
			for i := range infos {
				info := infos[i]
				if w.ingresses[info.Namespace] == nil {
					w.ingresses[info.Namespace] = make(map[string]*IngressInfo)
				}
				w.ingresses[info.Namespace][info.Name] = &info
			}
		}
		w.mu.Unlock()
		break
	}

	// Emit snapshot with services + ingresses
	log.Printf("Emitting snapshot (+ services, ingresses)")
	w.emitSnapshot()

	// PVCs — optional, skip if forbidden
	pvcList, err := w.clientset.CoreV1().PersistentVolumeClaims("").List(ctx, metav1.ListOptions{})
	if err != nil {
		if !isForbidden(err) {
			log.Printf("Cannot list PVCs (skipping): %v", err)
		} else {
			log.Printf("No permission to list PVCs, listing per namespace")
			listPerNamespaceParallel(nsList.Items, func(ns corev1.Namespace) {
				nsPvcList, nsErr := w.clientset.CoreV1().PersistentVolumeClaims(ns.Name).List(ctx, metav1.ListOptions{})
				if nsErr != nil {
					return
				}
				w.mu.Lock()
				for i := range nsPvcList.Items {
					pvc := &nsPvcList.Items[i]
					info := pvcToInfo(pvc)
					if w.pvcs[pvc.Namespace] == nil {
						w.pvcs[pvc.Namespace] = make(map[string]*PVCInfo)
					}
					w.pvcs[pvc.Namespace][pvc.Name] = &info
				}
				w.mu.Unlock()
			})
		}
	} else {
		w.mu.Lock()
		for i := range pvcList.Items {
			pvc := &pvcList.Items[i]
			info := pvcToInfo(pvc)
			if w.pvcs[pvc.Namespace] == nil {
				w.pvcs[pvc.Namespace] = make(map[string]*PVCInfo)
			}
			w.pvcs[pvc.Namespace][pvc.Name] = &info
		}
		w.mu.Unlock()
	}

	// Deployments — optional
	depList, err := w.clientset.AppsV1().Deployments("").List(ctx, metav1.ListOptions{})
	if err != nil {
		if isForbidden(err) {
			log.Printf("No permission to list deployments, listing per namespace")
			listPerNamespaceParallel(nsList.Items, func(ns corev1.Namespace) {
				nsDepList, nsErr := w.clientset.AppsV1().Deployments(ns.Name).List(ctx, metav1.ListOptions{})
				if nsErr != nil {
					return
				}
				w.mu.Lock()
				for i := range nsDepList.Items {
					dep := &nsDepList.Items[i]
					info := deploymentToInfo(dep)
					key := info.Kind + "/" + info.Name
					if w.workloads[dep.Namespace] == nil {
						w.workloads[dep.Namespace] = make(map[string]*WorkloadInfo)
					}
					w.workloads[dep.Namespace][key] = &info
				}
				w.mu.Unlock()
			})
		} else {
			log.Printf("Cannot list deployments (skipping): %v", err)
		}
	} else {
		w.mu.Lock()
		for i := range depList.Items {
			dep := &depList.Items[i]
			info := deploymentToInfo(dep)
			key := info.Kind + "/" + info.Name
			if w.workloads[dep.Namespace] == nil {
				w.workloads[dep.Namespace] = make(map[string]*WorkloadInfo)
			}
			w.workloads[dep.Namespace][key] = &info
		}
		w.mu.Unlock()
	}

	// StatefulSets — optional
	stsList, err := w.clientset.AppsV1().StatefulSets("").List(ctx, metav1.ListOptions{})
	if err != nil {
		if isForbidden(err) {
			log.Printf("No permission to list statefulsets, listing per namespace")
			listPerNamespaceParallel(nsList.Items, func(ns corev1.Namespace) {
				nsStsList, nsErr := w.clientset.AppsV1().StatefulSets(ns.Name).List(ctx, metav1.ListOptions{})
				if nsErr != nil {
					return
				}
				w.mu.Lock()
				for i := range nsStsList.Items {
					sts := &nsStsList.Items[i]
					info := statefulSetToInfo(sts)
					key := info.Kind + "/" + info.Name
					if w.workloads[sts.Namespace] == nil {
						w.workloads[sts.Namespace] = make(map[string]*WorkloadInfo)
					}
					w.workloads[sts.Namespace][key] = &info
				}
				w.mu.Unlock()
			})
		} else {
			log.Printf("Cannot list statefulsets (skipping): %v", err)
		}
	} else {
		w.mu.Lock()
		for i := range stsList.Items {
			sts := &stsList.Items[i]
			info := statefulSetToInfo(sts)
			key := info.Kind + "/" + info.Name
			if w.workloads[sts.Namespace] == nil {
				w.workloads[sts.Namespace] = make(map[string]*WorkloadInfo)
			}
			w.workloads[sts.Namespace][key] = &info
		}
		w.mu.Unlock()
	}

	// DaemonSets — optional
	dsList, err := w.clientset.AppsV1().DaemonSets("").List(ctx, metav1.ListOptions{})
	if err != nil {
		if isForbidden(err) {
			log.Printf("No permission to list daemonsets, listing per namespace")
			listPerNamespaceParallel(nsList.Items, func(ns corev1.Namespace) {
				nsDsList, nsErr := w.clientset.AppsV1().DaemonSets(ns.Name).List(ctx, metav1.ListOptions{})
				if nsErr != nil {
					return
				}
				w.mu.Lock()
				for i := range nsDsList.Items {
					ds := &nsDsList.Items[i]
					info := daemonSetToInfo(ds)
					key := info.Kind + "/" + info.Name
					if w.workloads[ds.Namespace] == nil {
						w.workloads[ds.Namespace] = make(map[string]*WorkloadInfo)
					}
					w.workloads[ds.Namespace][key] = &info
				}
				w.mu.Unlock()
			})
		} else {
			log.Printf("Cannot list daemonsets (skipping): %v", err)
		}
	} else {
		w.mu.Lock()
		for i := range dsList.Items {
			ds := &dsList.Items[i]
			info := daemonSetToInfo(ds)
			key := info.Kind + "/" + info.Name
			if w.workloads[ds.Namespace] == nil {
				w.workloads[ds.Namespace] = make(map[string]*WorkloadInfo)
			}
			w.workloads[ds.Namespace][key] = &info
		}
		w.mu.Unlock()
	}

	// CronJobs — optional
	cjList, err := w.clientset.BatchV1().CronJobs("").List(ctx, metav1.ListOptions{})
	if err != nil {
		if isForbidden(err) {
			log.Printf("No permission to list cronjobs, listing per namespace")
			listPerNamespaceParallel(nsList.Items, func(ns corev1.Namespace) {
				nsCjList, nsErr := w.clientset.BatchV1().CronJobs(ns.Name).List(ctx, metav1.ListOptions{})
				if nsErr != nil {
					return
				}
				w.mu.Lock()
				for i := range nsCjList.Items {
					cj := &nsCjList.Items[i]
					info := cronJobToInfo(cj)
					key := info.Kind + "/" + info.Name
					if w.workloads[cj.Namespace] == nil {
						w.workloads[cj.Namespace] = make(map[string]*WorkloadInfo)
					}
					w.workloads[cj.Namespace][key] = &info
				}
				w.mu.Unlock()
			})
		} else {
			log.Printf("Cannot list cronjobs (skipping): %v", err)
		}
	} else {
		w.mu.Lock()
		for i := range cjList.Items {
			cj := &cjList.Items[i]
			info := cronJobToInfo(cj)
			key := info.Kind + "/" + info.Name
			if w.workloads[cj.Namespace] == nil {
				w.workloads[cj.Namespace] = make(map[string]*WorkloadInfo)
			}
			w.workloads[cj.Namespace][key] = &info
		}
		w.mu.Unlock()
	}

	// Jobs — optional
	jobList, err := w.clientset.BatchV1().Jobs("").List(ctx, metav1.ListOptions{})
	if err != nil {
		if isForbidden(err) {
			log.Printf("No permission to list jobs, listing per namespace")
			listPerNamespaceParallel(nsList.Items, func(ns corev1.Namespace) {
				nsJobList, nsErr := w.clientset.BatchV1().Jobs(ns.Name).List(ctx, metav1.ListOptions{})
				if nsErr != nil {
					return
				}
				w.mu.Lock()
				for i := range nsJobList.Items {
					job := &nsJobList.Items[i]
					info := jobToInfo(job)
					key := info.Kind + "/" + info.Name
					if w.workloads[job.Namespace] == nil {
						w.workloads[job.Namespace] = make(map[string]*WorkloadInfo)
					}
					w.workloads[job.Namespace][key] = &info
				}
				w.mu.Unlock()
			})
		} else {
			log.Printf("Cannot list jobs (skipping): %v", err)
		}
	} else {
		w.mu.Lock()
		for i := range jobList.Items {
			job := &jobList.Items[i]
			info := jobToInfo(job)
			key := info.Kind + "/" + info.Name
			if w.workloads[job.Namespace] == nil {
				w.workloads[job.Namespace] = make(map[string]*WorkloadInfo)
			}
			w.workloads[job.Namespace][key] = &info
		}
		w.mu.Unlock()
	}

	// Emit snapshot with workloads
	log.Printf("Emitting snapshot (+ PVCs, workloads)")
	w.emitSnapshot()

	// Generic resources (ConfigMaps, Secrets, HPAs, NetworkPolicies, etc.)
	for _, def := range genericResources {
		w.listAndWatchGenericResource(ctx, def)
	}

	// Send final complete snapshot
	log.Printf("Emitting final snapshot (all resources loaded)")
	w.emitSnapshot()

	go w.watchNamespaces(ctx, nsList.ResourceVersion)
	go w.watchPodsAllNamespaces(ctx)
	if len(nodeList.Items) > 0 {
		go w.watchNodes(ctx, nodeList.ResourceVersion)
	}
	go w.watchServicesAllNamespaces(ctx)
	go w.watchIngressesAllNamespaces(ctx)
	if w.traefikGVR != nil {
		go w.watchTraefikIngressRoutes(ctx)
	}
	go w.watchPVCsAllNamespaces(ctx)
	go w.watchDeploymentsAllNamespaces(ctx)
	go w.watchStatefulSetsAllNamespaces(ctx)
	go w.watchDaemonSetsAllNamespaces(ctx)
	go w.watchCronJobsAllNamespaces(ctx)
	go w.watchJobsAllNamespaces(ctx)

	return nil
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
			time.Sleep(2 * time.Second)
			continue
		}

		for event := range watcher.ResultChan() {
			ns, ok := event.Object.(*corev1.Namespace)
			if !ok {
				continue
			}
			rv = ns.ResourceVersion

			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				w.namespaces[ns.Name] = &NamespaceInfo{Name: ns.Name, Status: string(ns.Status.Phase)}
				if w.pods[ns.Name] == nil {
					w.pods[ns.Name] = make(map[string]*PodInfo)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "ns_added", Namespace: ns.Name})

			case watch.Deleted:
				w.mu.Lock()
				delete(w.namespaces, ns.Name)
				delete(w.pods, ns.Name)
				w.mu.Unlock()
				w.emit(Event{Type: "ns_deleted", Namespace: ns.Name})
			}
		}
	}
}

// watchPodsAllNamespaces tries cluster-wide watch first, falls back to per-namespace watches.
func (w *Watcher) watchPodsAllNamespaces(ctx context.Context) {
	// Try cluster-wide watch first
	watcher, err := w.clientset.CoreV1().Pods("").Watch(ctx, metav1.ListOptions{})
	if err == nil {
		watcher.Stop()
		w.watchPods(ctx, "")
		return
	}
	if !isForbidden(err) {
		log.Printf("Pod cluster watch error (non-forbidden): %v", err)
		w.watchPods(ctx, "")
		return
	}

	// Fall back to per-namespace watches
	log.Printf("No cluster-wide pod watch permission, watching per namespace")
	w.mu.RLock()
	namespaces := make([]string, 0, len(w.namespaces))
	for ns := range w.namespaces {
		namespaces = append(namespaces, ns)
	}
	w.mu.RUnlock()

	for _, ns := range namespaces {
		go w.watchPodsNamespace(ctx, ns)
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

		watcher, err := w.clientset.CoreV1().Pods("").Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			if isForbidden(err) {
				log.Printf("Pod cluster watch forbidden, stopping")
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}

		for event := range watcher.ResultChan() {
			pod, ok := event.Object.(*corev1.Pod)
			if !ok {
				continue
			}
			rv = pod.ResourceVersion
			w.handlePodEvent(event.Type, pod)
		}
	}
}

func (w *Watcher) watchPodsNamespace(ctx context.Context, ns string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}

		watcher, err := w.clientset.CoreV1().Pods(ns).Watch(ctx, metav1.ListOptions{})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}

		for event := range watcher.ResultChan() {
			pod, ok := event.Object.(*corev1.Pod)
			if !ok {
				continue
			}
			w.handlePodEvent(event.Type, pod)
		}
	}
}

func (w *Watcher) handlePodEvent(eventType watch.EventType, pod *corev1.Pod) {
	info := podToInfo(pod)

	switch eventType {
	case watch.Added:
		w.mu.Lock()
		if w.pods[pod.Namespace] == nil {
			w.pods[pod.Namespace] = make(map[string]*PodInfo)
		}
		w.pods[pod.Namespace][pod.Name] = &info
		w.mu.Unlock()
		w.emit(Event{Type: "pod_added", Namespace: pod.Namespace, Pod: &info})

	case watch.Modified:
		w.mu.Lock()
		if w.pods[pod.Namespace] == nil {
			w.pods[pod.Namespace] = make(map[string]*PodInfo)
		}
		w.pods[pod.Namespace][pod.Name] = &info
		w.mu.Unlock()
		w.emit(Event{Type: "pod_modified", Namespace: pod.Namespace, Pod: &info})

	case watch.Deleted:
		w.mu.Lock()
		if w.pods[pod.Namespace] != nil {
			delete(w.pods[pod.Namespace], pod.Name)
		}
		w.mu.Unlock()
		w.emit(Event{Type: "pod_deleted", Namespace: pod.Namespace, Pod: &info})
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

func podToInfo(pod *corev1.Pod) PodInfo {
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

	// Collect PVC references
	var pvcNames []string
	for _, v := range pod.Spec.Volumes {
		if v.PersistentVolumeClaim != nil {
			pvcNames = append(pvcNames, v.PersistentVolumeClaim.ClaimName)
		}
	}

	// Resolve owner — walk through ReplicaSet to find Deployment
	var ownerKind, ownerName string
	if len(pod.OwnerReferences) > 0 {
		owner := pod.OwnerReferences[0]
		ownerKind = owner.Kind
		ownerName = owner.Name
		// ReplicaSet is usually owned by a Deployment — surface that instead
		if ownerKind == "ReplicaSet" {
			// Strip the ReplicaSet hash suffix to get the Deployment name
			// e.g. "my-deploy-5d4f7b8c9" -> "my-deploy"
			if idx := lastDashBeforeHash(ownerName); idx > 0 {
				ownerKind = "Deployment"
				ownerName = ownerName[:idx]
			}
		}
	}

	return PodInfo{
		Name:           pod.Name,
		Namespace:      pod.Namespace,
		Status:         status,
		Ready:          ready,
		Restarts:       restarts,
		Age:            age,
		NodeName:       pod.Spec.NodeName,
		CPURequest:     cpuMillis,
		MemoryRequest:  memBytes,
		Labels:         pod.Labels,
		OwnerKind:      ownerKind,
		OwnerName:      ownerName,
		ContainerCount: len(pod.Spec.Containers),
		PVCNames:       pvcNames,
	}
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
	info := ServiceInfo{
		Name:      svc.Name,
		Namespace: svc.Namespace,
		Type:      string(svc.Spec.Type),
		ClusterIP: svc.Spec.ClusterIP,
		Selector:  svc.Spec.Selector,
	}
	for _, p := range svc.Spec.Ports {
		info.Ports = append(info.Ports, ServicePortInfo{
			Name:       p.Name,
			Port:       p.Port,
			TargetPort: p.TargetPort.String(),
			Protocol:   string(p.Protocol),
		})
	}
	return info
}

func ingressToInfo(ing *networkingv1.Ingress) IngressInfo {
	info := IngressInfo{
		Name:      ing.Name,
		Namespace: ing.Namespace,
	}
	for _, rule := range ing.Spec.Rules {
		if rule.HTTP == nil {
			continue
		}
		for _, path := range rule.HTTP.Paths {
			port := ""
			if path.Backend.Service != nil && path.Backend.Service.Port.Number != 0 {
				port = fmt.Sprintf("%d", path.Backend.Service.Port.Number)
			} else if path.Backend.Service != nil && path.Backend.Service.Port.Name != "" {
				port = path.Backend.Service.Port.Name
			}
			svcName := ""
			if path.Backend.Service != nil {
				svcName = path.Backend.Service.Name
			}
			info.Rules = append(info.Rules, IngressRuleInfo{
				Host:        rule.Host,
				Path:        path.Path,
				ServiceName: svcName,
				ServicePort: port,
			})
		}
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
		info.StorageClass = *pvc.Spec.StorageClassName
	}
	if storage, ok := pvc.Status.Capacity[corev1.ResourceStorage]; ok {
		info.Capacity = storage.Value()
	} else if req, ok := pvc.Spec.Resources.Requests[corev1.ResourceStorage]; ok {
		info.Capacity = req.Value()
	}
	return info
}

func deploymentToInfo(dep *appsv1.Deployment) WorkloadInfo {
	replicas := int32(1)
	if dep.Spec.Replicas != nil {
		replicas = *dep.Spec.Replicas
	}
	return WorkloadInfo{
		Name:            dep.Name,
		Namespace:       dep.Namespace,
		Kind:            "Deployment",
		Replicas:        replicas,
		ReadyReplicas:   dep.Status.ReadyReplicas,
		UpdatedReplicas: dep.Status.UpdatedReplicas,
	}
}

func statefulSetToInfo(sts *appsv1.StatefulSet) WorkloadInfo {
	replicas := int32(1)
	if sts.Spec.Replicas != nil {
		replicas = *sts.Spec.Replicas
	}
	return WorkloadInfo{
		Name:            sts.Name,
		Namespace:       sts.Namespace,
		Kind:            "StatefulSet",
		Replicas:        replicas,
		ReadyReplicas:   sts.Status.ReadyReplicas,
		UpdatedReplicas: sts.Status.UpdatedReplicas,
	}
}

func cronJobToInfo(cj *batchv1.CronJob) WorkloadInfo {
	info := WorkloadInfo{
		Name:       cj.Name,
		Namespace:  cj.Namespace,
		Kind:       "CronJob",
		Schedule:   cj.Spec.Schedule,
		ActiveJobs: int32(len(cj.Status.Active)),
	}
	if cj.Spec.Suspend != nil && *cj.Spec.Suspend {
		info.Suspended = true
	}
	if cj.Status.LastScheduleTime != nil {
		info.LastSchedule = cj.Status.LastScheduleTime.Format(time.RFC3339)
	}
	return info
}

func daemonSetToInfo(ds *appsv1.DaemonSet) WorkloadInfo {
	return WorkloadInfo{
		Name:            ds.Name,
		Namespace:       ds.Namespace,
		Kind:            "DaemonSet",
		Replicas:        ds.Status.DesiredNumberScheduled,
		ReadyReplicas:   ds.Status.NumberReady,
		UpdatedReplicas: ds.Status.UpdatedNumberScheduled,
	}
}

func jobToInfo(job *batchv1.Job) WorkloadInfo {
	replicas := int32(1)
	if job.Spec.Parallelism != nil {
		replicas = *job.Spec.Parallelism
	}
	return WorkloadInfo{
		Name:          job.Name,
		Namespace:     job.Namespace,
		Kind:          "Job",
		Replicas:      replicas,
		ReadyReplicas: job.Status.Succeeded,
		ActiveJobs:    job.Status.Active,
	}
}

func (w *Watcher) SnapshotIngresses() []IngressInfo {
	w.mu.RLock()
	defer w.mu.RUnlock()
	result := make([]IngressInfo, 0)
	for _, ings := range w.ingresses {
		for _, i := range ings {
			result = append(result, *i)
		}
	}
	return result
}

func (w *Watcher) SnapshotPVCs() []PVCInfo {
	w.mu.RLock()
	defer w.mu.RUnlock()
	result := make([]PVCInfo, 0)
	for _, pvcs := range w.pvcs {
		for _, p := range pvcs {
			result = append(result, *p)
		}
	}
	return result
}

func (w *Watcher) SnapshotWorkloads() []WorkloadInfo {
	w.mu.RLock()
	defer w.mu.RUnlock()
	result := make([]WorkloadInfo, 0)
	for _, wls := range w.workloads {
		for _, wl := range wls {
			result = append(result, *wl)
		}
	}
	return result
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
			time.Sleep(2 * time.Second)
			continue
		}

		for event := range watcher.ResultChan() {
			node, ok := event.Object.(*corev1.Node)
			if !ok {
				continue
			}
			rv = node.ResourceVersion
			info := nodeToInfo(node)

			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				w.nodes[node.Name] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "node_updated", Node: &info})

			case watch.Deleted:
				w.mu.Lock()
				delete(w.nodes, node.Name)
				w.mu.Unlock()
				w.emit(Event{Type: "node_deleted", Node: &info})
			}
		}
	}
}

// watchServicesAllNamespaces tries cluster-wide watch first, falls back to per-namespace watches.
func (w *Watcher) watchServicesAllNamespaces(ctx context.Context) {
	watcher, err := w.clientset.CoreV1().Services("").Watch(ctx, metav1.ListOptions{})
	if err == nil {
		watcher.Stop()
		w.watchServices(ctx, "")
		return
	}
	if !isForbidden(err) {
		log.Printf("Service cluster watch error (non-forbidden): %v", err)
		w.watchServices(ctx, "")
		return
	}

	log.Printf("No cluster-wide service watch permission, watching per namespace")
	w.mu.RLock()
	namespaces := make([]string, 0, len(w.namespaces))
	for ns := range w.namespaces {
		namespaces = append(namespaces, ns)
	}
	w.mu.RUnlock()

	for _, ns := range namespaces {
		go w.watchServicesNamespace(ctx, ns)
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

		watcher, err := w.clientset.CoreV1().Services("").Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			if isForbidden(err) {
				log.Printf("Service cluster watch forbidden, stopping")
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}

		for event := range watcher.ResultChan() {
			svc, ok := event.Object.(*corev1.Service)
			if !ok {
				continue
			}
			rv = svc.ResourceVersion
			w.handleServiceEvent(event.Type, svc)
		}
	}
}

func (w *Watcher) watchServicesNamespace(ctx context.Context, ns string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}

		watcher, err := w.clientset.CoreV1().Services(ns).Watch(ctx, metav1.ListOptions{})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}

		for event := range watcher.ResultChan() {
			svc, ok := event.Object.(*corev1.Service)
			if !ok {
				continue
			}
			w.handleServiceEvent(event.Type, svc)
		}
	}
}

func (w *Watcher) handleServiceEvent(eventType watch.EventType, svc *corev1.Service) {
	info := serviceToInfo(svc)

	switch eventType {
	case watch.Added, watch.Modified:
		w.mu.Lock()
		if w.services[svc.Namespace] == nil {
			w.services[svc.Namespace] = make(map[string]*ServiceInfo)
		}
		w.services[svc.Namespace][svc.Name] = &info
		w.mu.Unlock()
		w.emit(Event{Type: "svc_updated", Namespace: svc.Namespace, Service: &info})

	case watch.Deleted:
		w.mu.Lock()
		if w.services[svc.Namespace] != nil {
			delete(w.services[svc.Namespace], svc.Name)
		}
		w.mu.Unlock()
		w.emit(Event{Type: "svc_deleted", Namespace: svc.Namespace, Service: &info})
	}
}

// ── Ingress watchers ─────────────────────────────────────────────

func (w *Watcher) watchIngressesAllNamespaces(ctx context.Context) {
	watcher, err := w.clientset.NetworkingV1().Ingresses("").Watch(ctx, metav1.ListOptions{})
	if err == nil {
		watcher.Stop()
		w.watchIngresses(ctx, "")
		return
	}
	if !isForbidden(err) {
		return
	}
	log.Printf("No cluster-wide ingress watch permission, watching per namespace")
	w.mu.RLock()
	namespaces := make([]string, 0, len(w.namespaces))
	for ns := range w.namespaces {
		namespaces = append(namespaces, ns)
	}
	w.mu.RUnlock()
	for _, ns := range namespaces {
		go w.watchIngressesNamespace(ctx, ns)
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
		watcher, err := w.clientset.NetworkingV1().Ingresses("").Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			ing, ok := event.Object.(*networkingv1.Ingress)
			if !ok {
				continue
			}
			rv = ing.ResourceVersion
			w.handleIngressEvent(event.Type, ing)
		}
	}
}

func (w *Watcher) watchIngressesNamespace(ctx context.Context, ns string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}
		watcher, err := w.clientset.NetworkingV1().Ingresses(ns).Watch(ctx, metav1.ListOptions{})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			ing, ok := event.Object.(*networkingv1.Ingress)
			if !ok {
				continue
			}
			w.handleIngressEvent(event.Type, ing)
		}
	}
}

func (w *Watcher) handleIngressEvent(eventType watch.EventType, ing *networkingv1.Ingress) {
	info := ingressToInfo(ing)
	switch eventType {
	case watch.Added, watch.Modified:
		w.mu.Lock()
		if w.ingresses[ing.Namespace] == nil {
			w.ingresses[ing.Namespace] = make(map[string]*IngressInfo)
		}
		w.ingresses[ing.Namespace][ing.Name] = &info
		w.mu.Unlock()
		w.emit(Event{Type: "ingress_updated", Namespace: ing.Namespace, Ingress: &info})
	case watch.Deleted:
		w.mu.Lock()
		if w.ingresses[ing.Namespace] != nil {
			delete(w.ingresses[ing.Namespace], ing.Name)
		}
		w.mu.Unlock()
		w.emit(Event{Type: "ingress_deleted", Namespace: ing.Namespace, Ingress: &info})
	}
}

// ── Traefik IngressRoute watchers ────────────────────────────────

// ingressRouteToInfos converts a Traefik IngressRoute unstructured object
// into one or more IngressInfo (one per route entry with services).
func ingressRouteToInfos(obj *unstructured.Unstructured) []IngressInfo {
	name := obj.GetName()
	namespace := obj.GetNamespace()

	spec, ok := obj.Object["spec"].(map[string]interface{})
	if !ok {
		return nil
	}

	routes, ok := spec["routes"].([]interface{})
	if !ok {
		return nil
	}

	// Determine TLS (if tls section exists, use https)
	scheme := "http"
	if _, hasTLS := spec["tls"]; hasTLS {
		scheme = "https"
	}

	info := IngressInfo{
		Name:      "tr:" + name, // prefix to distinguish from standard Ingress
		Namespace: namespace,
	}

	for _, r := range routes {
		route, ok := r.(map[string]interface{})
		if !ok {
			continue
		}

		matchStr, _ := route["match"].(string)
		if matchStr == "" {
			continue
		}

		// Extract host and path from match rule
		host := ""
		path := "/"
		if m := reTraefikHost.FindStringSubmatch(matchStr); len(m) > 1 {
			host = m[1]
		}
		if m := reTraefikPath.FindStringSubmatch(matchStr); len(m) > 1 {
			path = m[1]
		}

		// Extract services
		services, _ := route["services"].([]interface{})
		if len(services) == 0 {
			info.Rules = append(info.Rules, IngressRuleInfo{
				Host: host,
				Path: path,
			})
			continue
		}

		for _, s := range services {
			svc, ok := s.(map[string]interface{})
			if !ok {
				continue
			}
			svcName, _ := svc["name"].(string)
			svcNs, _ := svc["namespace"].(string)
			svcPort := ""
			if p, ok := svc["port"].(float64); ok {
				svcPort = fmt.Sprintf("%d", int(p))
			} else if p, ok := svc["port"].(int64); ok {
				svcPort = fmt.Sprintf("%d", p)
			} else if p, ok := svc["port"].(string); ok {
				svcPort = p
			}

			rule := IngressRuleInfo{
				Host:             host,
				Path:             path,
				ServiceName:      svcName,
				ServicePort:      svcPort,
				ServiceNamespace: svcNs,
			}
			info.Rules = append(info.Rules, rule)
		}
	}

	_ = scheme // scheme info is implicit from host — frontend builds URLs from host+path
	if len(info.Rules) == 0 {
		return nil
	}
	return []IngressInfo{info}
}

func (w *Watcher) watchTraefikIngressRoutes(ctx context.Context) {
	gvr := *w.traefikGVR
	var rv string

	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}

		opts := metav1.ListOptions{}
		if rv != "" {
			opts.ResourceVersion = rv
		}
		watcher, err := w.dynClient.Resource(gvr).Namespace("").Watch(ctx, opts)
		if err != nil {
			if isForbidden(err) {
				log.Printf("Traefik IngressRoute watch forbidden, trying per-namespace")
				w.watchTraefikIngressRoutesPerNS(ctx, gvr)
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}

		for event := range watcher.ResultChan() {
			obj, ok := event.Object.(*unstructured.Unstructured)
			if !ok {
				continue
			}
			rv = obj.GetResourceVersion()
			w.handleTraefikEvent(event.Type, obj)
		}
	}
}

func (w *Watcher) watchTraefikIngressRoutesPerNS(ctx context.Context, gvr schema.GroupVersionResource) {
	w.mu.RLock()
	namespaces := make([]string, 0, len(w.namespaces))
	for ns := range w.namespaces {
		namespaces = append(namespaces, ns)
	}
	w.mu.RUnlock()

	for _, ns := range namespaces {
		go func(ns string) {
			for {
				select {
				case <-ctx.Done():
					return
				case <-w.stopCh:
					return
				default:
				}

				watcher, err := w.dynClient.Resource(gvr).Namespace(ns).Watch(ctx, metav1.ListOptions{})
				if err != nil {
					if isForbidden(err) {
						return
					}
					time.Sleep(2 * time.Second)
					continue
				}

				for event := range watcher.ResultChan() {
					obj, ok := event.Object.(*unstructured.Unstructured)
					if !ok {
						continue
					}
					w.handleTraefikEvent(event.Type, obj)
				}
			}
		}(ns)
	}
}

func (w *Watcher) handleTraefikEvent(eventType watch.EventType, obj *unstructured.Unstructured) {
	infos := ingressRouteToInfos(obj)

	switch eventType {
	case watch.Added, watch.Modified:
		w.mu.Lock()
		for i := range infos {
			info := infos[i]
			if w.ingresses[info.Namespace] == nil {
				w.ingresses[info.Namespace] = make(map[string]*IngressInfo)
			}
			w.ingresses[info.Namespace][info.Name] = &info
			w.mu.Unlock()
			w.emit(Event{Type: "ingress_updated", Namespace: info.Namespace, Ingress: &info})
			w.mu.Lock()
		}
		w.mu.Unlock()

	case watch.Deleted:
		ns := obj.GetNamespace()
		name := "tr:" + obj.GetName()
		w.mu.Lock()
		if w.ingresses[ns] != nil {
			delete(w.ingresses[ns], name)
		}
		w.mu.Unlock()
		w.emit(Event{Type: "ingress_deleted", Namespace: ns, Ingress: &IngressInfo{Name: name, Namespace: ns}})
	}
}

// ── PVC watchers ─────────────────────────────────────────────────

func (w *Watcher) watchPVCsAllNamespaces(ctx context.Context) {
	watcher, err := w.clientset.CoreV1().PersistentVolumeClaims("").Watch(ctx, metav1.ListOptions{})
	if err == nil {
		watcher.Stop()
		w.watchPVCs(ctx, "")
		return
	}
	if !isForbidden(err) {
		return
	}
	log.Printf("No cluster-wide PVC watch permission, watching per namespace")
	w.mu.RLock()
	namespaces := make([]string, 0, len(w.namespaces))
	for ns := range w.namespaces {
		namespaces = append(namespaces, ns)
	}
	w.mu.RUnlock()
	for _, ns := range namespaces {
		go w.watchPVCsNamespace(ctx, ns)
	}
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
		watcher, err := w.clientset.CoreV1().PersistentVolumeClaims("").Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			pvc, ok := event.Object.(*corev1.PersistentVolumeClaim)
			if !ok {
				continue
			}
			rv = pvc.ResourceVersion
			w.handlePVCEvent(event.Type, pvc)
		}
	}
}

func (w *Watcher) watchPVCsNamespace(ctx context.Context, ns string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}
		watcher, err := w.clientset.CoreV1().PersistentVolumeClaims(ns).Watch(ctx, metav1.ListOptions{})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			pvc, ok := event.Object.(*corev1.PersistentVolumeClaim)
			if !ok {
				continue
			}
			w.handlePVCEvent(event.Type, pvc)
		}
	}
}

func (w *Watcher) handlePVCEvent(eventType watch.EventType, pvc *corev1.PersistentVolumeClaim) {
	info := pvcToInfo(pvc)
	switch eventType {
	case watch.Added, watch.Modified:
		w.mu.Lock()
		if w.pvcs[pvc.Namespace] == nil {
			w.pvcs[pvc.Namespace] = make(map[string]*PVCInfo)
		}
		w.pvcs[pvc.Namespace][pvc.Name] = &info
		w.mu.Unlock()
		w.emit(Event{Type: "pvc_updated", Namespace: pvc.Namespace, PVC: &info})
	case watch.Deleted:
		w.mu.Lock()
		if w.pvcs[pvc.Namespace] != nil {
			delete(w.pvcs[pvc.Namespace], pvc.Name)
		}
		w.mu.Unlock()
		w.emit(Event{Type: "pvc_deleted", Namespace: pvc.Namespace, PVC: &info})
	}
}

// ── Deployment watchers ──────────────────────────────────────────

func (w *Watcher) watchDeploymentsAllNamespaces(ctx context.Context) {
	watcher, err := w.clientset.AppsV1().Deployments("").Watch(ctx, metav1.ListOptions{})
	if err == nil {
		watcher.Stop()
		w.watchDeployments(ctx, "")
		return
	}
	if !isForbidden(err) {
		return
	}
	log.Printf("No cluster-wide deployment watch permission, watching per namespace")
	w.mu.RLock()
	namespaces := make([]string, 0, len(w.namespaces))
	for ns := range w.namespaces {
		namespaces = append(namespaces, ns)
	}
	w.mu.RUnlock()
	for _, ns := range namespaces {
		go w.watchDeploymentsNamespace(ctx, ns)
	}
}

func (w *Watcher) watchDeployments(ctx context.Context, rv string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}
		watcher, err := w.clientset.AppsV1().Deployments("").Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			dep, ok := event.Object.(*appsv1.Deployment)
			if !ok {
				continue
			}
			rv = dep.ResourceVersion
			info := deploymentToInfo(dep)
			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[dep.Namespace] == nil {
					w.workloads[dep.Namespace] = make(map[string]*WorkloadInfo)
				}
				w.workloads[dep.Namespace][key] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "workload_updated", Namespace: dep.Namespace, Workload: &info})
			case watch.Deleted:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[dep.Namespace] != nil {
					delete(w.workloads[dep.Namespace], key)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "workload_deleted", Namespace: dep.Namespace, Workload: &info})
			}
		}
	}
}

func (w *Watcher) watchDeploymentsNamespace(ctx context.Context, ns string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}
		watcher, err := w.clientset.AppsV1().Deployments(ns).Watch(ctx, metav1.ListOptions{})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			dep, ok := event.Object.(*appsv1.Deployment)
			if !ok {
				continue
			}
			info := deploymentToInfo(dep)
			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[dep.Namespace] == nil {
					w.workloads[dep.Namespace] = make(map[string]*WorkloadInfo)
				}
				w.workloads[dep.Namespace][key] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "workload_updated", Namespace: dep.Namespace, Workload: &info})
			case watch.Deleted:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[dep.Namespace] != nil {
					delete(w.workloads[dep.Namespace], key)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "workload_deleted", Namespace: dep.Namespace, Workload: &info})
			}
		}
	}
}

// ── StatefulSet watchers ─────────────────────────────────────────

func (w *Watcher) watchStatefulSetsAllNamespaces(ctx context.Context) {
	watcher, err := w.clientset.AppsV1().StatefulSets("").Watch(ctx, metav1.ListOptions{})
	if err == nil {
		watcher.Stop()
		w.watchStatefulSets(ctx, "")
		return
	}
	if !isForbidden(err) {
		return
	}
	log.Printf("No cluster-wide statefulset watch permission, watching per namespace")
	w.mu.RLock()
	namespaces := make([]string, 0, len(w.namespaces))
	for ns := range w.namespaces {
		namespaces = append(namespaces, ns)
	}
	w.mu.RUnlock()
	for _, ns := range namespaces {
		go w.watchStatefulSetsNamespace(ctx, ns)
	}
}

func (w *Watcher) watchStatefulSets(ctx context.Context, rv string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}
		watcher, err := w.clientset.AppsV1().StatefulSets("").Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			sts, ok := event.Object.(*appsv1.StatefulSet)
			if !ok {
				continue
			}
			rv = sts.ResourceVersion
			info := statefulSetToInfo(sts)
			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[sts.Namespace] == nil {
					w.workloads[sts.Namespace] = make(map[string]*WorkloadInfo)
				}
				w.workloads[sts.Namespace][key] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "workload_updated", Namespace: sts.Namespace, Workload: &info})
			case watch.Deleted:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[sts.Namespace] != nil {
					delete(w.workloads[sts.Namespace], key)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "workload_deleted", Namespace: sts.Namespace, Workload: &info})
			}
		}
	}
}

func (w *Watcher) watchStatefulSetsNamespace(ctx context.Context, ns string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}
		watcher, err := w.clientset.AppsV1().StatefulSets(ns).Watch(ctx, metav1.ListOptions{})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			sts, ok := event.Object.(*appsv1.StatefulSet)
			if !ok {
				continue
			}
			info := statefulSetToInfo(sts)
			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[sts.Namespace] == nil {
					w.workloads[sts.Namespace] = make(map[string]*WorkloadInfo)
				}
				w.workloads[sts.Namespace][key] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "workload_updated", Namespace: sts.Namespace, Workload: &info})
			case watch.Deleted:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[sts.Namespace] != nil {
					delete(w.workloads[sts.Namespace], key)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "workload_deleted", Namespace: sts.Namespace, Workload: &info})
			}
		}
	}
}

// ── DaemonSet watchers ───────────────────────────────────────────

func (w *Watcher) watchDaemonSetsAllNamespaces(ctx context.Context) {
	watcher, err := w.clientset.AppsV1().DaemonSets("").Watch(ctx, metav1.ListOptions{})
	if err == nil {
		watcher.Stop()
		w.watchDaemonSets(ctx, "")
		return
	}
	if !isForbidden(err) {
		return
	}
	log.Printf("No cluster-wide daemonset watch permission, watching per namespace")
	w.mu.RLock()
	namespaces := make([]string, 0, len(w.namespaces))
	for ns := range w.namespaces {
		namespaces = append(namespaces, ns)
	}
	w.mu.RUnlock()
	for _, ns := range namespaces {
		go w.watchDaemonSetsNamespace(ctx, ns)
	}
}

func (w *Watcher) watchDaemonSets(ctx context.Context, rv string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}
		watcher, err := w.clientset.AppsV1().DaemonSets("").Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			ds, ok := event.Object.(*appsv1.DaemonSet)
			if !ok {
				continue
			}
			rv = ds.ResourceVersion
			info := daemonSetToInfo(ds)
			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[ds.Namespace] == nil {
					w.workloads[ds.Namespace] = make(map[string]*WorkloadInfo)
				}
				w.workloads[ds.Namespace][key] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "workload_updated", Namespace: ds.Namespace, Workload: &info})
			case watch.Deleted:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[ds.Namespace] != nil {
					delete(w.workloads[ds.Namespace], key)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "workload_deleted", Namespace: ds.Namespace, Workload: &info})
			}
		}
	}
}

func (w *Watcher) watchDaemonSetsNamespace(ctx context.Context, ns string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}
		watcher, err := w.clientset.AppsV1().DaemonSets(ns).Watch(ctx, metav1.ListOptions{})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			ds, ok := event.Object.(*appsv1.DaemonSet)
			if !ok {
				continue
			}
			info := daemonSetToInfo(ds)
			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[ds.Namespace] == nil {
					w.workloads[ds.Namespace] = make(map[string]*WorkloadInfo)
				}
				w.workloads[ds.Namespace][key] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "workload_updated", Namespace: ds.Namespace, Workload: &info})
			case watch.Deleted:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[ds.Namespace] != nil {
					delete(w.workloads[ds.Namespace], key)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "workload_deleted", Namespace: ds.Namespace, Workload: &info})
			}
		}
	}
}

// ── CronJob watchers ─────────────────────────────────────────────

func (w *Watcher) watchCronJobsAllNamespaces(ctx context.Context) {
	watcher, err := w.clientset.BatchV1().CronJobs("").Watch(ctx, metav1.ListOptions{})
	if err == nil {
		watcher.Stop()
		w.watchCronJobs(ctx, "")
		return
	}
	if !isForbidden(err) {
		return
	}
	log.Printf("No cluster-wide cronjob watch permission, watching per namespace")
	w.mu.RLock()
	namespaces := make([]string, 0, len(w.namespaces))
	for ns := range w.namespaces {
		namespaces = append(namespaces, ns)
	}
	w.mu.RUnlock()
	for _, ns := range namespaces {
		go w.watchCronJobsNamespace(ctx, ns)
	}
}

func (w *Watcher) watchCronJobs(ctx context.Context, rv string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}
		watcher, err := w.clientset.BatchV1().CronJobs("").Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			cj, ok := event.Object.(*batchv1.CronJob)
			if !ok {
				continue
			}
			rv = cj.ResourceVersion
			info := cronJobToInfo(cj)
			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[cj.Namespace] == nil {
					w.workloads[cj.Namespace] = make(map[string]*WorkloadInfo)
				}
				w.workloads[cj.Namespace][key] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "workload_updated", Namespace: cj.Namespace, Workload: &info})
			case watch.Deleted:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[cj.Namespace] != nil {
					delete(w.workloads[cj.Namespace], key)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "workload_deleted", Namespace: cj.Namespace, Workload: &info})
			}
		}
	}
}

func (w *Watcher) watchCronJobsNamespace(ctx context.Context, ns string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}
		watcher, err := w.clientset.BatchV1().CronJobs(ns).Watch(ctx, metav1.ListOptions{})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			cj, ok := event.Object.(*batchv1.CronJob)
			if !ok {
				continue
			}
			info := cronJobToInfo(cj)
			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[cj.Namespace] == nil {
					w.workloads[cj.Namespace] = make(map[string]*WorkloadInfo)
				}
				w.workloads[cj.Namespace][key] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "workload_updated", Namespace: cj.Namespace, Workload: &info})
			case watch.Deleted:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[cj.Namespace] != nil {
					delete(w.workloads[cj.Namespace], key)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "workload_deleted", Namespace: cj.Namespace, Workload: &info})
			}
		}
	}
}

// ── Job watchers ─────────────────────────────────────────────────

func (w *Watcher) watchJobsAllNamespaces(ctx context.Context) {
	watcher, err := w.clientset.BatchV1().Jobs("").Watch(ctx, metav1.ListOptions{})
	if err == nil {
		watcher.Stop()
		w.watchJobs(ctx, "")
		return
	}
	if !isForbidden(err) {
		return
	}
	log.Printf("No cluster-wide job watch permission, watching per namespace")
	w.mu.RLock()
	namespaces := make([]string, 0, len(w.namespaces))
	for ns := range w.namespaces {
		namespaces = append(namespaces, ns)
	}
	w.mu.RUnlock()
	for _, ns := range namespaces {
		go w.watchJobsNamespace(ctx, ns)
	}
}

func (w *Watcher) watchJobs(ctx context.Context, rv string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}
		watcher, err := w.clientset.BatchV1().Jobs("").Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			job, ok := event.Object.(*batchv1.Job)
			if !ok {
				continue
			}
			rv = job.ResourceVersion
			info := jobToInfo(job)
			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[job.Namespace] == nil {
					w.workloads[job.Namespace] = make(map[string]*WorkloadInfo)
				}
				w.workloads[job.Namespace][key] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "workload_updated", Namespace: job.Namespace, Workload: &info})
			case watch.Deleted:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[job.Namespace] != nil {
					delete(w.workloads[job.Namespace], key)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "workload_deleted", Namespace: job.Namespace, Workload: &info})
			}
		}
	}
}

func (w *Watcher) watchJobsNamespace(ctx context.Context, ns string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}
		watcher, err := w.clientset.BatchV1().Jobs(ns).Watch(ctx, metav1.ListOptions{})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			job, ok := event.Object.(*batchv1.Job)
			if !ok {
				continue
			}
			info := jobToInfo(job)
			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[job.Namespace] == nil {
					w.workloads[job.Namespace] = make(map[string]*WorkloadInfo)
				}
				w.workloads[job.Namespace][key] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "workload_updated", Namespace: job.Namespace, Workload: &info})
			case watch.Deleted:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[job.Namespace] != nil {
					delete(w.workloads[job.Namespace], key)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "workload_deleted", Namespace: job.Namespace, Workload: &info})
			}
		}
	}
}

// ── Generic resource watchers ────────────────────────────────────

// genericResourceDefs lists all additional resource types we watch via the dynamic client.
// Each entry defines the GVR, kind label, whether it's cluster-scoped, and a converter.
type genericResourceDef struct {
	GVR           schema.GroupVersionResource
	Kind          string
	ClusterScoped bool
	ToInfo        func(obj *unstructured.Unstructured) ResourceInfo
}

var genericResources = []genericResourceDef{
	{
		GVR:  schema.GroupVersionResource{Group: "", Version: "v1", Resource: "configmaps"},
		Kind: "ConfigMap",
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			dataMap, _, _ := unstructured.NestedMap(obj.Object, "data")
			return ResourceInfo{Name: obj.GetName(), Namespace: obj.GetNamespace(), Kind: "ConfigMap",
				Data: map[string]string{"keys": fmt.Sprintf("%d", len(dataMap))}}
		},
	},
	{
		GVR:  schema.GroupVersionResource{Group: "", Version: "v1", Resource: "secrets"},
		Kind: "Secret",
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			sType, _, _ := unstructured.NestedString(obj.Object, "type")
			dataMap, _, _ := unstructured.NestedMap(obj.Object, "data")
			return ResourceInfo{Name: obj.GetName(), Namespace: obj.GetNamespace(), Kind: "Secret",
				Data: map[string]string{"type": sType, "keys": fmt.Sprintf("%d", len(dataMap))}}
		},
	},
	{
		GVR:  schema.GroupVersionResource{Group: "", Version: "v1", Resource: "serviceaccounts"},
		Kind: "ServiceAccount",
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			return ResourceInfo{Name: obj.GetName(), Namespace: obj.GetNamespace(), Kind: "ServiceAccount"}
		},
	},
	{
		GVR:  schema.GroupVersionResource{Group: "discovery.k8s.io", Version: "v1", Resource: "endpointslices"},
		Kind: "EndpointSlice",
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			return ResourceInfo{Name: obj.GetName(), Namespace: obj.GetNamespace(), Kind: "EndpointSlice"}
		},
	},
	{
		GVR:  schema.GroupVersionResource{Group: "", Version: "v1", Resource: "resourcequotas"},
		Kind: "ResourceQuota",
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			return ResourceInfo{Name: obj.GetName(), Namespace: obj.GetNamespace(), Kind: "ResourceQuota"}
		},
	},
	{
		GVR:  schema.GroupVersionResource{Group: "", Version: "v1", Resource: "limitranges"},
		Kind: "LimitRange",
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			return ResourceInfo{Name: obj.GetName(), Namespace: obj.GetNamespace(), Kind: "LimitRange"}
		},
	},
	{
		GVR:           schema.GroupVersionResource{Group: "", Version: "v1", Resource: "persistentvolumes"},
		Kind:          "PersistentVolume",
		ClusterScoped: true,
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			phase, _, _ := unstructured.NestedString(obj.Object, "status", "phase")
			return ResourceInfo{Name: obj.GetName(), Kind: "PersistentVolume",
				Data: map[string]string{"phase": phase}}
		},
	},
	{
		GVR:  schema.GroupVersionResource{Group: "autoscaling", Version: "v2", Resource: "horizontalpodautoscalers"},
		Kind: "HPA",
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			targetRef, _, _ := unstructured.NestedString(obj.Object, "spec", "scaleTargetRef", "name")
			minR, _, _ := unstructured.NestedInt64(obj.Object, "spec", "minReplicas")
			maxR, _, _ := unstructured.NestedInt64(obj.Object, "spec", "maxReplicas")
			curR, _, _ := unstructured.NestedInt64(obj.Object, "status", "currentReplicas")
			return ResourceInfo{Name: obj.GetName(), Namespace: obj.GetNamespace(), Kind: "HPA",
				Data: map[string]string{"target": targetRef, "min": fmt.Sprintf("%d", minR), "max": fmt.Sprintf("%d", maxR), "current": fmt.Sprintf("%d", curR)}}
		},
	},
	{
		GVR:  schema.GroupVersionResource{Group: "networking.k8s.io", Version: "v1", Resource: "networkpolicies"},
		Kind: "NetworkPolicy",
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			return ResourceInfo{Name: obj.GetName(), Namespace: obj.GetNamespace(), Kind: "NetworkPolicy"}
		},
	},
	{
		GVR:  schema.GroupVersionResource{Group: "policy", Version: "v1", Resource: "poddisruptionbudgets"},
		Kind: "PDB",
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			minAvail, _, _ := unstructured.NestedString(obj.Object, "spec", "minAvailable")
			maxUnavail, _, _ := unstructured.NestedString(obj.Object, "spec", "maxUnavailable")
			return ResourceInfo{Name: obj.GetName(), Namespace: obj.GetNamespace(), Kind: "PDB",
				Data: map[string]string{"minAvailable": minAvail, "maxUnavailable": maxUnavail}}
		},
	},
	{
		GVR:  schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "replicasets"},
		Kind: "ReplicaSet",
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			replicas, _, _ := unstructured.NestedInt64(obj.Object, "spec", "replicas")
			ready, _, _ := unstructured.NestedInt64(obj.Object, "status", "readyReplicas")
			return ResourceInfo{Name: obj.GetName(), Namespace: obj.GetNamespace(), Kind: "ReplicaSet",
				Data: map[string]string{"replicas": fmt.Sprintf("%d", replicas), "ready": fmt.Sprintf("%d", ready)}}
		},
	},
	{
		GVR:  schema.GroupVersionResource{Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "roles"},
		Kind: "Role",
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			return ResourceInfo{Name: obj.GetName(), Namespace: obj.GetNamespace(), Kind: "Role"}
		},
	},
	{
		GVR:  schema.GroupVersionResource{Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "rolebindings"},
		Kind: "RoleBinding",
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			roleRef, _, _ := unstructured.NestedString(obj.Object, "roleRef", "name")
			return ResourceInfo{Name: obj.GetName(), Namespace: obj.GetNamespace(), Kind: "RoleBinding",
				Data: map[string]string{"roleRef": roleRef}}
		},
	},
	{
		GVR:           schema.GroupVersionResource{Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "clusterroles"},
		Kind:          "ClusterRole",
		ClusterScoped: true,
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			return ResourceInfo{Name: obj.GetName(), Kind: "ClusterRole"}
		},
	},
	{
		GVR:           schema.GroupVersionResource{Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "clusterrolebindings"},
		Kind:          "ClusterRoleBinding",
		ClusterScoped: true,
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			roleRef, _, _ := unstructured.NestedString(obj.Object, "roleRef", "name")
			return ResourceInfo{Name: obj.GetName(), Kind: "ClusterRoleBinding",
				Data: map[string]string{"roleRef": roleRef}}
		},
	},
}

// listAndWatchGenericResource lists and watches a single generic resource type.
func (w *Watcher) listAndWatchGenericResource(ctx context.Context, def genericResourceDef) {
	ns := ""
	if def.ClusterScoped {
		ns = ""
	}

	// Initial list
	list, err := w.dynClient.Resource(def.GVR).Namespace(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		if isForbidden(err) {
			// Try per-namespace for namespaced resources
			if !def.ClusterScoped {
				w.listGenericPerNamespace(ctx, def)
			} else {
				log.Printf("No permission to list %s (skipping)", def.Kind)
			}
		} else {
			log.Printf("Cannot list %s (skipping): %v", def.Kind, err)
		}
		// Still try to watch even if list failed (might get permission later or was transient)
		go w.watchGenericResource(ctx, def)
		return
	}

	w.mu.Lock()
	for _, item := range list.Items {
		info := def.ToInfo(&item)
		nsKey := info.Namespace // "" for cluster-scoped
		if w.resources[def.Kind] == nil {
			w.resources[def.Kind] = make(map[string]map[string]*ResourceInfo)
		}
		if w.resources[def.Kind][nsKey] == nil {
			w.resources[def.Kind][nsKey] = make(map[string]*ResourceInfo)
		}
		w.resources[def.Kind][nsKey][info.Name] = &info
	}
	w.mu.Unlock()

	go w.watchGenericResource(ctx, def)
}

func (w *Watcher) listGenericPerNamespace(ctx context.Context, def genericResourceDef) {
	w.mu.RLock()
	namespaces := make([]string, 0, len(w.namespaces))
	for ns := range w.namespaces {
		namespaces = append(namespaces, ns)
	}
	w.mu.RUnlock()

	var wg sync.WaitGroup
	sem := make(chan struct{}, 10)
	for _, ns := range namespaces {
		wg.Add(1)
		sem <- struct{}{}
		go func(nsName string) {
			defer wg.Done()
			defer func() { <-sem }()
			list, err := w.dynClient.Resource(def.GVR).Namespace(nsName).List(ctx, metav1.ListOptions{})
			if err != nil {
				return
			}
			w.mu.Lock()
			for _, item := range list.Items {
				info := def.ToInfo(&item)
				if w.resources[def.Kind] == nil {
					w.resources[def.Kind] = make(map[string]map[string]*ResourceInfo)
				}
				if w.resources[def.Kind][nsName] == nil {
					w.resources[def.Kind][nsName] = make(map[string]*ResourceInfo)
				}
				w.resources[def.Kind][nsName][info.Name] = &info
			}
			w.mu.Unlock()
		}(ns)
	}
	wg.Wait()
}

func (w *Watcher) watchGenericResource(ctx context.Context, def genericResourceDef) {
	ns := ""
	if def.ClusterScoped {
		ns = ""
	}

	var rv string
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}

		watcher, err := w.dynClient.Resource(def.GVR).Namespace(ns).Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			if isForbidden(err) {
				if !def.ClusterScoped {
					w.watchGenericPerNamespace(ctx, def)
				}
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}

		for event := range watcher.ResultChan() {
			obj, ok := event.Object.(*unstructured.Unstructured)
			if !ok {
				continue
			}
			rv = obj.GetResourceVersion()
			info := def.ToInfo(obj)
			nsKey := info.Namespace

			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				if w.resources[def.Kind] == nil {
					w.resources[def.Kind] = make(map[string]map[string]*ResourceInfo)
				}
				if w.resources[def.Kind][nsKey] == nil {
					w.resources[def.Kind][nsKey] = make(map[string]*ResourceInfo)
				}
				w.resources[def.Kind][nsKey][info.Name] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "resource_updated", Namespace: nsKey, Resource: &info})

			case watch.Deleted:
				w.mu.Lock()
				if w.resources[def.Kind] != nil && w.resources[def.Kind][nsKey] != nil {
					delete(w.resources[def.Kind][nsKey], info.Name)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "resource_deleted", Namespace: nsKey, Resource: &info})
			}
		}
	}
}

func (w *Watcher) watchGenericPerNamespace(ctx context.Context, def genericResourceDef) {
	w.mu.RLock()
	namespaces := make([]string, 0, len(w.namespaces))
	for ns := range w.namespaces {
		namespaces = append(namespaces, ns)
	}
	w.mu.RUnlock()

	for _, ns := range namespaces {
		go func(ns string) {
			var rv string
			for {
				select {
				case <-ctx.Done():
					return
				case <-w.stopCh:
					return
				default:
				}

				watcher, err := w.dynClient.Resource(def.GVR).Namespace(ns).Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
				if err != nil {
					if isForbidden(err) {
						return
					}
					time.Sleep(2 * time.Second)
					continue
				}

				for event := range watcher.ResultChan() {
					obj, ok := event.Object.(*unstructured.Unstructured)
					if !ok {
						continue
					}
					rv = obj.GetResourceVersion()
					info := def.ToInfo(obj)

					switch event.Type {
					case watch.Added, watch.Modified:
						w.mu.Lock()
						if w.resources[def.Kind] == nil {
							w.resources[def.Kind] = make(map[string]map[string]*ResourceInfo)
						}
						if w.resources[def.Kind][ns] == nil {
							w.resources[def.Kind][ns] = make(map[string]*ResourceInfo)
						}
						w.resources[def.Kind][ns][info.Name] = &info
						w.mu.Unlock()
						w.emit(Event{Type: "resource_updated", Namespace: ns, Resource: &info})

					case watch.Deleted:
						w.mu.Lock()
						if w.resources[def.Kind] != nil && w.resources[def.Kind][ns] != nil {
							delete(w.resources[def.Kind][ns], info.Name)
						}
						w.mu.Unlock()
						w.emit(Event{Type: "resource_deleted", Namespace: ns, Resource: &info})
					}
				}
			}
		}(ns)
	}
}

func (w *Watcher) SnapshotResources() []ResourceInfo {
	w.mu.RLock()
	defer w.mu.RUnlock()
	result := make([]ResourceInfo, 0)
	for _, nss := range w.resources {
		for _, names := range nss {
			for _, r := range names {
				result = append(result, *r)
			}
		}
	}
	return result
}

// K8sClient returns the underlying Kubernetes clientset for direct API calls.
func (w *Watcher) K8sClient() *kubernetes.Clientset {
	return w.clientset
}

// lastDashBeforeHash finds the last '-' that precedes a ReplicaSet hash suffix.
// Returns the index of the dash, or -1 if not found.
func lastDashBeforeHash(name string) int {
	idx := len(name) - 1
	// Walk backwards past the hash (alphanumeric)
	for idx >= 0 && ((name[idx] >= '0' && name[idx] <= '9') || (name[idx] >= 'a' && name[idx] <= 'f') || (name[idx] >= 'A' && name[idx] <= 'F')) {
		idx--
	}
	if idx > 0 && name[idx] == '-' {
		return idx
	}
	return -1
}
