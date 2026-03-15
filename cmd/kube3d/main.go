package main

import (
	"context"
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"syscall"

	k8swatch "github.com/jeppe/k8s-unix-system/internal/k8s"
	"github.com/jeppe/k8s-unix-system/internal/server"
)

//go:embed frontend/*
var frontendFiles embed.FS

var version = "dev"

func main() {
	kubecontext := flag.String("context", "", "Kubernetes context to use (default: current context)")
	host := flag.String("host", "127.0.0.1", "Host interface to bind the HTTP server to")
	port := flag.Int("port", 8080, "Port to serve on")
	noBrowser := flag.Bool("no-browser", false, "Don't open browser automatically")
	showVersion := flag.Bool("version", false, "Print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println("kube3d " + version)
		return
	}

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

	srv := server.New(watcher)
	go srv.BroadcastEvents()

	frontendFS, err := fs.Sub(frontendFiles, "frontend")
	if err != nil {
		log.Fatalf("Failed to load frontend: %v", err)
	}

	addr := net.JoinHostPort(*host, strconv.Itoa(*port))
	url := fmt.Sprintf("http://%s", net.JoinHostPort(browserHost(*host), strconv.Itoa(*port)))

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

func browserHost(host string) string {
	switch host {
	case "", "0.0.0.0", "::":
		return "localhost"
	default:
		return host
	}
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
