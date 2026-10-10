//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

// wsaeconnrefused is WSAECONNREFUSED: Winsock's "connection refused" (the
// host answered with a TCP RST). It is not syscall.ECONNREFUSED on Windows.
const wsaeconnrefused = syscall.Errno(10061)

// isConnRefusedOS reports a Winsock refused connection.
func isConnRefusedOS(err error) bool {
	var errno syscall.Errno
	return errors.As(err, &errno) && errno == wsaeconnrefused
}

// pingCommandPath is the system ping.exe (not whatever "ping" the PATH of
// the service names).
func pingCommandPath() string {
	if root := os.Getenv("SystemRoot"); root != "" {
		p := filepath.Join(root, "System32", "PING.EXE")
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return "ping"
}

// configurePingCmd keeps the ping child process from flashing a console window.
func configurePingCmd(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}
