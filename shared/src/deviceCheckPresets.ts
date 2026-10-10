// Device Checks presets: ready-made rule specs an admin clones into a new rule.
// Picking a preset copies `spec` into the rule and records preset_key / preset_version;
// a newer `version` shows an "update available" chip (the update stays manual).
//
// - Treat these objects as read-only: clone before editing (e.g. structuredClone(preset.spec)).
// - Labels are English fallbacks. The client replaces them with
//   t(`deviceChecks.presets.<key>.fields.<field>`) and t(`deviceChecks.presets.<key>.assertions.<id>`).
// - Every spec must pass the rule validation (DEVICE_CHECK_LIMITS + the rule schema); the server
//   schema test validates all presets.
// - minProbeVersion is informative only: support is decided by the probe advertising
//   DEVICE_CHECKS_CAPABILITY, never by comparing version numbers.
// - When a preset changes after field validation, bump its `version`.

import type { DeviceCheckPreset } from './deviceChecks';

// ── Barix audio player: "is music playing?" ──
// Every endpoint, JSON key, XML element and HTML label below is TBV (to be validated) on one
// real unit per model and firmware, through the Test panel's body snippet. So is the
// Barix AG OUI 00:08:E1. The preset ships with validated:false until then.
const BARIX_NOW_PLAYING: DeviceCheckPreset = {
  key: 'barix.nowPlaying',
  version: 1,
  category: 'audio',
  vendor: 'Barix',
  icon: 'music',
  titleKey: 'deviceChecks.presets.barix.nowPlaying.title',
  titleFallback: 'Barix: music playing',
  descriptionKey: 'deviceChecks.presets.barix.nowPlaying.description',
  descriptionFallback:
    'Checks that a Barix audio player is really playing. Reads the current title, the player state and the firmware '
    + 'from the JSON, XML or legacy HTML status page (the first one that answers), and alerts during business hours '
    + 'when no title is reported or the player is stopped.',
  validated: false,
  validationNotes:
    'Endpoints, JSON keys, XML elements, HTML labels and OUI 00:08:E1 must be validated on one real unit per model/firmware with the Test panel',
  minProbeVersion: '2.2.0',
  spec: {
    schemaVersion: 1,
    match: {
      vendorContains: ['barix'],
      macPrefixes: ['00:08:E1'],
      excludeDeviceTypes: ['workstation', 'server', 'laptop', 'vm'],
      requireMac: true,
    },
    schedule: { intervalSeconds: 60, jitterSeconds: 10, timeoutMs: 5000 },
    fields: [
      { key: 'nowPlaying', label: 'Now playing', valueType: 'string', maxLength: 200 },
      {
        key: 'playerState', label: 'Player', valueType: 'enum',
        enumValues: [
          { value: 'playing', label: 'Playing', tone: 'ok' },
          { value: 'buffering', label: 'Buffering', tone: 'warn' },
          { value: 'stopped', label: 'Stopped', tone: 'bad' },
          { value: 'unknown', label: 'Unknown', tone: 'neutral' },
        ],
      },
      { key: 'firmware', label: 'Firmware', valueType: 'string', maxLength: 40 },
      { key: 'volume', label: 'Volume', valueType: 'number' },
    ],
    variants: [
      {
        id: 'json-status', label: 'JSON status API (newer firmware, TBV)',
        request: {
          scheme: 'http', port: 80, method: 'GET', path: '/api/v1/status',
          accept: 'application/json', auth: 'none', maxBodyBytes: 65536, followRedirects: 0,
          tlsSkipVerify: false, expectStatus: [200], charset: 'auto',
        },
        extract: [
          {
            field: 'playerState', type: 'json', path: 'player.state', required: true,
            transforms: [
              { op: 'lowercase' }, { op: 'trim' },
              {
                op: 'map',
                values: {
                  play: 'playing', playing: 'playing', buffering: 'buffering',
                  connecting: 'buffering', stop: 'stopped', stopped: 'stopped', idle: 'stopped', paused: 'stopped',
                },
                default: 'unknown',
              },
            ],
          },
          {
            field: 'nowPlaying', type: 'json', path: 'player.metadata.title',
            transforms: [{ op: 'collapseSpaces' }, { op: 'trim' }],
          },
          { field: 'firmware', type: 'json', path: 'system.firmware' },
          { field: 'volume', type: 'json', path: 'outputs[0].volume', transforms: [{ op: 'toNumber' }] },
        ],
      },
      {
        id: 'xml-status', label: 'XML status page (TBV)',
        request: {
          scheme: 'http', port: 80, method: 'GET', path: '/status.xml',
          accept: 'application/xml', auth: 'none', maxBodyBytes: 65536, followRedirects: 0,
          tlsSkipVerify: false, expectStatus: [200], charset: 'auto',
        },
        extract: [
          {
            field: 'playerState', type: 'xml', path: '/status/player/@state', required: true,
            transforms: [
              { op: 'lowercase' }, { op: 'trim' },
              {
                op: 'map',
                values: {
                  playing: 'playing', play: 'playing', buffering: 'buffering',
                  stopped: 'stopped', stop: 'stopped', idle: 'stopped',
                },
                default: 'unknown',
              },
            ],
          },
          {
            field: 'nowPlaying', type: 'xml', path: '/status/stream/title',
            transforms: [{ op: 'htmlUnescape' }, { op: 'collapseSpaces' }, { op: 'trim' }],
          },
          { field: 'firmware', type: 'xml', path: '/status/firmware' },
        ],
      },
      {
        id: 'html-status', label: 'Legacy web UI status page (HTML, often ISO-8859-1, TBV)',
        request: {
          scheme: 'http', port: 80, method: 'GET', path: '/',
          accept: 'text/html', auth: 'none', maxBodyBytes: 262144, followRedirects: 1,
          tlsSkipVerify: false, expectStatus: [200], charset: 'auto',
        },
        extract: [
          {
            field: 'nowPlaying', type: 'regex', source: 'body', group: 1, required: true,
            pattern: '(?is)(?:now\\s*playing|current\\s*(?:title|song|track)|stream\\s*title|icy[-_\\s]*title)\\s*:?\\s*(?:</?[a-z][^>]{0,80}>\\s*){0,6}([^<\\r\\n]{0,300})',
            transforms: [{ op: 'htmlUnescape' }, { op: 'collapseSpaces' }, { op: 'trim' }],
          },
          {
            field: 'playerState', type: 'regex', source: 'body', group: 1,
            pattern: '(?is)(?:player|playback|stream)\\s*(?:state|status)\\s*:?\\s*(?:</?[a-z][^>]{0,80}>\\s*){0,6}(playing|stopped|paused|buffering|connecting|idle|not connected|connected)',
            transforms: [
              { op: 'lowercase' },
              {
                op: 'map',
                values: {
                  playing: 'playing', connected: 'playing', buffering: 'buffering',
                  connecting: 'buffering', stopped: 'stopped', paused: 'stopped', idle: 'stopped',
                  'not connected': 'stopped',
                },
                default: 'unknown',
              },
            ],
          },
          {
            field: 'firmware', type: 'regex', source: 'body', group: 1,
            pattern: '(?i)firmware[^<]{0,20}(?:</?[a-z][^>]{0,80}>\\s*){0,4}([0-9][0-9a-z._-]{0,30})',
          },
        ],
      },
    ],
    assertions: [
      { id: 'hasTitle', label: 'A title is reported', field: 'nowPlaying', op: 'notEmpty', enabled: true },
      {
        id: 'notPlaceholder', label: 'Title is not a placeholder', field: 'nowPlaying', op: 'notMatches',
        pattern: '(?i)^\\s*(?:-+|none|n/?a|unknown|stopped|idle|no\\s+stream|not\\s+(?:playing|connected)|connecting.*|buffering.*)\\s*$',
        optional: true, enabled: true,
      },
      {
        id: 'notStopped', label: 'Player is not stopped', field: 'playerState', op: 'notEquals',
        value: 'stopped', optional: true, enabled: true,
      },
      {
        id: 'titleMoves', label: 'Title changed in the last 90 min', field: 'nowPlaying',
        op: 'changedWithin', seconds: 5400, enabled: false,
      },
    ],
    display: { icon: 'music', primary: 'nowPlaying', badge: 'playerState', secondary: 'firmware' },
    alerting: {
      enabled: true, severity: 'down',
      failAfterRuns: 3, failForSeconds: 180, recoverAfterRuns: 2, recoverForSeconds: 60,
      treatErrorAs: 'fail', skipWhenDeviceOffline: true,
      window: 'businessHours', graceAfterOpenSeconds: 600, onWindowClose: 'silent',
      renotifyEverySeconds: 0, notify: true, notifyRecovery: true, liveAlert: true,
      titleTemplate: 'No music: {{site}}',
      messageTemplate: '{{device}} ({{ip}}): {{failedAssertion}}{{error}}. Last title: {{value.nowPlaying}}',
    },
  },
};

