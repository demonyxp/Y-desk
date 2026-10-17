package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

var version = "dev"

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func run() error {
	listen := flag.String("listen", net.JoinHostPort(env("HOST", "127.0.0.1"), env("PORT", "21120")), "监听地址")
	state := flag.String("state", env("STATE_PATH", "data/devices.json"), "设备注册表路径")
	pending := flag.Duration("pending-timeout", 30*time.Second, "等待确认超时")
	attempt := flag.Duration("attempt-window", time.Minute, "密码错误限流时间窗口")
	maxClients := flag.Int("max-clients", 1000, "最大同时在线连接数")
	showVersion := flag.Bool("version", false, "显示版本")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return nil
	}
	if *maxClients <= 0 || *pending <= 0 || *attempt <= 0 {
		return fmt.Errorf("服务参数必须大于零")
	}
	listener, err := net.Listen("tcp", *listen)
	if err != nil {
		return err
	}
	defer listener.Close()
	s, err := newSignaling(options{statePath: *state, pending: *pending, attemptWindow: *attempt, maxClients: *maxClients})
	if err != nil {
		return err
	}
	defer s.Close()
	server := &http.Server{Handler: s, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: time.Minute, MaxHeaderBytes: 16 * 1024}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	errors := make(chan error, 1)
	go func() { errors <- server.Serve(listener) }()
	fmt.Printf("Y-Desk signaling listening on %s\n", listener.Addr())
	select {
	case err := <-errors:
		if err != http.ErrServerClosed {
			return err
		}
	case <-ctx.Done():
		s.Close()
		shutdown, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		return server.Shutdown(shutdown)
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
