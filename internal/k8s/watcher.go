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
}

type Watcher struct {
	clientset  *kubernetes.Clientset
	mu         sync.RWMutex
	namespaces map[string]*NamespaceInfo
	pods       map[string]map[string]*PodInfo // ns -> pod name -> pod
	nodes      map[string]*NodeInfo
	services   map[string]map[string]*ServiceInfo // ns -> svc name -> svc
	workloads  map[string]map[string]*WorkloadInfo
	rsOwners   map[string]map[string]string // ns -> replicaset name -> deployment name
	eventCh    chan Event
	stopCh     chan struct{}
}

const watchRetryDelay = 2 * time.Second

func NewWatcher(kubecontext string) (*Watcher, error) {
	rules := clientcmd.NewDefaultClientConfigLoadingRules()
	overrides := &clientcmd.ConfigOverrides{}
	if kubecontext != "" {
		overrides.CurrentContext = kubecontext
	}
	config, err := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, overrides).ClientConfig()
	if err != nil {
		return nil, fmt.Errorf("k8s config: %w", err)
	}

	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("k8s client: %w", err)
	}

	return &Watcher{
		clientset:  clientset,
		namespaces: make(map[string]*NamespaceInfo),
		pods:       make(map[string]map[string]*PodInfo),
		nodes:      make(map[string]*NodeInfo),
		services:   make(map[string]map[string]*ServiceInfo),
		workloads:  make(map[string]map[string]*WorkloadInfo),
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

func (w *Watcher) Start(ctx context.Context) error {
	// Initial list
	nsList, err := w.clientset.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list namespaces: %w", err)
	}
	podList, err := w.clientset.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list pods: %w", err)
	}
	nodeList, err := w.clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list nodes: %w", err)
	}
	svcList, err := w.clientset.CoreV1().Services("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list services: %w", err)
	}
	if err := w.refreshReplicaSetOwners(ctx); err != nil {
		return fmt.Errorf("list replica sets: %w", err)
	}
	if err := w.refreshWorkloads(ctx); err != nil {
		return fmt.Errorf("list workloads: %w", err)
	}

	namespaces := make(map[string]*NamespaceInfo, len(nsList.Items))
	pods := make(map[string]map[string]*PodInfo, len(nsList.Items))
	for i := range nsList.Items {
		ns := &nsList.Items[i]
		namespaces[ns.Name] = &NamespaceInfo{Name: ns.Name, Status: string(ns.Status.Phase)}
		pods[ns.Name] = make(map[string]*PodInfo)
	}
	for i := range podList.Items {
		pod := &podList.Items[i]
		info := w.podToInfo(pod)
		if pods[pod.Namespace] == nil {
			pods[pod.Namespace] = make(map[string]*PodInfo)
		}
		pods[pod.Namespace][pod.Name] = &info
	}

	nodes := make(map[string]*NodeInfo, len(nodeList.Items))
	for i := range nodeList.Items {
		node := &nodeList.Items[i]
		info := nodeToInfo(node)
		nodes[node.Name] = &info
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

	w.mu.Lock()
	w.namespaces = namespaces
	w.pods = pods
	w.nodes = nodes
	w.services = services
	w.mu.Unlock()

	// Send initial snapshot
	w.emitSnapshot()

	go w.watchNamespaces(ctx, nsList.ResourceVersion)
	go w.watchPods(ctx, podList.ResourceVersion)
	go w.watchNodes(ctx, nodeList.ResourceVersion)
	go w.watchServices(ctx, svcList.ResourceVersion)
	go w.pollWorkloads(ctx)

	return nil
}

func (w *Watcher) emitSnapshot() {
	w.emit(Event{
		Type:      "snapshot",
		Snapshot:  w.Snapshot(),
		Nodes:     w.SnapshotNodes(),
		Services:  w.SnapshotServices(),
		Workloads: w.SnapshotWorkloads(),
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
	rsList, err := w.clientset.AppsV1().ReplicaSets("").List(ctx, metav1.ListOptions{})
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
	deployments, err := w.clientset.AppsV1().Deployments("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return err
	}
	statefulsets, err := w.clientset.AppsV1().StatefulSets("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return err
	}
	daemonsets, err := w.clientset.AppsV1().DaemonSets("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return err
	}
	jobs, err := w.clientset.BatchV1().Jobs("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return err
	}
	cronjobs, err := w.clientset.BatchV1().CronJobs("").List(ctx, metav1.ListOptions{})
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
	}
	w.namespaces = newNamespaces
	w.pods = newPods
	w.services = newServices
	w.workloads = newWorkloads
	w.mu.Unlock()

	return nsList.ResourceVersion, nil
}

func (w *Watcher) refreshPods(ctx context.Context) (string, error) {
	podList, err := w.clientset.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
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
	svcList, err := w.clientset.CoreV1().Services("").List(ctx, metav1.ListOptions{})
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

		watcher, err := w.clientset.CoreV1().Pods("").Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
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
	return ServiceInfo{
		Name:      svc.Name,
		Namespace: svc.Namespace,
		Type:      string(svc.Spec.Type),
		ClusterIP: svc.Spec.ClusterIP,
		Selector:  svc.Spec.Selector,
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

		watcher, err := w.clientset.CoreV1().Services("").Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
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
