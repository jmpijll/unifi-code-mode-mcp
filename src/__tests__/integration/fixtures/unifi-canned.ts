/**
 * Canned response data for the mock UniFi controller used by integration
 * tests. Shapes mirror what the real Network Integration v1 API returns
 * for the operations our scenarios exercise. Values are obviously
 * synthetic — no MAC/IP from real hardware.
 */

export const SITE_ID = '00000000-0000-4000-8000-000000000001';
export const DEVICE_GATEWAY_ID = '00000000-0000-4000-8000-0000000000a1';
export const DEVICE_AP_LIVING_ID = '00000000-0000-4000-8000-0000000000a2';
export const DEVICE_AP_BEDROOM_ID = '00000000-0000-4000-8000-0000000000a3';
export const DEVICE_AP_HALL_ID = '00000000-0000-4000-8000-0000000000a4';
export const DEVICE_AP_ATTIC_ID = '00000000-0000-4000-8000-0000000000a5';

export const WIFI_HOME_ID = '00000000-0000-4000-8000-0000000000b1';
export const WIFI_IOT_ID = '00000000-0000-4000-8000-0000000000b2';

export const NETWORK_DEFAULT_ID = '00000000-0000-4000-8000-0000000000c1';

export const INFO = { applicationVersion: '10.1.84-test' };

export const SITES_PAGE = {
  data: [{ id: SITE_ID, name: 'Test Site', internalReference: 'test' }],
  totalCount: 1,
};

export const DEVICES_PAGE = {
  data: [
    {
      id: DEVICE_GATEWAY_ID,
      name: 'Gateway',
      model: 'UDM Pro',
      macAddress: '00:00:5e:00:53:01',
      state: 'ONLINE',
    },
    {
      id: DEVICE_AP_LIVING_ID,
      name: 'Living Room',
      model: 'U6 Pro',
      macAddress: '00:00:5e:00:53:02',
      state: 'ONLINE',
    },
    {
      id: DEVICE_AP_BEDROOM_ID,
      name: 'Bedroom',
      model: 'U6 Lite',
      macAddress: '00:00:5e:00:53:03',
      state: 'ONLINE',
    },
    {
      id: DEVICE_AP_HALL_ID,
      name: 'Hall',
      model: 'U6 Lite',
      macAddress: '00:00:5e:00:53:04',
      state: 'ONLINE',
    },
    {
      id: DEVICE_AP_ATTIC_ID,
      name: 'Attic',
      model: 'U7 Lite',
      macAddress: '00:00:5e:00:53:05',
      state: 'ONLINE',
    },
  ],
  totalCount: 5,
};

export const NETWORKS_PAGE = {
  data: [
    {
      id: NETWORK_DEFAULT_ID,
      name: 'Default',
      vlanId: 1,
      management: 'GATEWAY',
      enabled: true,
      default: true,
    },
  ],
  totalCount: 1,
};

export const WANS_PAGE = {
  data: [
    { id: '00000000-0000-4000-8000-0000000000d1', name: 'Internet 1' },
    { id: '00000000-0000-4000-8000-0000000000d2', name: 'Internet 2' },
  ],
  totalCount: 2,
};

export const WIFI_PAGE = {
  data: [
    {
      id: WIFI_HOME_ID,
      name: 'Home',
      type: 'STANDARD',
      enabled: true,
      network: { type: 'NATIVE' },
      securityConfiguration: { type: 'WPA2_PERSONAL' },
      broadcastingFrequenciesGHz: [2.4, 5],
    },
    {
      id: WIFI_IOT_ID,
      name: 'Home-IoT',
      type: 'IOT_OPTIMIZED',
      enabled: true,
      network: { type: 'NATIVE' },
      securityConfiguration: { type: 'WPA2_PERSONAL' },
    },
  ],
  totalCount: 2,
};

export const WIFI_HOME_DETAILS = {
  id: WIFI_HOME_ID,
  name: 'Home',
  type: 'STANDARD',
  enabled: true,
  network: { type: 'NATIVE' },
  securityConfiguration: { type: 'WPA2_PERSONAL', passphrase: 'old-passphrase-1234' },
  broadcastingFrequenciesGHz: [2.4, 5],
};

/** Real production response when the site is on legacy (non-ZBF) firewall. */
export const FIREWALL_ZONES_LEGACY_ERROR = {
  status: 400,
  body: {
    code: 'api.firewall.zone-based-firewall-not-configured',
    message: 'Zone Based Firewall is not configured',
  },
};

export const CLIENTS_PAGE = {
  data: Array.from({ length: 12 }, (_, i) => ({
    id: `client-${String(i)}`,
    name: i % 2 === 0 ? `Wired-${String(i)}` : `Wireless-${String(i)}`,
    type: i % 2 === 0 ? 'WIRED' : 'WIRELESS',
    macAddress: `00:00:5e:00:54:${String(i).padStart(2, '0')}`,
    ipAddress: `10.0.0.${String(10 + i)}`,
  })),
  totalCount: 12,
};

// ─── Protect canned responses ────────────────────────────────────────

export const PROTECT_CAMERA_FRONT_ID = '00000000-0000-4000-8000-0000000000e1';
export const PROTECT_CAMERA_DRIVE_ID = '00000000-0000-4000-8000-0000000000e2';
export const PROTECT_NVR_ID = '00000000-0000-4000-8000-0000000000f1';

export const PROTECT_META_INFO = {
  applicationVersion: '7.1.46-test',
  hostShortName: 'mock-protect',
};

export const PROTECT_CAMERA_FRONT = {
  id: PROTECT_CAMERA_FRONT_ID,
  name: 'Front Door',
  type: 'UVC-G4-Bullet',
  state: 'CONNECTED',
  isPtz: false,
  channels: [{ id: 0, name: 'High', resolutionIndex: 0 }],
};

export const PROTECT_CAMERA_DRIVE = {
  id: PROTECT_CAMERA_DRIVE_ID,
  name: 'Driveway',
  type: 'UVC-G4-PTZ',
  state: 'CONNECTED',
  isPtz: true,
  channels: [{ id: 0, name: 'High', resolutionIndex: 0 }],
};

export const PROTECT_CAMERAS_PAGE = {
  data: [PROTECT_CAMERA_FRONT, PROTECT_CAMERA_DRIVE],
  totalCount: 2,
};

export const PROTECT_NVRS_PAGE = {
  data: [
    {
      id: PROTECT_NVR_ID,
      name: 'Mock NVR',
      type: 'UDM-Pro-Max',
      state: 'CONNECTED',
      version: '7.1.46-test',
    },
  ],
  totalCount: 1,
};
