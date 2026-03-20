package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	k8serrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
)

type PodMetrics struct {
	Name        string `json:"name"`
	Namespace   string `json:"namespace"`
	CPUUsage    int64  `json:"cpuUsage"`    // millicores
	MemoryUsage int64  `json:"memoryUsage"` // bytes
}

type NodeMetrics struct {
	Name        string `json:"name"`
	CPUUsage    int64  `json:"cpuUsage"`    // millicores
	MemoryUsage int64  `json:"memoryUsage"` // bytes
}

type metricsItemList struct {
	Items []metricsItem `json:"items"`
}

type metricsItem struct {
	Metadata struct {
		Name      string `json:"name"`
		Namespace string `json:"namespace"`
	} `json:"metadata"`
	Containers []struct {
		Usage struct {
			CPU    string `json:"cpu"`
			Memory string `json:"memory"`
		} `json:"usage"`
	} `json:"containers"`
	Usage struct {
		CPU    string `json:"cpu"`
		Memory string `json:"memory"`
	} `json:"usage"`
}

func (w *Watcher) probeMetrics(ctx context.Context) bool {
	_, err := w.clientset.Discovery().RESTClient().Get().
		AbsPath("/apis/metrics.k8s.io/v1beta1").
		DoRaw(ctx)
	return err == nil
}

func (w *Watcher) fetchPodMetrics(ctx context.Context) ([]PodMetrics, error) {
	path := "/apis/metrics.k8s.io/v1beta1/pods"
	if w.namespace != "" {
		path = fmt.Sprintf("/apis/metrics.k8s.io/v1beta1/namespaces/%s/pods", w.namespace)
	}
	data, err := w.clientset.Discovery().RESTClient().Get().AbsPath(path).DoRaw(ctx)
	if err != nil {
		return nil, err
	}
	var list metricsItemList
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, fmt.Errorf("parse pod metrics: %w", err)
	}
	result := make([]PodMetrics, 0, len(list.Items))
	for _, item := range list.Items {
		var cpu, mem int64
		for _, c := range item.Containers {
			if c.Usage.CPU != "" {
				if q, err := resource.ParseQuantity(c.Usage.CPU); err == nil {
					cpu += q.MilliValue()
				}
			}
			if c.Usage.Memory != "" {
				if q, err := resource.ParseQuantity(c.Usage.Memory); err == nil {
					mem += q.Value()
				}
			}
		}
		result = append(result, PodMetrics{
			Name:        item.Metadata.Name,
			Namespace:   item.Metadata.Namespace,
			CPUUsage:    cpu,
			MemoryUsage: mem,
		})
	}
	return result, nil
}

func (w *Watcher) fetchNodeMetrics(ctx context.Context) ([]NodeMetrics, error) {
	data, err := w.clientset.Discovery().RESTClient().Get().
		AbsPath("/apis/metrics.k8s.io/v1beta1/nodes").
		DoRaw(ctx)
	if err != nil {
		return nil, err
	}
	var list metricsItemList
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, fmt.Errorf("parse node metrics: %w", err)
	}
	result := make([]NodeMetrics, 0, len(list.Items))
	for _, item := range list.Items {
		var cpu, mem int64
		if item.Usage.CPU != "" {
			if q, err := resource.ParseQuantity(item.Usage.CPU); err == nil {
				cpu = q.MilliValue()
			}
		}
		if item.Usage.Memory != "" {
			if q, err := resource.ParseQuantity(item.Usage.Memory); err == nil {
				mem = q.Value()
			}
		}
		result = append(result, NodeMetrics{
			Name:        item.Metadata.Name,
			CPUUsage:    cpu,
			MemoryUsage: mem,
		})
	}
	return result, nil
}

func quantityChanged(old, new int64) bool {
	if old == 0 {
		return new != 0
	}
	diff := new - old
	if diff < 0 {
		diff = -diff
	}
	return float64(diff)/float64(old) > 0.01
}

func podMetricsChanged(old, new map[string]*PodMetrics) bool {
	if len(old) != len(new) {
		return true
	}
	for k, nv := range new {
		ov, ok := old[k]
		if !ok {
			return true
		}
		if quantityChanged(ov.CPUUsage, nv.CPUUsage) || quantityChanged(ov.MemoryUsage, nv.MemoryUsage) {
			return true
		}
	}
	return false
}

