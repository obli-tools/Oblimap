//go:build !windows

package main

import "os/exec"

// isConnRefusedOS: syscall.ECONNREFUSED (checked by isConnRefused) is the
// only refused error outside Windows.
func isConnRefusedOS(error) bool { return false }

// pingCommandPath is the ping command, looked up in PATH.
func pingCommandPath() string { return "ping" }

// configurePingCmd has nothing to set outside Windows.
func configurePingCmd(*exec.Cmd) {}
