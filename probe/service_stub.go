//go:build !windows

package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"syscall"
	"text/template"
	"time"
)

func runAsService(mainFn func()) {
	mainFn()
}

// ─── Linux systemd service install ───────────────────────────────────────────

const linuxServiceTpl = `[Unit]
Description=Oblimap Network Probe
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart={{.ExePath}}
Restart=always
RestartSec=10
StandardOutput=append:/var/log/oblimap-probe.log
StandardError=append:/var/log/oblimap-probe.log

[Install]
WantedBy=multi-user.target
`

const freebsdRCDTpl = `#!/bin/sh
#
# PROVIDE: oblimap_probe
# REQUIRE: NETWORKING
# KEYWORD: shutdown

. /etc/rc.subr

name="oblimap_probe"
rcvar="oblimap_probe_enable"
command="/usr/local/bin/oblimap-probe"
pidfile="/var/run/${name}.pid"

start_cmd="${name}_start"
stop_cmd="${name}_stop"

oblimap_probe_start()
{
    /usr/sbin/daemon -p ${pidfile} -o /var/log/oblimap-probe.log ${command}
    echo "Started ${name}."
}

oblimap_probe_stop()
{
    if [ -f ${pidfile} ]; then
        kill $(cat ${pidfile}) 2>/dev/null
        rm -f ${pidfile}
        echo "Stopped ${name}."
    fi
}

load_rc_config $name
: ${oblimap_probe_enable:=NO}
run_rc_command "$1"
`

const darwinPlistTpl = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.oblimap.probe</string>
  <key>ProgramArguments</key>
  <array>
    <string>{{.ExePath}}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/var/log/oblimap-probe.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/oblimap-probe.log</string>