func nodeMetricsChanged(old, new map[string]*NodeMetrics) bool {
	if len(old) != len(new) {
		return true
	}
	for k, nv := range new {
		ov, ok := old[k]
		if !ok {
			return true
		}
		if quantityChanged(ov.CPUUsage, nv.CPUUsage) || quantityChanged(ov.MemoryUsage, nv.MemoryUsage) {
			return true
		}
	}
	return false
}

func (w *Watcher) pollMetrics(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	var failCount int
	nodeWarningLogged := false

	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		case <-ticker.C:
			pods, err := w.fetchPodMetrics(ctx)
			if err != nil {
				if ctx.Err() != nil || w.isStopped() {
					return
				}
				failCount++
				log.Printf("metrics: pod fetch failed (%d/3): %v", failCount, err)
				if failCount >= 3 {
					w.mu.Lock()
					w.metricsAvailable = false
					w.mu.Unlock()
					w.emit(Event{Type: "metrics_update"})
					failCount = 0
				}
				continue
			}
			failCount = 0

			newPodMap := make(map[string]*PodMetrics, len(pods))
			for i := range pods {
				key := pods[i].Namespace + "/" + pods[i].Name
				newPodMap[key] = &pods[i]
			}

			w.mu.RLock()
			nodeAvail := w.nodeMetricsAvailable
			w.mu.RUnlock()

			var newNodeMap map[string]*NodeMetrics
			if nodeAvail {
				nodes, nodeErr := w.fetchNodeMetrics(ctx)
				if nodeErr != nil {
					if ctx.Err() != nil || w.isStopped() {
						return
					}
					if k8serrors.IsNotFound(nodeErr) || k8serrors.IsForbidden(nodeErr) {
						if !nodeWarningLogged {
							log.Printf("metrics: node metrics unavailable (RBAC/404), pod-only mode")
							nodeWarningLogged = true
						}
						w.mu.Lock()
						w.nodeMetricsAvailable = false
						w.mu.Unlock()
					} else {
						log.Printf("metrics: node fetch failed: %v", nodeErr)
					}
				} else {
					newNodeMap = make(map[string]*NodeMetrics, len(nodes))
					for i := range nodes {
						newNodeMap[nodes[i].Name] = &nodes[i]
					}
				}
			}

			w.mu.Lock()
			podChanged := podMetricsChanged(w.podMetrics, newPodMap)
			nodeChanged := newNodeMap != nil && nodeMetricsChanged(w.nodeMetrics, newNodeMap)
			if podChanged || nodeChanged {
				w.podMetrics = newPodMap
				if newNodeMap != nil {
					w.nodeMetrics = newNodeMap
				}
				w.metricsAvailable = true
			}
			nodeMetricsAvail := w.nodeMetricsAvailable
			podMetrics := w.snapshotPodMetricsLocked()
			nodeMetrics := w.snapshotNodeMetricsLocked()
			w.mu.Unlock()

			if podChanged || nodeChanged {
				w.emit(Event{
					Type:                 "metrics_update",
					MetricsAvailable:     true,
					PodMetricsAvailable:  true,
					NodeMetricsAvailable: nodeMetricsAvail,
					PodMetrics:           podMetrics,
					NodeMetrics:          nodeMetrics,
				})
			}
		}
	}
}

func (w *Watcher) SnapshotPodMetrics() []PodMetrics {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.snapshotPodMetricsLocked()
}

func (w *Watcher) snapshotPodMetricsLocked() []PodMetrics {
	result := make([]PodMetrics, 0, len(w.podMetrics))
	for _, m := range w.podMetrics {
		result = append(result, *m)
	}
	return result
}

func (w *Watcher) SnapshotNodeMetrics() []NodeMetrics {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.snapshotNodeMetricsLocked()
}

func (w *Watcher) snapshotNodeMetricsLocked() []NodeMetrics {
	result := make([]NodeMetrics, 0, len(w.nodeMetrics))
	for _, m := range w.nodeMetrics {
		result = append(result, *m)
	}
	return result
}

func (w *Watcher) MetricsAvailable() bool {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.metricsAvailable
}

func (w *Watcher) NodeMetricsAvailable() bool {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.nodeMetricsAvailable
}
