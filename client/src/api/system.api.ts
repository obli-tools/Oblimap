import apiClient from './client';

export interface SystemInfo {
  appVersion:    string;
  nodeVersion:   string;
  probeVersion:  string;
  uptimeSeconds: number;
  memory: {
    processRssMb:  number;
    processHeapMb: number;
    systemTotalMb: number;
    systemFreeMb:  number;
  };
  cpu: {
    loadAvg1:  number;
    loadAvg5:  number;
    loadAvg15: number;
    cores:     number;
  };
  environment: {
    isDocker: boolean;
    platform: string;
    dbStatus: 'ok' | 'error';
  };
}

export const systemApi = {
  // Through apiClient: inside ObliTools it carries the X-Auth-Token header
  // (cookies are blocked in that iframe).
  async getInfo(): Promise<SystemInfo> {
    const res = await apiClient.get<SystemInfo>('/system');
    return res.data;
  },
};
