package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const maxMessage = 128 * 1024
const maxQueued = 1024 * 1024

type options struct {
	statePath     string
	pending       time.Duration
	attemptWindow time.Duration
	maxClients    int
}
type failure struct {
	since time.Time
	count int
}
type pairing struct {
	id           string
	host, viewer *client
	accepted     bool
	timer        *time.Timer
}
type client struct {
	conn                *websocket.Conn
	out                 chan []byte
	done                chan struct{}
	dead                bool
	queued              int
	room, passwordHash  string
	pair                *pairing
	tokens              float64
	tokenTime, joinTime time.Time
}
type signaling struct {
	mu        sync.Mutex
	wg        sync.WaitGroup
	closed    bool
	done      chan struct{}
	opts      options
	registry  *registry
	clients   map[*client]bool
	rooms     map[string]*client
	failures  map[string]failure
	upgrading int
}

func newSignaling(opts options) (*signaling, error) {
	if opts.pending <= 0 {
		opts.pending = 30 * time.Second
	}
	if opts.attemptWindow <= 0 {
		opts.attemptWindow = time.Minute
	}
	if opts.maxClients <= 0 {
		opts.maxClients = 1000
	}
	r, err := openRegistry(opts.statePath)
	if err != nil {
		return nil, err
	}
	s := &signaling{opts: opts, registry: r, clients: make(map[*client]bool), rooms: make(map[string]*client), failures: make(map[string]failure), done: make(chan struct{})}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-s.done:
				return
			case now := <-ticker.C:
				s.mu.Lock()
				for id, fail := range s.failures {
					if now.Sub(fail.since) >= opts.attemptWindow {
						delete(s.failures, id)
					}
				}
				s.mu.Unlock()
			}
		}
	}()
	return s, nil
}

func (s *signaling) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !websocket.IsWebSocketUpgrade(r) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		ok := r.URL.RequestURI() == "/health"
		if !ok {
			w.WriteHeader(http.StatusNotFound)
		}
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": ok})
		return
	}
	s.mu.Lock()
	if s.closed || len(s.clients)+s.upgrading >= s.opts.maxClients {
		s.mu.Unlock()
		http.Error(w, "Server busy", http.StatusServiceUnavailable)
		return
	}
	s.upgrading++
	s.mu.Unlock()
	// 桌面客户端不发送 Origin；保留库默认的浏览器同源检查。
	upgrader := websocket.Upgrader{HandshakeTimeout: 5 * time.Second, ReadBufferSize: 4096, WriteBufferSize: 4096}
	conn, err := upgrader.Upgrade(w, r, nil)
	s.mu.Lock()
	s.upgrading--
	if err != nil {
		s.mu.Unlock()
		return
	}
	if s.closed {
		s.mu.Unlock()
		_ = conn.Close()
		return
	}
	c := &client{conn: conn, out: make(chan []byte, 64), done: make(chan struct{}), tokens: 100, tokenTime: time.Now()}
	s.clients[c] = true
	s.wg.Add(2)
	s.mu.Unlock()
	go s.writeLoop(c)
	s.readLoop(c)
}

func (s *signaling) sendLocked(c *client, value any) {
	if c.dead {
		return
	}
	data, err := json.Marshal(value)
	if err != nil {
		return
	}
	// 慢连接不能无限堆积信令；所有写操作由该连接唯一的写协程处理。
	if c.queued+len(data) > maxQueued {
		s.dropLocked(c, "连接拥塞，已断开")
		return
	}
	select {
	case c.out <- data:
		c.queued += len(data)
	default:
		s.dropLocked(c, "连接拥塞，已断开")
	}
}

func (s *signaling) unpairLocked(c *client, reason string) {
	pair := c.pair
	if pair == nil {
		return
	}
	pair.timer.Stop()
	pair.host.pair, pair.viewer.pair = nil, nil
	message := map[string]any{"type": "ended", "session": pair.id, "reason": reason}
	s.sendLocked(pair.host, message)
	s.sendLocked(pair.viewer, message)
}

func (s *signaling) dropLocked(c *client, reason string) {
	if c.dead {
		return
	}
	c.dead = true
	close(c.done)
	_ = c.conn.Close()
	s.unpairLocked(c, reason)
	if s.rooms[c.room] == c {
		delete(s.rooms, c.room)
	}
	delete(s.clients, c)
}
func (s *signaling) drop(c *client) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dropLocked(c, "对方已断开")
}

func (s *signaling) writeLoop(c *client) {
	defer s.wg.Done()
	defer s.drop(c)
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-c.done:
			return
		case data := <-c.out:
			_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err := c.conn.WriteMessage(websocket.TextMessage, data); err != nil {
				return
			}
			s.mu.Lock()
			c.queued -= len(data)
			s.mu.Unlock()
		case <-ticker.C:
			if err := c.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)); err != nil {
				return
			}
		}
	}
}