</dict>
</plist>
`

func serviceInstall() error {
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("get executable: %w", err)
	}

	switch runtime.GOOS {
	case "linux":
		return installLinux(exePath)
	case "darwin":
		return installDarwin(exePath)
	case "freebsd":
		return installFreeBSD(exePath)
	default:
		return errors.New("service install not supported on this platform")
	}
}

func installLinux(exePath string) error {
	// Copy binary to /usr/local/bin/oblimap-probe
	dest := "/usr/local/bin/oblimap-probe"
	if exePath != dest {
		if err := copyFile(exePath, dest); err != nil {
			return fmt.Errorf("copy binary: %w", err)
		}
		if err := os.Chmod(dest, 0755); err != nil {
			return err
		}
	}

	// Write systemd unit
	tpl := template.Must(template.New("svc").Parse(linuxServiceTpl))
	unitPath := "/etc/systemd/system/oblimap-probe.service"
	f, err := os.Create(unitPath)
	if err != nil {
		return fmt.Errorf("create unit file: %w", err)
	}
	if err := tpl.Execute(f, map[string]string{"ExePath": dest}); err != nil {
		f.Close()
		return err
	}
	f.Close()

	// Enable and start
	if out, err := exec.Command("systemctl", "daemon-reload").CombinedOutput(); err != nil {
		log.Printf("systemctl daemon-reload: %s", out)
	}
	if out, err := exec.Command("systemctl", "enable", "--now", "oblimap-probe").CombinedOutput(); err != nil {
		return fmt.Errorf("enable service: %v (%s)", err, out)
	}
	return nil
}

func installDarwin(exePath string) error {
	dest := "/usr/local/bin/oblimap-probe"
	if exePath != dest {
		if err := copyFile(exePath, dest); err != nil {
			return fmt.Errorf("copy binary: %w", err)
		}
		if err := os.Chmod(dest, 0755); err != nil {
			return err
		}
	}

	tpl := template.Must(template.New("plist").Parse(darwinPlistTpl))
	plistPath := "/Library/LaunchDaemons/com.oblimap.probe.plist"
	f, err := os.Create(plistPath)
	if err != nil {
		return fmt.Errorf("create plist: %w", err)
	}
	if err := tpl.Execute(f, map[string]string{"ExePath": dest}); err != nil {
		f.Close()
		return err
	}
	f.Close()

	out, err := exec.Command("launchctl", "load", "-w", plistPath).CombinedOutput()
	if err != nil {
		return fmt.Errorf("launchctl load: %v (%s)", err, out)
	}
	return nil
}

func installFreeBSD(exePath string) error {
	dest := "/usr/local/bin/oblimap-probe"
	if exePath != dest {
		if err := copyFile(exePath, dest); err != nil {
			return fmt.Errorf("copy binary: %w", err)
		}
		if err := os.Chmod(dest, 0755); err != nil {
			return err
		}
	}

	// Write rc.d script
	tpl := template.Must(template.New("rcd").Parse(freebsdRCDTpl))
	rcdPath := "/usr/local/etc/rc.d/oblimap_probe"
	f, err := os.Create(rcdPath)
	if err != nil {
		return fmt.Errorf("create rc.d script: %w", err)
	}
	if err := tpl.Execute(f, nil); err != nil {
		f.Close()
		return err
	}
	f.Close()
	if err := os.Chmod(rcdPath, 0755); err != nil {
		return err
	}

	// Enable and start
	if out, err := exec.Command("sysrc", "oblimap_probe_enable=YES").CombinedOutput(); err != nil {
		log.Printf("sysrc enable: %s", out)
	}
	if out, err := exec.Command("service", "oblimap_probe", "start").CombinedOutput(); err != nil {
		return fmt.Errorf("start service: %v (%s)", err, out)
	}
	return nil
}

func serviceUninstall() error {
	switch runtime.GOOS {
	case "linux":
		exec.Command("systemctl", "stop", "oblimap-probe").Run()     //nolint
		exec.Command("systemctl", "disable", "oblimap-probe").Run()  //nolint
		os.Remove("/etc/systemd/system/oblimap-probe.service")
		exec.Command("systemctl", "daemon-reload").Run() //nolint
		return nil
	case "darwin":
		plist := "/Library/LaunchDaemons/com.oblimap.probe.plist"
		exec.Command("launchctl", "unload", plist).Run() //nolint
		os.Remove(plist)
		return nil
	case "freebsd":
		exec.Command("service", "oblimap_probe", "stop").Run()  //nolint
		exec.Command("sysrc", "-x", "oblimap_probe_enable").Run() //nolint
		os.Remove("/usr/local/etc/rc.d/oblimap_probe")
		return nil
	default:
		return errors.New("service uninstall not supported on this platform")
	}
}

func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0755)
}

// shellQuote wraps s in single quotes for safe interpolation into a sh script.
func shellQuote(s string) string {
	out := "'"
	for _, r := range s {
		if r == '\'' {
			out += `'\''`
		} else {
			out += string(r)
		}
	}
	return out + "'"
}

// runDetachedUninstallScript writes body to a fresh private directory under
// the config dir (never a fixed /tmp path: a local user could pre-create or
// swap it before root runs it), created with O_EXCL and mode 0700, and starts
// it detached from the probe so it survives the probe's exit. The script
// removes its own directory when done.
func runDetachedUninstallScript(body string) {
	workDir, err := makePrivateWorkDir("uninstall-")
	if err != nil {
		log.Printf("ERROR: create uninstall work dir: %v", err)
		return
	}
	scriptPath := filepath.Join(workDir, "uninstall.sh")
	script := "#!/bin/sh\n" + body + "rm -rf " + shellQuote(workDir) + "\n"
	if err := writeFileExclusive(scriptPath, []byte(script), 0700); err != nil {
		log.Printf("ERROR: write uninstall script: %v", err)
		os.RemoveAll(workDir)
		return
	}

	// Under systemd, a child of the service lives in the service's cgroup and
	// is killed as soon as the probe exits (or when the script itself runs
	// "systemctl stop"). Run it as a transient unit instead when possible.
	if runtime.GOOS == "linux" {
		if sdRun, err := exec.LookPath("systemd-run"); err == nil {
			out, err := exec.Command(sdRun, "--no-block", "/bin/sh", scriptPath).CombinedOutput()
			if err == nil {
				return
			}
			log.Printf("WARN: systemd-run failed (%v: %s) — starting uninstall script directly", err, out)
		}
	}

	cmd := exec.Command("/bin/sh", scriptPath)
	// New session: not killed with the service's process group (launchd,
	// daemon(8), init scripts) when the probe exits.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		log.Printf("ERROR: start uninstall script: %v", err)
		os.RemoveAll(workDir)
		return
	}
	cmd.Process.Release() //nolint
}

func uninstallSelfLinux(serverURL string) {
	_ = serverURL
	runDetachedUninstallScript(`sleep 2
systemctl stop oblimap-probe 2>/dev/null || service oblimap-probe stop 2>/dev/null
systemctl disable oblimap-probe 2>/dev/null
rm -f /etc/systemd/system/oblimap-probe.service
systemctl daemon-reload 2>/dev/null
rm -rf /usr/local/bin/oblimap-probe
rm -rf /opt/oblimap-probe
`)
}

func uninstallSelfDarwin(serverURL string) {
	_ = serverURL
	exePath, _ := os.Executable()
	plist := "/Library/LaunchDaemons/com.oblimap.probe.plist"
	body := fmt.Sprintf(`sleep 2
