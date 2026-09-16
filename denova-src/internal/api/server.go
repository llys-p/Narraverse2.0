package api

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"

	hertzserver "github.com/cloudwego/hertz/pkg/app/server"
	hertzconfig "github.com/cloudwego/hertz/pkg/common/config"

	"denova/config"
	"denova/internal/api/handlers"
	"denova/internal/app"
)

// Server 包含 Hertz 引擎和应用运行时。
type Server struct {
	engine *hertzserver.Hertz
	app    *app.App
	port   string
	host   string
}

// NewServer 构造 HTTP 服务。
func NewServer(application *app.App, port string) *Server {
	return newServer(application, port, nil)
}

// NewServerWithListener constructs an HTTP server using an already reserved
// listener. Callers retain responsibility for choosing the listener address.
func NewServerWithListener(application *app.App, port string, listener net.Listener) *Server {
	return newServer(application, port, listener)
}

func newServer(application *app.App, port string, listener net.Listener) *Server {
	remoteAccess := application.RemoteAccessConfig()
	host := config.HTTPListenHost(remoteAccess.AllowLANAccess)
	s := &Server{
		app:  application,
		port: port,
		host: host,
	}

	options := []hertzconfig.Option{
		hertzserver.WithHostPorts(host + ":" + port),
		hertzserver.WithMaxRequestBodySize(int(handlers.MaxCharacterCardUploadBytes)),
	}
	if listener != nil {
		options = append(options, hertzserver.WithListener(listener))
	}
	h := hertzserver.Default(options...)
	h.Use(corsMiddleware)
	h.Use(remoteAccessMiddleware(application))
	h.Use(staticDocumentCacheMiddleware)
	s.registerRoutes(h)
	s.engine = h
	return s
}

// Run 启动 HTTP 服务。
func (s *Server) Run() {
	var ipv6Companion *http.Server
	if s.host == config.LocalHTTPHost && s.port != "0" {
		listener, companion, err := newIPv6LoopbackCompanion(s.port)
		if err != nil {
			log.Printf("[startup] IPv6 loopback companion unavailable: %v", err)
		} else {
			ipv6Companion = companion
			go func() {
				if serveErr := companion.Serve(listener); serveErr != nil && serveErr != http.ErrServerClosed {
					log.Printf("[startup] IPv6 loopback companion stopped: %v", serveErr)
				}
			}()
		}
	}
	if ipv6Companion != nil {
		defer func() {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			_ = ipv6Companion.Shutdown(shutdownCtx)
		}()
	}
	fmt.Printf("Denova HTTP 服务启动: http://%s:%s\n", s.host, s.port)
	s.engine.Spin()
}

// newIPv6LoopbackCompanion makes localhost usable when a browser resolves it
// to ::1 while Denova's canonical host remains 127.0.0.1. The companion is
// loopback-only and forwards to the same in-process HTTP surface; it never
// opens a LAN listener.
func newIPv6LoopbackCompanion(port string) (net.Listener, *http.Server, error) {
	target, err := url.Parse("http://127.0.0.1:" + port)
	if err != nil {
		return nil, nil, err
	}
	listener, err := net.Listen("tcp6", "[::1]:"+port)
	if err != nil {
		return nil, nil, err
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	server := &http.Server{
		Handler:           proxy,
		ReadHeaderTimeout: 5 * time.Second,
	}
	return listener, server, nil
}
