package server

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os/exec"
	"strconv"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/gorilla/websocket"
	k8swatch "github.com/jeppe/k8s-unix-system/internal/k8s"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type portForwardEntry struct {
	cmd       *exec.Cmd
	cancel    context.CancelFunc
	LocalPort int    `json:"localPort"`
	SvcName   string `json:"service"`
	Namespace string `json:"namespace"`
	SvcPort   int    `json:"servicePort"`
}

type Server struct {
	watcher      *k8swatch.Watcher
	clients      map[*websocket.Conn]bool
	mu           sync.Mutex
	ctx          context.Context
	portForwards map[string]*portForwardEntry // key: "ns/name:port"
	pfMu         sync.Mutex
}

func New(w *k8swatch.Watcher, ctx context.Context) *Server {
	return &Server{
		watcher:      w,
		clients:      make(map[*websocket.Conn]bool),
		ctx:          ctx,
		portForwards: make(map[string]*portForwardEntry),
	}
}

func (s *Server) Router(frontendFS http.FileSystem) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)

	r.Get("/api/state", s.handleState)
	r.Get("/api/contexts", s.handleListContexts)
	r.Post("/api/context/switch", s.handleSwitchContext)
	r.Get("/api/pod/describe", s.handleDescribe)
	r.Get("/api/pod/logs", s.handleLogs)
	r.Delete("/api/pod/delete", s.handleDeletePod)
	r.Get("/api/workload/describe", s.handleWorkloadDescribe)
	r.Patch("/api/workload/scale", s.handleWorkloadScale)
	r.Patch("/api/workload/resources", s.handleWorkloadResources)
	r.Post("/api/workload/restart", s.handleWorkloadRestart)
	r.Patch("/api/cronjob/schedule", s.handleCronJobSchedule)
	r.Patch("/api/cronjob/suspend", s.handleCronJobSuspend)
	r.Post("/api/cronjob/trigger", s.handleCronJobTrigger)
	r.Get("/api/service/describe", s.handleServiceDescribe)
	r.Get("/api/service/endpoints", s.handleServiceEndpoints)
	r.Post("/api/service/portforward", s.handleServicePortForward)
	r.Delete("/api/service/portforward", s.handleServicePortForwardStop)
	r.Get("/ws", s.handleWS)
	r.Handle("/*", http.FileServer(frontendFS))

	return r
}

func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(s.watcher.Snapshot())
}

func (s *Server) handleListContexts(w http.ResponseWriter, r *http.Request) {
	contexts, current, err := k8swatch.ListContexts()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"contexts": contexts,
		"current":  current,
		"active":   s.watcher.ContextName(),
	})
}

