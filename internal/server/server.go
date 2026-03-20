package server

import (
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/gorilla/websocket"
	k8swatch "github.com/jeppe/k8s-unix-system/internal/k8s"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: sameOrigin,
}

type Server struct {
	watcher *k8swatch.Watcher
	clients map[*websocket.Conn]struct{}
	mu      sync.Mutex
}

func New(w *k8swatch.Watcher) *Server {
	return &Server{
		watcher: w,
		clients: make(map[*websocket.Conn]struct{}),
	}
}

func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}

	originURL, err := url.Parse(origin)
	if err != nil {
		return false
	}

	return strings.EqualFold(originURL.Host, r.Host)
}

func (s *Server) Router(frontendFS http.FileSystem) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)

	r.Get("/api/state", s.handleState)
	r.Get("/ws", s.handleWS)
	r.Handle("/*", http.FileServer(frontendFS))

	return r
}

func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(s.watcher.Snapshot())
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade: %v", err)
		return
	}

	s.mu.Lock()
	// Send initial snapshot before any broadcast can write to this connection.
	snapshot := s.watcher.Snapshot()
	nodes := s.watcher.SnapshotNodes()
	services := s.watcher.SnapshotServices()
	workloads := s.watcher.SnapshotWorkloads()
	ingresses := s.watcher.SnapshotIngresses()
	k8sEvents := s.watcher.SnapshotK8sEvents()
	pvcs := s.watcher.SnapshotPVCs()
	pvs := s.watcher.SnapshotPVs()
	podMetrics := s.watcher.SnapshotPodMetrics()
	nodeMetrics := s.watcher.SnapshotNodeMetrics()
	msg, err := json.Marshal(k8swatch.Event{
		Type:                 "snapshot",
		Snapshot:             snapshot,
		Nodes:                nodes,
		Services:             services,
		Workloads:            workloads,
		Ingresses:            ingresses,
		K8sEvents:            k8sEvents,
		PVCs:                 pvcs,
		PVs:                  pvs,
		MetricsAvailable:     s.watcher.MetricsAvailable(),
		PodMetricsAvailable:  s.watcher.MetricsAvailable(),
		NodeMetricsAvailable: s.watcher.NodeMetricsAvailable(),
		PodMetrics:           podMetrics,
		NodeMetrics:          nodeMetrics,
	})
	if err != nil {
		s.mu.Unlock()
		log.Printf("ws marshal: %v", err)
		conn.Close()
		return
	}

	s.clients[conn] = struct{}{}
	if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
		delete(s.clients, conn)
		s.mu.Unlock()
		log.Printf("ws initial snapshot: %v", err)
		conn.Close()
		return
	}
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
