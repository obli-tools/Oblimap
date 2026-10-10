//go:build windows

package main

import (
	"log"
	"os"
	"os/exec"
	"sync"
	"syscall"
)

var configPermsOnce sync.Once

// broadConfigSIDs are well-known groups whose explicit grants are stripped from
// the config directory: Users, Everyone, Authenticated Users, INTERACTIVE,
// Guests and LOCAL. Removing a SID that has no entry is a no-op for icacls.
var broadConfigSIDs = []string{
	"*S-1-5-32-545", "*S-1-1-0", "*S-1-5-11", "*S-1-5-4", "*S-1-5-32-546", "*S-1-2-0",
}

// ensureConfigPerms replaces the ACL of the config directory
// (%ProgramData%\OblimapProbe) with full control for LocalSystem (S-1-5-18)
// and BUILTIN\Administrators (S-1-5-32-544) only, inherited by every file
// below it. By default the directory inherits BUILTIN\Users read access from
// ProgramData, which exposed config.json (tenant API key, identity token) to
// every local user; explicit grants to broad groups (added by hand or by an
// older tool) are removed too. Well-known SIDs are used so the call works on
// localised Windows. Runs once per process start; failures are logged, never
// fatal.
func ensureConfigPerms() {
	configPermsOnce.Do(func() {
		dir := configDir()
		if err := os.MkdirAll(dir, 0700); err != nil {
			log.Printf("WARN: could not create config dir %s: %v", dir, err)
			return
		}
		args := []string{dir,
			"/inheritance:r",
			"/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F",
			"/remove:g"}
		args = append(args, broadConfigSIDs...)
		args = append(args, "/Q")
		cmd := exec.Command("icacls", args...)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if out, err := cmd.CombinedOutput(); err != nil {
			log.Printf("WARN: could not restrict ACL of %s (icacls: %v): %s", dir, err, string(out))
		}
	})
}