func (s *signaling) readLoop(c *client) {
	defer s.wg.Done()
	defer s.drop(c)
	c.conn.SetReadLimit(maxMessage)
	_ = c.conn.SetReadDeadline(time.Now().Add(45 * time.Second))
	c.conn.SetPongHandler(func(string) error { return c.conn.SetReadDeadline(time.Now().Add(45 * time.Second)) })
	for {
		kind, raw, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		s.mu.Lock()
		if c.dead {
			s.mu.Unlock()
			return
		}
		now := time.Now()
		c.tokens = min(100, c.tokens+now.Sub(c.tokenTime).Seconds()*10) - 1
		c.tokenTime = now
		if c.tokens < 0 {
			s.dropLocked(c, "请求过于频繁")
			s.mu.Unlock()
			return
		}
		var msg map[string]json.RawMessage
		err = json.Unmarshal(raw, &msg)
		if kind != websocket.TextMessage || err != nil || msg == nil || textField(msg, "type") == "" {
			err = errors.New("消息格式错误")
		} else {
			err = s.processLocked(c, msg, now)
		}
		if err != nil {
			s.sendLocked(c, map[string]any{"type": "error", "fatal": textField(msg, "type") == "register", "message": err.Error()})
		}
		s.mu.Unlock()
	}
}

func textField(msg map[string]json.RawMessage, key string) string {
	var value string
	_ = json.Unmarshal(msg[key], &value)
	return value
}

func (s *signaling) processLocked(c *client, msg map[string]json.RawMessage, now time.Time) error {
	op := textField(msg, "type")
	if op == "register" {
		if c.room != "" || c.pair != nil {
			return errors.New("当前已注册或正在连接")
		}
		var protocol float64
		_ = json.Unmarshal(msg["version"], &protocol)
		authKey, id := textField(msg, "authKey"), textField(msg, "id")
		if protocol != 2 || !keyPattern.MatchString(authKey) {
			return errors.New("客户端协议不兼容，请安装最新版")
		}
		if err := s.registry.claim(id, textField(msg, "ownerToken")); err != nil {
			return err
		}
		if previous := s.rooms[id]; previous != nil {
			s.dropLocked(previous, "设备已重新上线")
		}
		c.room, c.passwordHash = id, digest(authKey)
		s.rooms[id] = c
		s.sendLocked(c, map[string]any{"type": "registered", "version": 2, "id": id})
		return nil
	}
	if op == "join" {
		if !c.joinTime.IsZero() && now.Sub(c.joinTime) < 2*time.Second {
			return errors.New("请稍后重试")
		}
		c.joinTime = now
		if c.room != "" || c.pair != nil {
			return errors.New("当前已共享或正在连接")
		}
		id, authKey := textField(msg, "id"), textField(msg, "authKey")
		target, fail := s.rooms[id], s.failures[id]
		if now.Sub(fail.since) < s.opts.attemptWindow && fail.count >= 5 {
			return errors.New("密码错误次数过多，请 60 秒后重试")
		}
		if target == nil || !keyPattern.MatchString(authKey) || subtle.ConstantTimeCompare([]byte(digest(authKey)), []byte(target.passwordHash)) != 1 {
			if target != nil {
				if now.Sub(fail.since) >= s.opts.attemptWindow {
					fail = failure{since: now}
				}
				fail.count++
				s.failures[id] = fail
			}
			return errors.New("设备码或密码错误，或对方未开启共享")
		}
		delete(s.failures, id)
		if target.pair != nil {
			return errors.New("对方正在连接中")
		}
		var random [16]byte
		if _, err := rand.Read(random[:]); err != nil {
			return err
		}
		pair := &pairing{id: hex.EncodeToString(random[:]), host: target, viewer: c}
		c.pair, target.pair = pair, pair
		pair.timer = time.AfterFunc(s.opts.pending, func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			// Stop 无法撤回已经等待锁的回调，确认成功后必须再次检查状态。
			if c.pair == pair && !pair.accepted {
				s.unpairLocked(c, "等待确认超时")
			}
		})
		s.sendLocked(target, map[string]any{"type": "request", "session": pair.id})
		// 发送请求时若慢连接被清理，不再发送已经失效的等待消息。
		if c.pair == pair {
			s.sendLocked(c, map[string]any{"type": "waiting", "session": pair.id})
		}
		return nil
	}
	pair := c.pair
	if pair == nil || pair.id != textField(msg, "session") {
		return errors.New("连接已失效")
	}
	if op == "approve" && pair.host == c && !pair.accepted {
		var allow bool
		_ = json.Unmarshal(msg["allow"], &allow)
		if !allow {
			s.unpairLocked(c, "对方拒绝了连接")
			return nil
		}
		pair.timer.Stop()
		pair.accepted = true
		s.sendLocked(pair.host, map[string]any{"type": "ready", "session": pair.id, "role": "host"})
		if c.pair == pair {
			s.sendLocked(pair.viewer, map[string]any{"type": "ready", "session": pair.id, "role": "viewer"})
		}
		return nil
	}
	if op == "leave" {
		s.unpairLocked(c, "连接已结束")
		return nil
	}
	if op == "signal" && pair.accepted {
		var data struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(msg["data"], &data); err != nil || (data.Type != "offer" && data.Type != "answer" && data.Type != "candidate") {
			return errors.New("信令格式错误")
		}
		if data.Type == "offer" && c != pair.host || data.Type == "answer" && c != pair.viewer {
			return errors.New("信令方向错误")
		}
		other := pair.host
		if c == pair.host {
			other = pair.viewer
		}
		s.sendLocked(other, map[string]any{"type": "signal", "session": pair.id, "data": msg["data"]})
		return nil
	}
	return errors.New("操作无效")
}

func (s *signaling) Close() {
	s.mu.Lock()
	if !s.closed {
		s.closed = true
		close(s.done)
		for c := range s.clients {
			s.dropLocked(c, "服务正在重启")
		}
	}
	s.mu.Unlock()
	s.wg.Wait()
}
