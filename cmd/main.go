package main

import (
	"context"
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"syscall"

	k8swatch "github.com/jeppe/k8s-unix-system/internal/k8s"
	"github.com/jeppe/k8s-unix-system/internal/server"
)

//go:embed frontend/*
var frontendFiles embed.FS

func main() {
	kubecontext := flag.String("context", "", "Kubernetes context to use (default: current context)")
	port := flag.Int("port", 8080, "Port to serve on")
	noBrowser := flag.Bool("no-browser", false, "Don't open browser automatically")
	flag.Parse()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	watcher, err := k8swatch.NewWatcher(*kubecontext)
	if err != nil {
		log.Fatalf("Failed to create k8s watcher: %v", err)
	}

	if err := watcher.Start(ctx); err != nil {
		log.Fatalf("Failed to start watcher: %v", err)
	}
	defer watcher.Stop()

	srv := server.New(watcher, ctx)
	go srv.BroadcastEvents()

	frontendFS, err := fs.Sub(frontendFiles, "frontend")
	if err != nil {
		log.Fatalf("Failed to load frontend: %v", err)
	}

	addr := fmt.Sprintf(":%d", *port)
	url := fmt.Sprintf("http://localhost:%d", *port)

	log.Printf("🦖 K8s Unix System starting on %s", url)
	if !*noBrowser {
		go openBrowser(url)
	}

	go func() {
		if err := http.ListenAndServe(addr, srv.Router(http.FS(frontendFS))); err != nil {
			log.Fatalf("Server failed: %v", err)
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh
	log.Println("Shutting down...")
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "linux":
		cmd = exec.Command("xdg-open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	}
	if cmd != nil {
		cmd.Run()
	}
}