// ── Generic templates ──
// The rule validation refuses a match-all rule, so the generic presets ship with a placeholder
// match (device type 'server') that the admin must edit before enabling the rule.

// HTTP answers on port 80. expectStatus lists the usual answers of a root page (200 and the
// redirects, not followed) so they count as "up"; the assertions keep the 200-399 rule explicit.
const GENERIC_HTTP_UP: DeviceCheckPreset = {
  key: 'generic.httpUp',
  version: 1,
  category: 'generic',
  vendor: null,
  icon: 'activity',
  titleKey: 'deviceChecks.presets.generic.httpUp.title',
  titleFallback: 'HTTP service up',
  descriptionKey: 'deviceChecks.presets.generic.httpUp.description',
  descriptionFallback:
    'Checks that a device answers HTTP on port 80 with a status from 200 to 399 and records the response time. '
    + 'The target devices are a placeholder (device type "server"): edit the match before enabling the rule.',
  validated: true,
  validationNotes: 'No vendor-specific assumption. Edit the target devices (placeholder: device type "server") before enabling the rule.',
  minProbeVersion: '2.2.0',
  spec: {
    schemaVersion: 1,
    match: { deviceTypes: ['server'], requireMac: true },
    schedule: { intervalSeconds: 60, jitterSeconds: 10, timeoutMs: 5000 },
    fields: [
      { key: 'http', label: 'HTTP status', valueType: 'number' },
      { key: 'ms', label: 'Response time (ms)', valueType: 'number' },
    ],
    variants: [
      {
        id: 'http-root', label: 'GET / on port 80',
        request: {
          scheme: 'http', port: 80, method: 'GET', path: '/',
          accept: '*/*', auth: 'none', maxBodyBytes: 1024, followRedirects: 0,
          tlsSkipVerify: false, expectStatus: [200, 301, 302, 307, 308], charset: 'auto',
        },
        extract: [
          { field: 'http', type: 'httpStatus' },
          { field: 'ms', type: 'durationMs' },
        ],
      },
    ],
    assertions: [
      { id: 'statusMin', label: 'HTTP status is 200 or more', field: 'http', op: 'gte', value: 200, enabled: true },
      { id: 'statusMax', label: 'HTTP status is below 400', field: 'http', op: 'lt', value: 400, enabled: true },
    ],
    display: { icon: 'activity', primary: 'http', secondary: 'ms' },
    alerting: {
      enabled: true, severity: 'down',
      failAfterRuns: 3, failForSeconds: 180, recoverAfterRuns: 2, recoverForSeconds: 60,
      treatErrorAs: 'fail', skipWhenDeviceOffline: true,
      window: 'always', graceAfterOpenSeconds: 0, onWindowClose: 'silent',
      renotifyEverySeconds: 0, notify: true, notifyRecovery: true, liveAlert: true,
      titleTemplate: 'HTTP down: {{device}}',
      messageTemplate: '{{device}} ({{ip}}) on {{site}}: {{failedAssertion}}{{error}}. HTTP status: {{value.http}}',
    },
  },
};

