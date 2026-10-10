//go:build windows

package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const serviceName = "OblimapProbe"
const serviceDisplayName = "Oblimap Probe"
const serviceDescription = "Oblimap network scanning probe"

type probeService struct {
	mainFn func()
}

func (p *probeService) Execute(args []string, r <-chan svc.ChangeRequest, s chan<- svc.Status) (bool, uint32) {
	s <- svc.Status{State: svc.StartPending}

	// Redirect log output to file when running as service
	logPath := filepath.Join(configDir(), "probe.log")
	if err := os.MkdirAll(configDir(), 0750); err == nil {
		if lf, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0640); err == nil {
			log.SetOutput(lf)
		}
	}

	s <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}

	done := make(chan struct{})
	go func() {
		p.mainFn()
		close(done)
	}()

	for {
		select {
		case c := <-r:
			switch c.Cmd {
			case svc.Stop, svc.Shutdown:
				s <- svc.Status{State: svc.StopPending}
				return false, 0
			}
		case <-done:
			return false, 0
		}
	}
}

func runAsService(mainFn func()) {
	isSvc, err := svc.IsWindowsService()
	if err != nil {
		log.Printf("WARN: cannot determine if running as service: %v", err)
	}
	if isSvc {
		if err := svc.Run(serviceName, &probeService{mainFn: mainFn}); err != nil {
			log.Fatalf("Service run failed: %v", err)
		}
		return
	}
	// Not running as service — run interactively
	mainFn()
}

func serviceInstall() error {
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("get executable path: %w", err)
	}

	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(serviceName)
	if err == nil {
		s.Close()
		return fmt.Errorf("service %q already exists", serviceName)
	}

	s, err = m.CreateService(serviceName, exePath, mgr.Config{
		DisplayName: serviceDisplayName,
		Description: serviceDescription,
		StartType:   mgr.StartAutomatic,
	})
	if err != nil {
		return fmt.Errorf("create service: %w", err)
	}
	defer s.Close()

	if err := s.Start(); err != nil {
		return fmt.Errorf("start service: %w", err)
	}

	// Wait for service to enter Running state
	for range 10 {
		status, err := s.Query()
		if err == nil && status.State == svc.Running {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return nil
}

func serviceUninstall() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("service %q not found: %w", serviceName, err)
	}
	defer s.Close()

	_, _ = s.Control(svc.Stop)
	time.Sleep(1 * time.Second)

	return s.Delete()
}
