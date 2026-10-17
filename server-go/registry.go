package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sync"
)

var deviceIDPattern = regexp.MustCompile(`^[0-9]{9}$`)
var keyPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func digest(value string) string {
	hash := sha256.Sum256([]byte(value))
	return hex.EncodeToString(hash[:])
}

type registry struct {
	mu      sync.Mutex
	path    string
	devices map[string]string
}

func openRegistry(path string) (*registry, error) {
	r := &registry{path: path, devices: make(map[string]string)}
	if path == "" {
		return r, nil
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return r, nil
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(data, &r.devices); err != nil {
		return nil, err
	}
	if r.devices == nil || len(r.devices) > 10000 {
		return nil, errors.New("设备注册表无效")
	}
	for id, owner := range r.devices {
		if !deviceIDPattern.MatchString(id) || !keyPattern.MatchString(owner) {
			return nil, errors.New("设备注册表无效")
		}
	}
	return r, nil
}

func (r *registry) claim(id, token string) error {
	if !deviceIDPattern.MatchString(id) || !keyPattern.MatchString(token) {
		return errors.New("设备身份无效，请更新客户端")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	owner := digest(token)
	if previous, exists := r.devices[id]; exists {
		if previous != owner {
			return errors.New("设备码属于另一台设备，不能覆盖")
		}
		return nil
	}
	if len(r.devices) >= 10000 {
		return errors.New("设备注册数量已达上限")
	}
	// 与 Node 服务端共用 JSON 格式，只保存所有权摘要；写盘成功后才接受新身份。
	next := make(map[string]string, len(r.devices)+1)
	for key, value := range r.devices {
		next[key] = value
	}
	next[id] = owner
	if r.path != "" {
		if err := os.MkdirAll(filepath.Dir(r.path), 0700); err != nil {
			return err
		}
		data, err := json.Marshal(next)
		if err != nil {
			return err
		}
		file, err := os.CreateTemp(filepath.Dir(r.path), ".devices-*")
		if err != nil {
			return err
		}
		defer os.Remove(file.Name())
		if _, err = file.Write(data); err == nil {
			err = file.Sync()
		}
		closeErr := file.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		if err = os.Rename(file.Name(), r.path); err != nil {
			return err
		}
	}
	r.devices = next
	return nil
}