// The <title> of the page served on port 80 is present and not empty.
const GENERIC_HTML_TITLE: DeviceCheckPreset = {
  key: 'generic.htmlTitle',
  version: 1,
  category: 'generic',
  vendor: null,
  icon: 'info',
  titleKey: 'deviceChecks.presets.generic.htmlTitle.title',
  titleFallback: 'Web page title',
  descriptionKey: 'deviceChecks.presets.generic.htmlTitle.description',
  descriptionFallback:
    'Reads the title of the web page served on port 80 and checks that it is not empty. '
    + 'The target devices are a placeholder (device type "server"): edit the match, and the path if needed, before enabling the rule.',
  validated: true,
  validationNotes: 'No vendor-specific assumption. Edit the target devices (placeholder: device type "server") and, if needed, the path before enabling the rule.',
  minProbeVersion: '2.2.0',
  spec: {
    schemaVersion: 1,
    match: { deviceTypes: ['server'], requireMac: true },
    schedule: { intervalSeconds: 60, jitterSeconds: 10, timeoutMs: 5000 },
    fields: [
      { key: 'title', label: 'Page title', valueType: 'string', maxLength: 200 },
    ],
    variants: [
      {
        id: 'html-root', label: 'GET / on port 80 (HTML)',
        request: {
          scheme: 'http', port: 80, method: 'GET', path: '/',
          accept: 'text/html', auth: 'none', maxBodyBytes: 65536, followRedirects: 1,
          tlsSkipVerify: false, expectStatus: [200], charset: 'auto',
        },
        extract: [
          {
            field: 'title', type: 'regex', source: 'body', group: 1, required: true,
            pattern: '(?is)<title[^>]*>([^<]{0,200})</title>',
            transforms: [{ op: 'htmlUnescape' }, { op: 'collapseSpaces' }, { op: 'trim' }],
          },
        ],
      },
    ],
    assertions: [
      { id: 'hasTitle', label: 'The page has a title', field: 'title', op: 'notEmpty', enabled: true },
    ],
    display: { icon: 'info', primary: 'title' },
    alerting: {
      enabled: true, severity: 'down',
      failAfterRuns: 3, failForSeconds: 180, recoverAfterRuns: 2, recoverForSeconds: 60,
      treatErrorAs: 'fail', skipWhenDeviceOffline: true,
      window: 'always', graceAfterOpenSeconds: 0, onWindowClose: 'silent',
      renotifyEverySeconds: 0, notify: true, notifyRecovery: true, liveAlert: true,
      titleTemplate: 'Web page check failed: {{device}}',
      messageTemplate: '{{device}} ({{ip}}) on {{site}}: {{failedAssertion}}{{error}}',
    },
  },
};

