/**
 * Simulated OT architecture of Meridian Works Unit 3.
 *
 * A Purdue-style layout sized to the facility: five controllers at Level 1, an
 * operator HMI, SCADA server and engineering workstation at Level 2, a historian at
 * Level 3, a remote-access jump host in the industrial DMZ, and the enterprise
 * network beyond it. Addresses, models and identities are invented; nothing here
 * describes or connects to a real network.
 *
 * Every cyber-physical link is declared in `controls` and `parameters`.
 */
import type { OtModel } from '../cyber/types';

const EPOCH = Date.UTC(2026, 0, 12, 6, 0, 0);
const at = (h: number, m = 0) => EPOCH + ((h - 6) * 60 + m) * 60_000;

export const OT_MODEL: OtModel = {
  zones: [
    { id: 'Z-CTL', name: 'Control network', level: 'L1', subnet: '10.20.1.0/24', description: 'Controllers and their field I/O.' },
    { id: 'Z-SUP', name: 'Supervisory network', level: 'L2', subnet: '10.20.2.0/24', description: 'Operator HMI, SCADA server and engineering workstation.' },
    { id: 'Z-OPS', name: 'Site operations', level: 'L3', subnet: '10.20.3.0/24', description: 'Process historian.' },
    { id: 'Z-DMZ', name: 'Industrial DMZ', level: 'DMZ', subnet: '10.20.9.0/24', description: 'Boundary firewall and the remote-access jump host.' },
    { id: 'Z-ENT', name: 'Enterprise network', level: 'L4', subnet: '10.10.0.0/16', description: 'Business network. Must never reach Levels 1–2 directly.' },
  ],
  devices: [
    { id: 'PLC-200', name: 'Pump house controller', kind: 'plc', zoneId: 'Z-CTL', address: '10.20.1.20', areaId: 'A200', position: { x: -24, y: 0, z: -10 }, vendorModel: 'Simulated PLC, 32 I/O', description: 'Feed pump duty selection, speed and tank make-up.' },
    { id: 'PLC-300', name: 'Process controller', kind: 'plc', zoneId: 'Z-CTL', address: '10.20.1.30', areaId: 'A300', position: { x: -2, y: 0, z: -9 }, vendorModel: 'Simulated PLC, 32 I/O', description: 'Reactor level, agitator and process cooler.' },
    { id: 'PLC-400', name: 'Packaging line controller', kind: 'plc', zoneId: 'Z-CTL', address: '10.20.1.40', areaId: 'A400', position: { x: 6, y: 0, z: 14.5 }, vendorModel: 'Simulated PLC, 64 I/O', description: 'Filler, conveyors, case packer and palletiser.' },
    { id: 'PLC-500', name: 'Cooling plant controller', kind: 'plc', zoneId: 'Z-CTL', address: '10.20.1.50', areaId: 'A500', position: { x: 36, y: 0, z: -6 }, vendorModel: 'Simulated PLC, 32 I/O', description: 'Cooling-tower fan drive, cooling-water pump and trim chiller.' },
    { id: 'PLC-600', name: 'Utilities controller', kind: 'plc', zoneId: 'Z-CTL', address: '10.20.1.60', areaId: 'A600', position: { x: -7, y: 0, z: 21.5 }, vendorModel: 'Simulated PLC, 16 I/O', description: 'Plant air compressor; power monitoring of the transformer and both MCCs.' },
    { id: 'SW-101', name: 'Control network switch', kind: 'switch', zoneId: 'Z-CTL', address: '10.20.1.2', areaId: null, position: { x: -1, y: 0, z: 16 }, vendorModel: 'Simulated managed switch', description: 'Connects the controllers to the supervisory network.' },
    { id: 'HMI-01', name: 'Operator HMI', kind: 'hmi', zoneId: 'Z-SUP', address: '10.20.2.11', areaId: null, position: { x: -3.5, y: 0, z: 20 }, vendorModel: 'Simulated HMI station', description: 'Control-room operator interface. Reads and writes operating setpoints.' },
    { id: 'SCADA-01', name: 'SCADA server', kind: 'scada', zoneId: 'Z-SUP', address: '10.20.2.10', areaId: null, position: { x: -1, y: 0, z: 22 }, vendorModel: 'Simulated SCADA server', description: 'Polls the controllers and forwards data to the historian.' },
    { id: 'EWS-01', name: 'Engineering workstation', kind: 'ews', zoneId: 'Z-SUP', address: '10.20.2.21', areaId: null, position: { x: 1.5, y: 0, z: 20 }, vendorModel: 'Simulated engineering workstation', description: 'Holds the controller projects; the only host meant to change controller configuration.' },
    { id: 'SW-201', name: 'Supervisory switch', kind: 'switch', zoneId: 'Z-SUP', address: '10.20.2.2', areaId: null, position: null, vendorModel: 'Simulated managed switch', description: 'Supervisory network switch.' },
    { id: 'HIST-01', name: 'Process historian', kind: 'historian', zoneId: 'Z-OPS', address: '10.20.3.15', areaId: null, position: null, vendorModel: 'Simulated historian', description: 'Long-term process data store.' },
    { id: 'FW-01', name: 'OT boundary firewall', kind: 'firewall', zoneId: 'Z-DMZ', address: '10.20.9.1', areaId: null, position: null, vendorModel: 'Simulated firewall', description: 'Enforces the conduits between zones.' },
    { id: 'JMP-01', name: 'Remote-access jump host', kind: 'jump_host', zoneId: 'Z-DMZ', address: '10.20.9.20', areaId: null, position: null, vendorModel: 'Simulated jump host', description: 'The approved path for remote vendor support into the supervisory network.' },
    { id: 'ENT-01', name: 'Enterprise network', kind: 'enterprise', zoneId: 'Z-ENT', address: '10.10.0.0/16', areaId: null, position: null, vendorModel: '—', description: 'Business hosts, represented as one node.' },
  ],
  links: [
    { from: 'PLC-200', to: 'SW-101' },
    { from: 'PLC-300', to: 'SW-101' },
    { from: 'PLC-400', to: 'SW-101' },
    { from: 'PLC-500', to: 'SW-101' },
    { from: 'PLC-600', to: 'SW-101' },
    { from: 'SW-101', to: 'SW-201' },
    { from: 'HMI-01', to: 'SW-201' },
    { from: 'SCADA-01', to: 'SW-201' },
    { from: 'EWS-01', to: 'SW-201' },
    { from: 'SW-201', to: 'FW-01' },
    { from: 'HIST-01', to: 'FW-01' },
    { from: 'JMP-01', to: 'FW-01' },
    { from: 'ENT-01', to: 'FW-01' },
  ],
  conduits: [
    { id: 'C-01', fromZone: 'Z-SUP', toZone: 'Z-CTL', protocols: ['EtherNet/IP', 'Engineering'], description: 'HMI and SCADA polling; engineering access from the workstation.' },
    { id: 'C-02', fromZone: 'Z-SUP', toZone: 'Z-OPS', protocols: ['OPC UA'], description: 'SCADA to historian data collection.' },
    { id: 'C-03', fromZone: 'Z-DMZ', toZone: 'Z-SUP', protocols: ['RDP'], description: 'Jump host to engineering workstation, for remote vendor support.' },
    { id: 'C-04', fromZone: 'Z-ENT', toZone: 'Z-DMZ', protocols: ['RDP', 'HTTPS'], description: 'Enterprise users to the jump host.' },
  ],
  controls: [
    ...['TK-101', 'P-101', 'P-102', 'M-101', 'M-102', 'LS-601'].map((assetId) => ({ plcId: 'PLC-200', assetId, kind: 'controls' as const })),
    ...['HX-201', 'RX-301', 'M-301'].map((assetId) => ({ plcId: 'PLC-300', assetId, kind: 'controls' as const })),
    ...['FL-310', 'CV-320', 'M-320', 'PK-330', 'CV-340', 'M-340', 'PZ-350'].map((assetId) => ({ plcId: 'PLC-400', assetId, kind: 'controls' as const })),
    ...['CT-401', 'P-401', 'M-401', 'CH-402'].map((assetId) => ({ plcId: 'PLC-500', assetId, kind: 'controls' as const })),
    { plcId: 'PLC-600', assetId: 'AC-610', kind: 'controls' },
    ...['TX-501', 'MCC-510', 'MCC-520'].map((assetId) => ({ plcId: 'PLC-600', assetId, kind: 'monitors' as const })),
  ],
  parameters: [
    {
      id: 'PLC-500:CT401_FAN_SPEED_SP',
      plcId: 'PLC-500',
      name: 'Cooling-tower fan speed setpoint',
      unit: '%',
      nominal: 100,
      affects: ['CT-401'],
      expectedSignals: [
        { signalId: 'CT-401.FAN_CURRENT', whenDecreased: 'low' },
        { signalId: 'CT-401.FAN_VIB', whenDecreased: 'low' },
        { signalId: 'CT-401.BASIN_TEMP', whenDecreased: 'high' },
        { signalId: 'CH-402.LOAD', whenDecreased: 'high' },
      ],
      description: 'Speed reference to the fan drive. Lower speed means less airflow and less heat rejected.',
    },
    {
      id: 'PLC-500:CH402_LEAVING_T_SP',
      plcId: 'PLC-500',
      name: 'Chiller leaving-water temperature setpoint',
      unit: '°C',
      nominal: 14,
      affects: ['CH-402'],
      expectedSignals: [],
      description: 'Not wired into the process model in this simulation.',
    },
    {
      id: 'PLC-200:FEED_FLOW_SP',
      plcId: 'PLC-200',
      name: 'Feed flow setpoint',
      unit: 'm³/h',
      nominal: 120,
      affects: ['P-101', 'P-102'],
      expectedSignals: [],
      description: 'Not wired into the process model in this simulation (rate changes use the operations channel).',
    },
    {
      id: 'PLC-400:FL310_FILL_TARGET',
      plcId: 'PLC-400',
      name: 'Filler fill target',
      unit: 'g',
      nominal: 500,
      affects: ['FL-310'],
      expectedSignals: [],
      description: 'Not wired into the process model in this simulation.',
    },
  ],
  identities: [
    { id: 'op.shift', role: 'operator', description: 'Control-room operator on shift (role account).', usualHosts: ['HMI-01'] },
    { id: 'eng.controls', role: 'controls_engineer', description: 'Site controls engineer (role account).', usualHosts: ['EWS-01'] },
    { id: 'vendor.remote', role: 'vendor_support', description: 'Cooling-plant vendor support account, used through the jump host.', usualHosts: ['JMP-01', 'EWS-01'] },
    { id: 'svc.historian', role: 'service', description: 'Historian collection service.', usualHosts: ['SCADA-01', 'HIST-01'] },
  ],
  changeRecords: [
    {
      id: 'CHG-1042',
      title: 'Cooling-tower fan drive energy tuning',
      plcId: 'PLC-500',
      parameterIds: ['PLC-500:CT401_FAN_SPEED_SP'],
      identity: 'eng.controls',
      sourceHost: 'EWS-01',
      windowStart: at(6),
      windowEnd: at(10),
      allowedRange: [55, 100],
      approvedBy: 'Shift manager (simulated)',
    },
    {
      id: 'CHG-1038',
      title: 'Packaging recipe update',
      plcId: 'PLC-400',
      parameterIds: ['PLC-400:FL310_FILL_TARGET'],
      identity: 'eng.controls',
      sourceHost: 'EWS-01',
      windowStart: at(30),
      windowEnd: at(32),
      allowedRange: [480, 520],
      approvedBy: 'Production manager (simulated)',
    },
  ],
};