func (s *Server) handleSwitchContext(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Context string `json:"context"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Context == "" {
		http.Error(w, "context field required", http.StatusBadRequest)
		return
	}

	log.Printf("Switching to context: %s", req.Context)
	if err := s.watcher.SwitchContext(s.ctx, req.Context); err != nil {
		log.Printf("Failed to switch context: %v", err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	log.Printf("Successfully switched to context: %s", req.Context)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "ok",
		"context": req.Context,
	})
}

// handleDescribe returns a JSON description of a pod (events, conditions, containers).
func (s *Server) handleDescribe(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("namespace")
	name := r.URL.Query().Get("name")
	if ns == "" || name == "" {
		http.Error(w, "namespace and name required", http.StatusBadRequest)
		return
	}

	client := s.watcher.K8sClient()
	ctx := r.Context()

	pod, err := client.CoreV1().Pods(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Build a describe-like output
	type ContainerDesc struct {
		Name         string `json:"name"`
		Image        string `json:"image"`
		Ready        bool   `json:"ready"`
		RestartCount int32  `json:"restartCount"`
		State        string `json:"state"`
		Reason       string `json:"reason,omitempty"`
	}

	type PodDescribe struct {
		Name       string          `json:"name"`
		Namespace  string          `json:"namespace"`
		Node       string          `json:"node"`
		Status     string          `json:"status"`
		IP         string          `json:"ip"`
		StartTime  string          `json:"startTime,omitempty"`
		Labels     map[string]string `json:"labels,omitempty"`
		Containers []ContainerDesc `json:"containers"`
		Conditions []string        `json:"conditions"`
		Events     []string        `json:"events"`
	}

	desc := PodDescribe{
		Name:      pod.Name,
		Namespace: pod.Namespace,
		Node:      pod.Spec.NodeName,
		Status:    string(pod.Status.Phase),
		IP:        pod.Status.PodIP,
		Labels:    pod.Labels,
	}

	if pod.Status.StartTime != nil {
		desc.StartTime = pod.Status.StartTime.Format(time.RFC3339)
	}

	for _, c := range pod.Status.ContainerStatuses {
		cd := ContainerDesc{
			Name:         c.Name,
			Image:        c.Image,
			Ready:        c.Ready,
			RestartCount: c.RestartCount,
		}
		switch {
		case c.State.Running != nil:
			cd.State = "Running"
		case c.State.Waiting != nil:
			cd.State = "Waiting"
			cd.Reason = c.State.Waiting.Reason
		case c.State.Terminated != nil:
			cd.State = "Terminated"
			cd.Reason = c.State.Terminated.Reason
		}
		desc.Containers = append(desc.Containers, cd)
	}

	for _, cond := range pod.Status.Conditions {
		desc.Conditions = append(desc.Conditions, fmt.Sprintf("%s=%s", cond.Type, cond.Status))
	}

	// Fetch events for this pod
	events, err := client.CoreV1().Events(ns).List(ctx, metav1.ListOptions{
		FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=Pod", name),
	})
	if err == nil {
		for _, ev := range events.Items {
			age := time.Since(ev.LastTimestamp.Time).Truncate(time.Second)
			desc.Events = append(desc.Events, fmt.Sprintf("[%s] %s: %s", age, ev.Reason, ev.Message))
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(desc)
}

// handleLogs streams pod logs via SSE (Server-Sent Events) with follow.
func (s *Server) handleLogs(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("namespace")
	name := r.URL.Query().Get("name")
	if ns == "" || name == "" {
		http.Error(w, "namespace and name required", http.StatusBadRequest)
		return
	}

	client := s.watcher.K8sClient()
	ctx := r.Context()

	tailLines := int64(100)
	req := client.CoreV1().Pods(ns).GetLogs(name, &corev1.PodLogOptions{
		Follow:    true,
		TailLines: &tailLines,
	})

	stream, err := req.Stream(ctx)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer stream.Close()

	// SSE headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	scanner := bufio.NewScanner(stream)
	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return
		default:
		}
		line := scanner.Text()
		fmt.Fprintf(w, "data: %s\n\n", line)
		flusher.Flush()
	}
}

// handleDeletePod deletes a pod.
func (s *Server) handleDeletePod(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("namespace")
	name := r.URL.Query().Get("name")
	if ns == "" || name == "" {
		http.Error(w, "namespace and name required", http.StatusBadRequest)
		return
	}

	client := s.watcher.K8sClient()
	ctx := r.Context()

	err := client.CoreV1().Pods(ns).Delete(ctx, name, metav1.DeleteOptions{})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "deleted",
		"pod":     name,
		"namespace": ns,
	})
}

// handleWorkloadDescribe returns details about a Deployment or StatefulSet.
func (s *Server) handleWorkloadDescribe(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("namespace")
	name := r.URL.Query().Get("name")
	kind := r.URL.Query().Get("kind")
	if ns == "" || name == "" || kind == "" {
		http.Error(w, "namespace, name, and kind required", http.StatusBadRequest)
		return
	}

	client := s.watcher.K8sClient()
	ctx := r.Context()

	type ContainerResources struct {
		Name      string `json:"name"`
		CPUReq    string `json:"cpuRequest"`
		CPULim    string `json:"cpuLimit"`
		MemReq    string `json:"memoryRequest"`
		MemLim    string `json:"memoryLimit"`
	}

	type WorkloadDescribe struct {
		Name       string               `json:"name"`
		Namespace  string               `json:"namespace"`
		Kind       string               `json:"kind"`
		Replicas   int32                `json:"replicas"`
		Ready      int32                `json:"readyReplicas"`
		Updated    int32                `json:"updatedReplicas"`
		Strategy   string               `json:"strategy,omitempty"`
		Containers []ContainerResources `json:"containers"`
		// CronJob-specific
		Schedule     string `json:"schedule,omitempty"`
		Suspended    bool   `json:"suspended,omitempty"`
		LastSchedule string `json:"lastSchedule,omitempty"`
		ActiveJobs   int32  `json:"activeJobs,omitempty"`
	}

	desc := WorkloadDescribe{Name: name, Namespace: ns, Kind: kind}

	appendContainers := func(containers []corev1.Container) {
		for _, c := range containers {
			desc.Containers = append(desc.Containers, ContainerResources{
				Name:   c.Name,
				CPUReq: c.Resources.Requests.Cpu().String(),
				CPULim: c.Resources.Limits.Cpu().String(),
				MemReq: c.Resources.Requests.Memory().String(),
				MemLim: c.Resources.Limits.Memory().String(),
			})
		}
	}

	switch kind {
	case "Deployment":
		dep, err := client.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if dep.Spec.Replicas != nil {
			desc.Replicas = *dep.Spec.Replicas
		}
		desc.Ready = dep.Status.ReadyReplicas
		desc.Updated = dep.Status.UpdatedReplicas
		desc.Strategy = string(dep.Spec.Strategy.Type)
		appendContainers(dep.Spec.Template.Spec.Containers)
	case "StatefulSet":
		sts, err := client.AppsV1().StatefulSets(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if sts.Spec.Replicas != nil {
			desc.Replicas = *sts.Spec.Replicas
		}
		desc.Ready = sts.Status.ReadyReplicas
		desc.Updated = sts.Status.UpdatedReplicas
		appendContainers(sts.Spec.Template.Spec.Containers)
	case "DaemonSet":
		ds, err := client.AppsV1().DaemonSets(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		desc.Replicas = ds.Status.DesiredNumberScheduled
		desc.Ready = ds.Status.NumberReady
		desc.Updated = ds.Status.UpdatedNumberScheduled
		appendContainers(ds.Spec.Template.Spec.Containers)
	case "CronJob":
		cj, err := client.BatchV1().CronJobs(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		desc.Schedule = cj.Spec.Schedule
		if cj.Spec.Suspend != nil && *cj.Spec.Suspend {
			desc.Suspended = true
		}
		desc.ActiveJobs = int32(len(cj.Status.Active))
		if cj.Status.LastScheduleTime != nil {
			desc.LastSchedule = cj.Status.LastScheduleTime.Format(time.RFC3339)
		}
		appendContainers(cj.Spec.JobTemplate.Spec.Template.Spec.Containers)
	case "Job":
		job, err := client.BatchV1().Jobs(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if job.Spec.Parallelism != nil {
			desc.Replicas = *job.Spec.Parallelism
		}
		desc.Ready = job.Status.Succeeded
		desc.ActiveJobs = job.Status.Active
		appendContainers(job.Spec.Template.Spec.Containers)
	default:
		http.Error(w, "unsupported kind: "+kind, http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(desc)
}

// handleWorkloadScale changes the replica count of a Deployment or StatefulSet.
func (s *Server) handleWorkloadScale(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Namespace string `json:"namespace"`
		Name      string `json:"name"`
		Kind      string `json:"kind"`
		Replicas  int32  `json:"replicas"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.Namespace == "" || req.Name == "" || req.Kind == "" {
		http.Error(w, "namespace, name, and kind required", http.StatusBadRequest)
		return
	}
	if req.Replicas < 0 {
		http.Error(w, "replicas must be >= 0", http.StatusBadRequest)
		return
	}

	client := s.watcher.K8sClient()
	ctx := r.Context()

	switch req.Kind {
	case "Deployment":
		scale, err := client.AppsV1().Deployments(req.Namespace).GetScale(ctx, req.Name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		scale.Spec.Replicas = req.Replicas
		_, err = client.AppsV1().Deployments(req.Namespace).UpdateScale(ctx, req.Name, scale, metav1.UpdateOptions{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	case "StatefulSet":
		scale, err := client.AppsV1().StatefulSets(req.Namespace).GetScale(ctx, req.Name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		scale.Spec.Replicas = req.Replicas
		_, err = client.AppsV1().StatefulSets(req.Namespace).UpdateScale(ctx, req.Name, scale, metav1.UpdateOptions{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	default:
		http.Error(w, "unsupported kind: "+req.Kind, http.StatusBadRequest)
		return
	}

	log.Printf("Scaled %s/%s in %s to %d replicas", req.Kind, req.Name, req.Namespace, req.Replicas)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":   "scaled",
		"kind":     req.Kind,
		"name":     req.Name,
		"replicas": req.Replicas,
	})
}

// handleWorkloadResources updates container resource requests/limits.
func (s *Server) handleWorkloadResources(w http.ResponseWriter, r *http.Request) {
	type ContainerRes struct {
		Name   string `json:"name"`
		CPUReq string `json:"cpuRequest"`
		CPULim string `json:"cpuLimit"`
		MemReq string `json:"memoryRequest"`
		MemLim string `json:"memoryLimit"`
	}
	var req struct {
		Namespace  string         `json:"namespace"`
		Name       string         `json:"name"`
		Kind       string         `json:"kind"`
		Containers []ContainerRes `json:"containers"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.Namespace == "" || req.Name == "" || req.Kind == "" || len(req.Containers) == 0 {
		http.Error(w, "namespace, name, kind, and containers required", http.StatusBadRequest)
		return
	}

	client := s.watcher.K8sClient()
	ctx := r.Context()

	// Build resource map per container name
	resMap := make(map[string]ContainerRes)
	for _, c := range req.Containers {
		resMap[c.Name] = c
	}

	updateContainers := func(containers []corev1.Container) error {
		for i := range containers {
			cr, ok := resMap[containers[i].Name]
			if !ok {
				continue
			}
			if containers[i].Resources.Requests == nil {
				containers[i].Resources.Requests = corev1.ResourceList{}
			}
			if containers[i].Resources.Limits == nil {
				containers[i].Resources.Limits = corev1.ResourceList{}
			}
			if cr.CPUReq != "" {
				q, err := resource.ParseQuantity(cr.CPUReq)
				if err != nil {
					return fmt.Errorf("invalid cpu request %q: %w", cr.CPUReq, err)
				}
				containers[i].Resources.Requests[corev1.ResourceCPU] = q
			}
			if cr.CPULim != "" {
				q, err := resource.ParseQuantity(cr.CPULim)
				if err != nil {
					return fmt.Errorf("invalid cpu limit %q: %w", cr.CPULim, err)
				}
				containers[i].Resources.Limits[corev1.ResourceCPU] = q
			}
			if cr.MemReq != "" {
				q, err := resource.ParseQuantity(cr.MemReq)
				if err != nil {
					return fmt.Errorf("invalid memory request %q: %w", cr.MemReq, err)
				}
				containers[i].Resources.Requests[corev1.ResourceMemory] = q
			}
			if cr.MemLim != "" {
				q, err := resource.ParseQuantity(cr.MemLim)
				if err != nil {
					return fmt.Errorf("invalid memory limit %q: %w", cr.MemLim, err)
				}
				containers[i].Resources.Limits[corev1.ResourceMemory] = q
			}
		}
		return nil
	}

	switch req.Kind {
	case "Deployment":
		dep, err := client.AppsV1().Deployments(req.Namespace).Get(ctx, req.Name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := updateContainers(dep.Spec.Template.Spec.Containers); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if _, err := client.AppsV1().Deployments(req.Namespace).Update(ctx, dep, metav1.UpdateOptions{}); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	case "StatefulSet":
		sts, err := client.AppsV1().StatefulSets(req.Namespace).Get(ctx, req.Name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := updateContainers(sts.Spec.Template.Spec.Containers); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if _, err := client.AppsV1().StatefulSets(req.Namespace).Update(ctx, sts, metav1.UpdateOptions{}); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	default:
		http.Error(w, "unsupported kind: "+req.Kind, http.StatusBadRequest)
		return
	}

	log.Printf("Updated resources for %s/%s in %s", req.Kind, req.Name, req.Namespace)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "updated"})
}

// handleWorkloadRestart triggers a rolling restart by patching the pod template annotation.
func (s *Server) handleWorkloadRestart(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Namespace string `json:"namespace"`
		Name      string `json:"name"`
		Kind      string `json:"kind"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.Namespace == "" || req.Name == "" || req.Kind == "" {
		http.Error(w, "namespace, name, and kind required", http.StatusBadRequest)
		return
	}

	client := s.watcher.K8sClient()
	ctx := r.Context()
	restartAnnotation := fmt.Sprintf(`{"spec":{"template":{"metadata":{"annotations":{"kubectl.kubernetes.io/restartedAt":"%s"}}}}}`, time.Now().Format(time.RFC3339))

	var err error
	switch req.Kind {
	case "Deployment":
		_, err = client.AppsV1().Deployments(req.Namespace).Patch(ctx, req.Name, types.StrategicMergePatchType, []byte(restartAnnotation), metav1.PatchOptions{})
	case "StatefulSet":
		_, err = client.AppsV1().StatefulSets(req.Namespace).Patch(ctx, req.Name, types.StrategicMergePatchType, []byte(restartAnnotation), metav1.PatchOptions{})
	default:
		http.Error(w, "unsupported kind: "+req.Kind, http.StatusBadRequest)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	log.Printf("Restarted %s/%s in %s", req.Kind, req.Name, req.Namespace)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "restarted"})
}

// handleCronJobSchedule updates the schedule of a CronJob.
func (s *Server) handleCronJobSchedule(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Namespace string `json:"namespace"`
		Name      string `json:"name"`
		Schedule  string `json:"schedule"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.Namespace == "" || req.Name == "" || req.Schedule == "" {
		http.Error(w, "namespace, name, and schedule required", http.StatusBadRequest)
		return
	}

	client := s.watcher.K8sClient()
	ctx := r.Context()

	cj, err := client.BatchV1().CronJobs(req.Namespace).Get(ctx, req.Name, metav1.GetOptions{})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	cj.Spec.Schedule = req.Schedule
	if _, err := client.BatchV1().CronJobs(req.Namespace).Update(ctx, cj, metav1.UpdateOptions{}); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	log.Printf("Updated CronJob %s/%s schedule to %s", req.Namespace, req.Name, req.Schedule)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "updated", "schedule": req.Schedule})
}

// handleCronJobSuspend toggles the suspend state of a CronJob.
func (s *Server) handleCronJobSuspend(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Namespace string `json:"namespace"`
		Name      string `json:"name"`
		Suspended bool   `json:"suspended"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.Namespace == "" || req.Name == "" {
		http.Error(w, "namespace and name required", http.StatusBadRequest)
		return
	}

	client := s.watcher.K8sClient()
	ctx := r.Context()

	cj, err := client.BatchV1().CronJobs(req.Namespace).Get(ctx, req.Name, metav1.GetOptions{})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	cj.Spec.Suspend = &req.Suspended
	if _, err := client.BatchV1().CronJobs(req.Namespace).Update(ctx, cj, metav1.UpdateOptions{}); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	action := "resumed"
	if req.Suspended {
		action = "suspended"
	}
	log.Printf("CronJob %s/%s %s", req.Namespace, req.Name, action)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"status": action, "suspended": req.Suspended})
}

// handleCronJobTrigger creates a Job from a CronJob (like kubectl create job --from).
func (s *Server) handleCronJobTrigger(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Namespace string `json:"namespace"`
		Name      string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.Namespace == "" || req.Name == "" {
		http.Error(w, "namespace and name required", http.StatusBadRequest)
		return
	}

	client := s.watcher.K8sClient()
	ctx := r.Context()

	cj, err := client.BatchV1().CronJobs(req.Namespace).Get(ctx, req.Name, metav1.GetOptions{})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	jobName := fmt.Sprintf("%s-manual-%d", req.Name, time.Now().Unix())
	if len(jobName) > 63 {
		jobName = jobName[:63]
	}

	job := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      jobName,
			Namespace: req.Namespace,
			Labels:    cj.Spec.JobTemplate.Labels,
			Annotations: map[string]string{
				"cronjob.kubernetes.io/instantiate": "manual",
			},
		},
		Spec: cj.Spec.JobTemplate.Spec,
	}

	created, err := client.BatchV1().Jobs(req.Namespace).Create(ctx, job, metav1.CreateOptions{})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	log.Printf("Triggered Job %s/%s from CronJob %s", req.Namespace, created.Name, req.Name)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "triggered", "job": created.Name})
}