// Template: one value read from a JSON API, compared with an expected value.
const GENERIC_JSON_FIELD: DeviceCheckPreset = {
  key: 'generic.jsonField',
  version: 1,
  category: 'generic',
  vendor: null,
  icon: 'activity',
  titleKey: 'deviceChecks.presets.generic.jsonField.title',
  titleFallback: 'JSON status field',
  descriptionKey: 'deviceChecks.presets.generic.jsonField.description',
  descriptionFallback:
    'Template: reads one value from a JSON status API and checks that it equals an expected value ("status" = "ok"). '
    + 'Edit the target devices (placeholder: device type "server"), the path, the JSON path and the expected value before enabling the rule.',
  validated: true,
  validationNotes: 'Template with no vendor-specific assumption. The target devices, the path (/api/status), the JSON path (status) and the expected value (ok) are placeholders: confirm them on one real device with the Test panel.',
  minProbeVersion: '2.2.0',
  spec: {
    schemaVersion: 1,
    match: { deviceTypes: ['server'], requireMac: true },
    schedule: { intervalSeconds: 60, jitterSeconds: 10, timeoutMs: 5000 },
    fields: [
      { key: 'status', label: 'Status', valueType: 'string', maxLength: 64 },
    ],
    variants: [
      {
        id: 'json-api', label: 'JSON status API',
        request: {
          scheme: 'http', port: 80, method: 'GET', path: '/api/status',
          accept: 'application/json', auth: 'none', maxBodyBytes: 65536, followRedirects: 0,
          tlsSkipVerify: false, expectStatus: [200], charset: 'auto',
        },
        extract: [
          { field: 'status', type: 'json', path: 'status', required: true, transforms: [{ op: 'trim' }, { op: 'lowercase' }] },
        ],
      },
    ],
    assertions: [
      { id: 'statusIsOk', label: 'Status equals "ok"', field: 'status', op: 'equals', value: 'ok', enabled: true },
    ],
    display: { icon: 'activity', primary: 'status' },
    alerting: {
      enabled: true, severity: 'down',
      failAfterRuns: 3, failForSeconds: 180, recoverAfterRuns: 2, recoverForSeconds: 60,
      treatErrorAs: 'fail', skipWhenDeviceOffline: true,
      window: 'always', graceAfterOpenSeconds: 0, onWindowClose: 'silent',
      renotifyEverySeconds: 0, notify: true, notifyRecovery: true, liveAlert: true,
      titleTemplate: 'Status check failed: {{device}}',
      messageTemplate: '{{device}} ({{ip}}) on {{site}}: {{failedAssertion}}{{error}}. Status: {{value.status}}',
    },
  },
};

export const DEVICE_CHECK_PRESETS: DeviceCheckPreset[] = [
  BARIX_NOW_PLAYING,
  GENERIC_HTTP_UP,
  GENERIC_HTML_TITLE,
  GENERIC_JSON_FIELD,
];

export function getDeviceCheckPreset(key: string): DeviceCheckPreset | undefined {
  return DEVICE_CHECK_PRESETS.find((p) => p.key === key);
}
