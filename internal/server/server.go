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

const clientSendBuffer = 64

var upgrader = websocket.Upgrader{
	CheckOrigin:              sameOrigin,
	EnableCompression:        true,
}

type client struct {
	conn *websocket.Conn
	send chan []byte
}

type Server struct {
	watcher *k8swatch.Watcher
	clients map[*client]struct{}
	mu      sync.Mutex
}

func New(w *k8swatch.Watcher) *Server {
	return &Server{
		watcher: w,
		clients: make(map[*client]struct{}),
	}
}

func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return false
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

	conn.EnableWriteCompression(true)
	conn.SetCompressionLevel(6)

	msg, err := json.Marshal(s.watcher.SnapshotAll())
	if err != nil {
		log.Printf("ws marshal: %v", err)
		conn.Close()
		return
	}

	c := &client{
		conn: conn,
		send: make(chan []byte, clientSendBuffer),
	}

	s.mu.Lock()
	s.clients[c] = struct{}{}
	s.mu.Unlock()

	go s.writePump(c)

	// Queue initial snapshot — buffer is empty so this won't block.
	c.send <- msg

	// Read loop: discard client messages, clean up on disconnect.
	go func() {
		defer func() {
			s.removeClient(c)
		}()
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()
}

func (s *Server) writePump(c *client) {
	defer c.conn.Close()
	for msg := range c.send {
		if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			s.removeClient(c)
			return
		}
	}
}

func (s *Server) removeClient(c *client) {
	s.mu.Lock()
	if _, ok := s.clients[c]; ok {
		delete(s.clients, c)
		close(c.send)
	}
	s.mu.Unlock()
}

func (s *Server) BroadcastEvents() {
	for event := range s.watcher.Events() {
		msg, err := json.Marshal(event)
		if err != nil {
			continue
		}

		s.mu.Lock()
		for c := range s.clients {
			select {
			case c.send <- msg:
			default:
				// Client can't keep up — disconnect it.
				delete(s.clients, c)
				close(c.send)
			}
		}
		s.mu.Unlock()
	}
}