// handleServiceDescribe returns details about a Service including events.
func (s *Server) handleServiceDescribe(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("namespace")
	name := r.URL.Query().Get("name")
	if ns == "" || name == "" {
		http.Error(w, "namespace and name required", http.StatusBadRequest)
		return
	}

	client := s.watcher.K8sClient()
	ctx := r.Context()

	svc, err := client.CoreV1().Services(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	type PortDesc struct {
		Name       string `json:"name,omitempty"`
		Port       int32  `json:"port"`
		TargetPort string `json:"targetPort"`
		Protocol   string `json:"protocol"`
		NodePort   int32  `json:"nodePort,omitempty"`
	}

	type ServiceDescribe struct {
		Name       string            `json:"name"`
		Namespace  string            `json:"namespace"`
		Type       string            `json:"type"`
		ClusterIP  string            `json:"clusterIP"`
		ExternalIP []string          `json:"externalIPs,omitempty"`
		Selector   map[string]string `json:"selector,omitempty"`
		Labels     map[string]string `json:"labels,omitempty"`
		Ports      []PortDesc        `json:"ports"`
		Events     []string          `json:"events"`
		Age        string            `json:"age"`
	}

	desc := ServiceDescribe{
		Name:      svc.Name,
		Namespace: svc.Namespace,
		Type:      string(svc.Spec.Type),
		ClusterIP: svc.Spec.ClusterIP,
		Selector:  svc.Spec.Selector,
		Labels:    svc.Labels,
	}

	if len(svc.Spec.ExternalIPs) > 0 {
		desc.ExternalIP = svc.Spec.ExternalIPs
	}
	if svc.Status.LoadBalancer.Ingress != nil {
		for _, ing := range svc.Status.LoadBalancer.Ingress {
			if ing.IP != "" {
				desc.ExternalIP = append(desc.ExternalIP, ing.IP)
			}
			if ing.Hostname != "" {
				desc.ExternalIP = append(desc.ExternalIP, ing.Hostname)
			}
		}
	}

	desc.Age = time.Since(svc.CreationTimestamp.Time).Truncate(time.Second).String()

	for _, p := range svc.Spec.Ports {
		desc.Ports = append(desc.Ports, PortDesc{
			Name:       p.Name,
			Port:       p.Port,
			TargetPort: p.TargetPort.String(),
			Protocol:   string(p.Protocol),
			NodePort:   p.NodePort,
		})
	}

	events, err := client.CoreV1().Events(ns).List(ctx, metav1.ListOptions{
		FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=Service", name),
	})
	if err == nil {
		for _, ev := range events.Items {
			age := time.Since(ev.LastTimestamp.Time).Truncate(time.Second)
			desc.Events = append(desc.Events, fmt.Sprintf("[%s] %s: %s", age, ev.Reason, ev.Message))
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(desc)
}

// handleServiceEndpoints returns the resolved endpoints for a service.
func (s *Server) handleServiceEndpoints(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("namespace")
	name := r.URL.Query().Get("name")
	if ns == "" || name == "" {
		http.Error(w, "namespace and name required", http.StatusBadRequest)
		return
	}

	client := s.watcher.K8sClient()
	ctx := r.Context()

	ep, err := client.CoreV1().Endpoints(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	type EndpointAddress struct {
		IP       string `json:"ip"`
		NodeName string `json:"nodeName,omitempty"`
		PodName  string `json:"podName,omitempty"`
		Ready    bool   `json:"ready"`
	}
	type EndpointPort struct {
		Name     string `json:"name,omitempty"`
		Port     int32  `json:"port"`
		Protocol string `json:"protocol"`
	}
	type EndpointSubset struct {
		Addresses []EndpointAddress `json:"addresses"`
		Ports     []EndpointPort    `json:"ports"`
	}

	var subsets []EndpointSubset
	for _, sub := range ep.Subsets {
		s := EndpointSubset{}
		for _, addr := range sub.Addresses {
			ea := EndpointAddress{IP: addr.IP, Ready: true}
			if addr.NodeName != nil {
				ea.NodeName = *addr.NodeName
			}
			if addr.TargetRef != nil && addr.TargetRef.Kind == "Pod" {
				ea.PodName = addr.TargetRef.Name
			}
			s.Addresses = append(s.Addresses, ea)
		}
		for _, addr := range sub.NotReadyAddresses {
			ea := EndpointAddress{IP: addr.IP, Ready: false}
			if addr.NodeName != nil {
				ea.NodeName = *addr.NodeName
			}
			if addr.TargetRef != nil && addr.TargetRef.Kind == "Pod" {
				ea.PodName = addr.TargetRef.Name
			}
			s.Addresses = append(s.Addresses, ea)
		}
		for _, p := range sub.Ports {
			s.Ports = append(s.Ports, EndpointPort{
				Name:     p.Name,
				Port:     p.Port,
				Protocol: string(p.Protocol),
			})
		}
		subsets = append(subsets, s)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"name":      name,
		"namespace": ns,
		"subsets":   subsets,
	})
}

// handleServicePortForward starts a kubectl port-forward to a service.
func (s *Server) handleServicePortForward(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Namespace string `json:"namespace"`
		Name      string `json:"name"`
		Port      int    `json:"port"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" || req.Namespace == "" || req.Port == 0 {
		http.Error(w, "namespace, name, and port required", http.StatusBadRequest)
		return
	}

	key := fmt.Sprintf("%s/%s:%d", req.Namespace, req.Name, req.Port)

	s.pfMu.Lock()
	if existing, ok := s.portForwards[key]; ok {
		s.pfMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":    "already_running",
			"localPort": existing.LocalPort,
			"key":       key,
		})
		return
	}
	s.pfMu.Unlock()

	// Find a free local port
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		http.Error(w, "failed to find free port: "+err.Error(), http.StatusInternalServerError)
		return
	}
	localPort := listener.Addr().(*net.TCPAddr).Port
	listener.Close()

	pfCtx, cancel := context.WithCancel(s.ctx)
	args := []string{
		"port-forward",
		"--context", s.watcher.ContextName(),
		"-n", req.Namespace,
		fmt.Sprintf("svc/%s", req.Name),
		fmt.Sprintf("%d:%d", localPort, req.Port),
	}
	cmd := exec.CommandContext(pfCtx, "kubectl", args...)

	if err := cmd.Start(); err != nil {
		cancel()
		http.Error(w, "failed to start port-forward: "+err.Error(), http.StatusInternalServerError)
		return
	}

	entry := &portForwardEntry{
		cmd:       cmd,
		cancel:    cancel,
		LocalPort: localPort,
		SvcName:   req.Name,
		Namespace: req.Namespace,
		SvcPort:   req.Port,
	}

	s.pfMu.Lock()
	s.portForwards[key] = entry
	s.pfMu.Unlock()

	// Cleanup when process exits
	go func() {
		cmd.Wait()
		s.pfMu.Lock()
		delete(s.portForwards, key)
		s.pfMu.Unlock()
	}()

	log.Printf("Port-forward started: %s → localhost:%d", key, localPort)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":    "started",
		"localPort": localPort,
		"key":       key,
	})
}

// handleServicePortForwardStop stops an active port-forward.
func (s *Server) handleServicePortForwardStop(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("namespace")
	name := r.URL.Query().Get("name")
	portStr := r.URL.Query().Get("port")
	if ns == "" || name == "" || portStr == "" {
		http.Error(w, "namespace, name, and port required", http.StatusBadRequest)
		return
	}
	port, _ := strconv.Atoi(portStr)
	key := fmt.Sprintf("%s/%s:%d", ns, name, port)

	s.pfMu.Lock()
	entry, ok := s.portForwards[key]
	if ok {
		entry.cancel()
		delete(s.portForwards, key)
	}
	s.pfMu.Unlock()

	if !ok {
		http.Error(w, "no active port-forward for "+key, http.StatusNotFound)
		return
	}

	log.Printf("Port-forward stopped: %s", key)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "stopped", "key": key})
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade: %v", err)
		return
	}

	// Send initial snapshot and register client under the same lock
	// to prevent BroadcastEvents from writing concurrently.
	snapshot := s.watcher.Snapshot()
	nodes := s.watcher.SnapshotNodes()
	services := s.watcher.SnapshotServices()
	ingresses := s.watcher.SnapshotIngresses()
	pvcs := s.watcher.SnapshotPVCs()
	workloads := s.watcher.SnapshotWorkloads()
	resources := s.watcher.SnapshotResources()
	msg, _ := json.Marshal(k8swatch.Event{
		Type:      "snapshot",
		Context:   s.watcher.ContextName(),
		Snapshot:  snapshot,
		Nodes:     nodes,
		Services:  services,
		Ingresses: ingresses,
		PVCs:      pvcs,
		Workloads: workloads,
		Resources: resources,
	})

	s.mu.Lock()
	conn.WriteMessage(websocket.TextMessage, msg)
	s.clients[conn] = true
	s.mu.Unlock()

	// Keep connection alive, read (and discard) client messages
	go func() {
		defer func() {
			s.mu.Lock()
			delete(s.clients, conn)
			s.mu.Unlock()
			conn.Close()
		}()
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()
}

func (s *Server) BroadcastEvents() {
	for event := range s.watcher.Events() {
		msg, err := json.Marshal(event)
		if err != nil {
			continue
		}

		s.mu.Lock()
		for conn := range s.clients {
			if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				conn.Close()
				delete(s.clients, conn)
			}
		}
		s.mu.Unlock()
	}
}