launchctl unload %s 2>/dev/null
rm -f %s
`, shellQuote(plist), shellQuote(plist))
	if exePath != "" {
		body += "rm -f " + shellQuote(exePath) + "\n"
	}
	runDetachedUninstallScript(body)
}

func uninstallSelfFreeBSD(serverURL string) {
	_ = serverURL
	runDetachedUninstallScript(`sleep 2
service oblimap_probe stop 2>/dev/null
sysrc -x oblimap_probe_enable 2>/dev/null
rm -f /usr/local/etc/rc.d/oblimap_probe
rm -rf /usr/local/bin/oblimap-probe
rm -rf /opt/oblimap-probe
`)
}

func performUninstall(serverURL string) {
	switch runtime.GOOS {
	case "linux":
		uninstallSelfLinux(serverURL)
	case "darwin":
		uninstallSelfDarwin(serverURL)
	case "freebsd":
		uninstallSelfFreeBSD(serverURL)
	default:
		log.Printf("Uninstall not implemented for %s", runtime.GOOS)
	}
}

// downloadedBinaryVersion runs "<path> --version" and returns the reported
// version. It proves the download is an executable for this platform and
// tells which version it is before it replaces the running binary.
func downloadedBinaryVersion(path string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, "--version").Output()
	if err != nil {
		return "", err
	}
	m := binaryVersionRe.FindStringSubmatch(string(out))
	if m == nil {
		return "", fmt.Errorf("unrecognised --version output")
	}
	return m[1], nil
}

func applyUpdate(latestVersion string) {
	if !updateMu.TryLock() {
		log.Printf("Auto-update: an update is already in progress — skipping")
		return
	}
	defer updateMu.Unlock()
	if !updateAttemptAllowed(latestVersion) {
		return
	}

	exePath, err := os.Executable()
	if err != nil {
		log.Printf("Auto-update: cannot resolve executable path: %v", err)
		return
	}

	filename := fmt.Sprintf("oblimap-probe-%s-%s", runtime.GOOS, runtime.GOARCH)
	url := fmt.Sprintf("%s/api/probe/download/%s", cfg.ServerURL, filename)
	log.Printf("Auto-update: downloading %s → v%s", filename, latestVersion)

	// Written next to the executable (root-owned directory) so the final
	// rename is atomic. downloadFile removes a stale .new and creates it with
	// O_EXCL, verifying X-Content-SHA256 when the server provides it.
	tmpPath := exePath + ".new"
	if err := downloadFile(url, tmpPath, 0700); err != nil {
		log.Printf("Auto-update: download failed: %v", err)
		updateAborted(latestVersion, downloadFailureReason(err))
		return
	}

	newVersion, err := downloadedBinaryVersion(tmpPath)
	if err != nil {
		os.Remove(tmpPath)
		log.Printf("Auto-update: downloaded binary failed its --version check (%v) — aborting", err)
		updateAborted(latestVersion, "version_check_failed")
		return
	}
	running := normalizeVersion(ProbeVersion)
	if reason := updateVersionRefusal(newVersion, running, latestVersion); reason != "" {
		os.Remove(tmpPath)
		if reason == "same_version" {
			log.Printf("Auto-update: the server serves the running version v%s — nothing to update, aborting", newVersion)
		} else {
			log.Printf("Auto-update: downloaded binary reports v%s, which is not newer than the running v%s — refusing to downgrade", newVersion, running)
		}
		updateAborted(latestVersion, reason)
		return
	}
	if latestVersion != "" && newVersion != normalizeVersion(latestVersion) {
		log.Printf("WARN: Auto-update: server advertised v%s but the downloaded binary reports v%s", latestVersion, newVersion)
	} else if latestVersion == "" && isStrictlyNewer(running, newVersion) {
		log.Printf("WARN: Auto-update: update command installs an OLDER version (v%s → v%s)", running, newVersion)
	}

	if err := os.Chmod(tmpPath, 0755); err != nil {
		log.Printf("WARN: Auto-update: chmod new binary: %v", err)
	}

	// Only now tell the server we are going down for an update.
	notifyUpdating()

	if err := os.Rename(tmpPath, exePath); err != nil {
		os.Remove(tmpPath)
		log.Printf("Auto-update: rename failed: %v", err)
		updateAborted(latestVersion, "install_failed")
		return
	}

	log.Printf("Auto-update: updated v%s → v%s, restarting...", ProbeVersion, newVersion)
	restartWithNewBinary(exePath)
}
