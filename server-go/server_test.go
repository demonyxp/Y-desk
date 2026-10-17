package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func testServer(t *testing.T, opts options) (*signaling, string) {
	t.Helper()
	s, err := newSignaling(opts)
	if err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(s)
	t.Cleanup(func() { s.Close(); httpServer.Close() })
	return s, httpServer.URL
}
func readObject(conn *websocket.Conn) (map[string]any, error) {
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var value map[string]any
	err := conn.ReadJSON(&value)
	return value, err
}

func TestHealthLimitsAndOrigin(t *testing.T) {
	_, url := testServer(t, options{maxClients: 1})
	response, err := http.Get(url + "/health")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || strings.TrimSpace(string(data)) != `{"ok":true}` {
		t.Fatalf("健康检查错误: %s", data)
	}
	wsURL := "ws" + strings.TrimPrefix(url, "http")
	if conn, response, err := websocket.DefaultDialer.Dial(wsURL, http.Header{"Origin": []string{"https://untrusted.example"}}); err == nil {
		conn.Close()
		t.Fatal("应拒绝跨域浏览器")
	} else if response.StatusCode != 403 {
		t.Fatalf("错误状态: %d", response.StatusCode)
	}
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if other, response, err := websocket.DefaultDialer.Dial(wsURL, nil); err == nil {
		other.Close()
		t.Fatal("应限制连接数")
	} else if response.StatusCode != 503 {
		t.Fatalf("错误状态: %d", response.StatusCode)
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte(`{"type":"join"}`)); err != nil {
		t.Fatal(err)
	}
	message, err := readObject(conn)
	if err != nil || message["type"] != "error" {
		t.Fatalf("二进制消息未被拒绝: %v", err)
	}
	if err := conn.WriteMessage(websocket.TextMessage, []byte(strings.Repeat("x", maxMessage+1))); err != nil {
		t.Fatal(err)
	}
	if _, _, err = conn.ReadMessage(); !websocket.IsCloseError(err, websocket.CloseMessageTooBig) {
		t.Fatalf("应拒绝超长消息: %v", err)
	}
}

func TestConcurrentSessions(t *testing.T) {
	_, url := testServer(t, options{})
	wsURL := "ws" + strings.TrimPrefix(url, "http")
	var wg sync.WaitGroup
	for index := 0; index < 20; index++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			host, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
			if err != nil {
				t.Error(err)
				return
			}
			defer host.Close()
			viewer, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
			if err != nil {
				t.Error(err)
				return
			}
			defer viewer.Close()
			id, key := fmt.Sprintf("%09d", 100000000+index), strings.Repeat("a", 64)
			if err = host.WriteJSON(map[string]any{"type": "register", "version": 2, "id": id, "ownerToken": key, "authKey": key}); err != nil {
				t.Error(err)
				return
			}
			if msg, err := readObject(host); err != nil || msg["type"] != "registered" {
				t.Errorf("注册失败: %v %v", msg, err)
				return
			}
			if err = viewer.WriteJSON(map[string]any{"type": "join", "id": id, "authKey": key}); err != nil {
				t.Error(err)
				return
			}
			request, err := readObject(host)
			if err != nil || request["type"] != "request" {
				t.Errorf("连接请求失败: %v", err)
				return
			}
			if msg, err := readObject(viewer); err != nil || msg["type"] != "waiting" {
				t.Errorf("等待失败: %v", err)
				return
			}
			if err = host.WriteJSON(map[string]any{"type": "approve", "session": request["session"], "allow": true}); err != nil {
				t.Error(err)
				return
			}
			for _, conn := range []*websocket.Conn{host, viewer} {
				if msg, err := readObject(conn); err != nil || msg["type"] != "ready" {
					t.Errorf("确认失败: %v", err)
					return
				}
			}
			for i := 0; i < 10; i++ {
				if err = host.WriteJSON(map[string]any{"type": "signal", "session": request["session"], "data": map[string]any{"type": "offer", "sdp": fmt.Sprint(i)}}); err != nil {
					t.Error(err)
					return
				}
				msg, err := readObject(viewer)
				if err != nil || msg["type"] != "signal" {
					t.Errorf("转发失败: %v", err)
					return
				}
			}
		}(index)
	}
	wg.Wait()
}

func TestSlowConsumerIsDropped(t *testing.T) {
	s, url := testServer(t, options{})
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(url, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	// 模拟已占满写队列的连接，确保处理其他客户端时不会等待它的网络写入。
	c := &client{conn: conn, out: make(chan []byte), done: make(chan struct{})}
	s.mu.Lock()
	s.sendLocked(c, json.RawMessage(`{"type":"notice"}`))
	s.mu.Unlock()
	if !c.dead {
		t.Fatal("慢连接必须被断开")
	}
}
