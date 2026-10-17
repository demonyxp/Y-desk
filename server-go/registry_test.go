package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestRegistryPersistenceAndOwnership(t *testing.T) {
	path := filepath.Join(t.TempDir(), "devices.json")
	r, err := openRegistry(path)
	if err != nil {
		t.Fatal(err)
	}
	token := strings.Repeat("a", 64)
	if err = r.claim("123456789", token); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), token) {
		t.Fatal("不能保存原始所有权令牌")
	}
	r, err = openRegistry(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = r.claim("123456789", token); err != nil {
		t.Fatal(err)
	}
	if err = r.claim("123456789", strings.Repeat("b", 64)); err == nil {
		t.Fatal("不应允许替换所有者")
	}
	if err = r.claim("123456780", token); err != nil {
		t.Fatal(err)
	}
	restored, err := openRegistry(path)
	if err != nil || len(restored.devices) != 2 {
		t.Fatalf("注册表替换后丢失数据: %v", err)
	}
}

func TestRegistryFailedWriteDoesNotClaim(t *testing.T) {
	root := t.TempDir()
	blocker := filepath.Join(root, "file")
	if err := os.WriteFile(blocker, []byte("block"), 0600); err != nil {
		t.Fatal(err)
	}
	r := &registry{path: filepath.Join(blocker, "devices.json"), devices: make(map[string]string)}
	if err := r.claim("123456789", strings.Repeat("a", 64)); err == nil {
		t.Fatal("写入失败必须报错")
	}
	if len(r.devices) != 0 {
		t.Fatal("写入失败不能占用设备码")
	}
}

func TestRegistryRejectsCorruptState(t *testing.T) {
	for _, data := range []string{"null", "{", `{"123456789":"bad-hash"}`} {
		path := filepath.Join(t.TempDir(), "devices.json")
		if err := os.WriteFile(path, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := openRegistry(path); err == nil {
			t.Fatal("损坏的注册表不能静默覆盖")
		}
	}
}

func TestRegistryConcurrentClaim(t *testing.T) {
	r, _ := openRegistry("")
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := r.claim("123456789", strings.Repeat("a", 64)); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if len(r.devices) != 1 {
		t.Fatal("并发注册应保留一个身份")
	}
}
