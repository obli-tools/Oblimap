//go:build !windows

package main

import (
	"errors"
	"io/fs"
	"log"
	"os"
)

// ensureConfigPerms restricts the config directory to its owner (0700) and
// config.json to owner read/write (0600). Installers and probe versions
// before this one created them with the default umask (typically 0755/0644),
// which exposed the tenant API key to every local user. Never fatal.
func ensureConfigPerms() {
	dir := configDir()
	if st, err := os.Stat(dir); err == nil && st.IsDir() {
		if st.Mode().Perm() != 0700 {
			if err := os.Chmod(dir, 0700); err != nil {
				log.Printf("WARN: could not restrict permissions of %s: %v", dir, err)
			}
		}
	} else if err != nil && !errors.Is(err, fs.ErrNotExist) {
		log.Printf("WARN: could not stat %s: %v", dir, err)
	}

	path := configPath
	if path == "" {
		return
	}
	if st, err := os.Stat(path); err == nil {
		if st.Mode().Perm() != 0600 {
			if err := os.Chmod(path, 0600); err != nil {
				log.Printf("WARN: could not restrict permissions of %s: %v", path, err)
			}
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		log.Printf("WARN: could not stat %s: %v", path, err)
	}
}
