/**
 * Server values of the golden test of the v1.35.11 conversion (all different from the defaults,
 * so that a value taken from the wrong place shows), and the job rendered before and after.
 */
export const GOLDEN_ENV = {
  CPE_LAN_IP: '192.168.77.1',
  CPE_LAN_NETMASK: '255.255.255.128',
  CPE_DHCP_START: '192.168.77.20',
  CPE_DHCP_END: '192.168.77.90',
  CPE_DHCP_LEASE: '900',
  CPE_PPPOE_MTU: '1480',
  CPE_PPPOE_MRU: '1470',
  CPE_WATCHDOG_HOST: '9.9.9.9',
  CPE_NTP_SERVER: '10.1.1.1',
  CPE_SSH_PORT: '2200',
  CPE_DISCOVERY_PORT: '10002',
  SNMP_COMMUNITY: 'community-di-prova',
  SNMP_CONTACT: 'noc-di-prova',
  UISP_ENROLLMENT: 'wss://uisp.example:443+golden+allowUntrustedCertificate',
};
export const GOLDEN_JOB = {
  ssid: 'CDA-NET-N2-D01',
  pppoeUser: 'rossi.mario@cda-net.it',
  pppoePassword: 'password-pppoe-di-prova',
  mac: '24:A4:3C:00:00:01',
  serial: 'SERIALE-PROVA',
};
