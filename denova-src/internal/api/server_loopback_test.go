package api

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestIPv6LoopbackCompanionForwardsLocalhostTraffic(t *testing.T) {
	targetListener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := targetListener.Addr().(*net.TCPAddr).Port
	target := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/migration.html" {
			t.Errorf("path = %q", r.URL.Path)
		}
		_, _ = io.WriteString(w, "loopback-ok")
	})}
	go func() { _ = target.Serve(targetListener) }()
	t.Cleanup(func() { _ = target.Close() })

	listener, companion, err := newIPv6LoopbackCompanion(stringPort(port))
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "address family") {
			t.Skipf("IPv6 loopback unavailable: %v", err)
		}
		t.Fatal(err)
	}
	go func() { _ = companion.Serve(listener) }()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = companion.Shutdown(ctx)
	})

	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 2 * time.Second}
	response, err := client.Get("http://[::1]:" + stringPort(port) + "/migration.html")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || string(body) != "loopback-ok" {
		t.Fatalf("status/body = %d/%q", response.StatusCode, body)
	}
}

func stringPort(port int) string {
	return fmt.Sprintf("%d", port)
}
