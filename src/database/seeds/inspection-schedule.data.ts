/**
 * The plant's machine inspection schedule (docs/INSPECTION SCHEDULE.docx):
 * which parts of which machine are inspected, and how often.
 *
 * The document groups some machines into systems (e.g. Laser Cutting System 1
 * is a CNC laser, a chiller, a voltage regulator and an air compressor). The
 * application has no system level, so each machine of a system becomes its own
 * machine named "<System> - <Machine>". Machines listed without parts are
 * inspected as a whole ("General inspection"), and every machine gets the
 * document's cleaning rules (external daily, internal weekly).
 */

export const DAILY = 1;
export const WEEKLY = 7;
export const MONTHLY = 30;

export interface InspectionTask {
  readonly name: string;
  readonly intervalDays: number;
}

export interface InspectionMachine {
  /** Omitted for a stand-alone machine, which takes the group's name. */
  readonly name?: string;
  /** Part inspections; empty when the document lists no parts. */
  readonly parts: readonly InspectionTask[];
}

export interface InspectionGroup {
  /** Row number in the document. */
  readonly no: number;
  readonly name: string;
  readonly machines: readonly InspectionMachine[];
}

/** Machine-wide tasks every machine gets. */
export const CLEANING_TASKS: readonly InspectionTask[] = [
  { name: 'External cleaning', intervalDays: DAILY },
  { name: 'Internal cleaning', intervalDays: WEEKLY },
];

/** The machine-wide task of a machine listed without parts. */
export const GENERAL_INSPECTION: InspectionTask = { name: 'General inspection', intervalDays: MONTHLY };

const task = (name: string, intervalDays: number): InspectionTask => ({ name, intervalDays });
const standalone = (no: number, name: string, parts: readonly InspectionTask[]): InspectionGroup => ({
  no,
  name,
  machines: [{ parts }],
});

const laserCuttingSystem = (
  no: number,
  name: string,
  variant: { proximitySensors: string; stabilization: string },
): InspectionGroup => ({
  no,
  name,
  machines: [
    {
      name: 'CNC Laser Cutting Machine',
      parts: [
        task('Servo adjustments', MONTHLY),
        task('Control circuit (Cabinet)', WEEKLY),
        task('Solenoid valve', MONTHLY),
        task('Linear guide bearings', MONTHLY),
        task('Cutting head', WEEKLY),
        task('Cooling water hoses & fittings', MONTHLY),
        task('Pinion, rack and guideway', MONTHLY),
        task('Laser generator', MONTHLY),
        task('Computer, remote, mouse', WEEKLY),
        task('XYZ axis lubricator', MONTHLY),
        task(variant.proximitySensors, WEEKLY),
      ],
    },
    {
      name: 'Industrial Chiller',
      parts: [
        task('Refrigeration system', MONTHLY),
        task('Cooling water tank', MONTHLY),
        task('Water pump', MONTHLY),
      ],
    },
    {
      name: 'Voltage Regulator',
      parts: [
        task('Carbon brushes', WEEKLY),
        task(variant.stabilization, WEEKLY),
        task('Electrical connections', WEEKLY),
      ],
    },
    {
      name: 'Air Compressor',
      parts: [
        task('Solenoid valves', MONTHLY),
        task('Oil level', WEEKLY),
        task('Total run time', WEEKLY),
        task('Air inlet filter', WEEKLY),
        task('Electric motor and compressor', MONTHLY),
        task('Electrical control circuit', WEEKLY),
        task('Cooling fan', MONTHLY),
      ],
    },
  ],
});

const fourColumnHydraulicPress = (no: number, name: string): InspectionGroup =>
  standalone(no, name, [
    task('Hydraulic system', MONTHLY),
    task('Sensors', WEEKLY),
    task('Oil level', MONTHLY),
    task('Dies', MONTHLY),
    task('Hoses', MONTHLY),
    task('Pump', MONTHLY),
    task('Columns', MONTHLY),
    task('Oil filter', MONTHLY),
    task('Electrical control circuit', MONTHLY),
  ]);

const spotWeldingMachine = (name: string): InspectionMachine => ({
  name,
  parts: [
    task('Welding electrode', WEEKLY),
    task('Solenoid valve', WEEKLY),
    task('Cooling water hoses', WEEKLY),
    task('Water pump and tank', WEEKLY),
    task('Pneumatic system (FRL & solenoid valve)', WEEKLY),
    task('Lube (piston rod)', WEEKLY),
    task('Computer', MONTHLY),
    task('Electrical control circuit', WEEKLY),
  ],
});

export const INSPECTION_SCHEDULE: readonly InspectionGroup[] = [
  laserCuttingSystem(1, 'Laser Cutting System 1', {
    proximitySensors: 'XYZ proximity sensors',
    stabilization: 'Stabilization coils',
  }),
  laserCuttingSystem(2, 'Laser Cutting System 2', {
    proximitySensors: 'XYZ sensors',
    stabilization: 'Stabilization system',
  }),
  standalone(3, 'Shear Machine', [
    task('Lubrication oil', MONTHLY),
    task('Electromagnetic power-off brake', WEEKLY),
    task('Foot pedal', WEEKLY),
    task('Support screw', MONTHLY),
    task('V-belts', MONTHLY),
    task('Bearings and blade alignment', MONTHLY),
  ]),
  standalone(4, 'CNC Rolling Machine', [
    task('Screen and settings', MONTHLY),
    task('Sensors', MONTHLY),
    task('Hydraulic system', MONTHLY),
    task('Lubrication (cycloidal & bearings)', MONTHLY),
    task('Electrical control circuit', MONTHLY),
    task('Rollers', MONTHLY),
  ]),
  standalone(5, 'Mechanical Rolling Machine', [
    task('Rollers & chain drive', MONTHLY),
    task('Limit switches', MONTHLY),
    task('Foot pedal', MONTHLY),
    task('Lube (cycloidal, rollers & bearings)', MONTHLY),
    task('Electrical control circuit', MONTHLY),
  ]),
  standalone(6, 'Lathe Machine', []),
  standalone(7, 'Lock Forming Machine', [
    task('Forming dies', WEEKLY),
    task('V-belts', MONTHLY),
    task('Lube (gears & bearings)', MONTHLY),
    task('Electrical control circuit', MONTHLY),
  ]),
  standalone(8, 'Seaming Machine', [
    task('Forming dies', MONTHLY),
    task('Lube (reducer, rack & pinion)', MONTHLY),
    task('Bearings', MONTHLY),
    task('Forming arm', MONTHLY),
    task('Chain drive', MONTHLY),
    task('Foot pedal', MONTHLY),
    task('Electrical control circuit', MONTHLY),
  ]),
  standalone(9, 'Beading Machine', [
    task('Forming die', MONTHLY),
    task('Adjustable handwheel', MONTHLY),
    task('Lube (reducer, gears & bearings)', WEEKLY),
    task('V-belt', MONTHLY),
    task('Foot pedal', MONTHLY),
    task('Reducer (worm gear & worm)', MONTHLY),
    task('Electrical control circuit', MONTHLY),
  ]),
  standalone(10, 'Punching Machine', [
    task('Dies', WEEKLY),
    task('Brake', WEEKLY),
    task('Clutch', MONTHLY),
    task('Bearings & bushes', MONTHLY),
    task('V-belt', MONTHLY),
    task('Clamps', MONTHLY),
    task('Electrical control circuit', MONTHLY),
    task('Lube (gears & bearings)', DAILY),
  ]),
  fourColumnHydraulicPress(11, 'Four Column Hydraulic Press 1'),
  fourColumnHydraulicPress(12, 'Four Column Hydraulic Press 2'),
  standalone(13, 'Flanging Machine 2', [
    task('Clamping tool & locking nut', MONTHLY),
    task('Hydraulic system', MONTHLY),
    task('Pneumatic system (FRL & solenoid valve)', MONTHLY),
    task('Piston sensors', MONTHLY),
    task('V-belt', MONTHLY),
    task('Lube (reducer & bearings)', MONTHLY),
    task('Screen and settings', MONTHLY),
    task('Oil filter', MONTHLY),
    task('Electrical control circuit', MONTHLY),
  ]),
  standalone(14, 'Sensitive Drill Machine', [
    task('V-belt', MONTHLY),
    task('Electrical control circuit', MONTHLY),
    task('Lube', WEEKLY),
    task('Clamps', WEEKLY),
  ]),
  standalone(15, 'Coding Machine 2', [
    task('Field lens', MONTHLY),
    task('Lube (focus adjusting screw)', MONTHLY),
    task('Computer, remote, mouse', WEEKLY),
    task('Laser source', MONTHLY),
    task('Electrical control circuit', MONTHLY),
  ]),
  standalone(16, 'Automatic Welding Machine 1', []),
  standalone(17, 'Automatic Welding Machine 2', []),
  {
    no: 18,
    name: 'Spot Welding System',
    machines: [
      spotWeldingMachine('Spot Welding Machine 1'),
      spotWeldingMachine('Spot Welding Machine 2'),
      spotWeldingMachine('Spot Welding Machine 3'),
      spotWeldingMachine('Spot Welding Machine 4'),
    ],
  },
  standalone(19, 'Weight Lift', []),
  standalone(20, 'Overhead Crane', [
    task('Lower gear drive mechanism lube', MONTHLY),
    task('Upper gear drive mechanism lube', MONTHLY),
    task('Limit switches', MONTHLY),
    task('Electrical control circuit', MONTHLY),
    task('Wire rope & hook', MONTHLY),
    task('Lifting chain', MONTHLY),
    task('Brake', MONTHLY),
    task('Hydraulic system', MONTHLY),
  ]),
  {
    no: 21,
    name: 'Sheet Coil Cutting System',
    machines: [
      {
        name: 'Uncoiler Machine',
        parts: [
          task('Pneumatic system (FRL & solenoid valve)', MONTHLY),
          task('Diaphragm brake', MONTHLY),
          task('Hydraulic system', MONTHLY),
          task('Bearings', WEEKLY),
          task('Lube (cycloidal, bearings & other moving parts)', WEEKLY),
          task('Sensors', WEEKLY),
          task('Chain & sprocket', WEEKLY),
          task('Electrical control circuit', MONTHLY),
        ],
      },
      {
        name: 'Sheet Guide',
        parts: [task('Bearings', MONTHLY), task('Guide rolls', MONTHLY), task('Level', MONTHLY)],
      },
      {
        name: 'Straightener Machine',
        parts: [
          task('Pneumatic system (FRL & solenoid valve)', MONTHLY),
          task('Lube (cycloidal, rollers & bearings)', MONTHLY),
          task('Encoder', MONTHLY),
          task('Electrical control circuit', MONTHLY),
        ],
      },
      {
        name: 'Shear Machine',
        parts: [
          task('Pneumatic system (FRL & solenoid valve)', MONTHLY),
          task('Lube (gear drive, clutch, blade bush, bush bearings)', MONTHLY),
          task('Sensor', MONTHLY),
          task('Electrical control circuit', MONTHLY),
        ],
      },
      {
        name: 'Conveyor Machine',
        parts: [
          task('Conveyor belt', MONTHLY),
          task('V-belt', MONTHLY),
          task('Bearings', WEEKLY),
          task('Lube (cycloidal, rollers & bearings)', MONTHLY),
          task('Electrical control circuit', MONTHLY),
        ],
      },
      {
        name: 'Control Board',
        parts: [
          task('Electrical control circuit', WEEKLY),
          task('Screen (monitor)', MONTHLY),
          task('Ventilation', MONTHLY),
          task('Inverters', MONTHLY),
        ],
      },
    ],
  },
  standalone(22, 'Riveting Machine', [
    task('Pneumatic system (FRL & solenoid valve)', MONTHLY),
    task('Lube (rack and pinion)', MONTHLY),
    task('Forming die', MONTHLY),
    task('Lubrication', WEEKLY),
    task('Electrical control circuit', MONTHLY),
  ]),
];

/** One machine to seed, with its derived name and serial number. */
export interface SeedMachine {
  readonly name: string;
  readonly serialNumber: string;
  readonly parts: readonly InspectionTask[];
  readonly machineTasks: readonly InspectionTask[];
}

/**
 * Flattens the document into machines: "Laser Cutting System 1 - Air Compressor"
 * (serial INSP-01-04) for machines of a system, the group name (serial INSP-03)
 * for stand-alone machines.
 */
export function inspectionMachines(groups: readonly InspectionGroup[] = INSPECTION_SCHEDULE): SeedMachine[] {
  return groups.flatMap((group) => {
    const groupCode = `INSP-${String(group.no).padStart(2, '0')}`;
    return group.machines.map((machine, index) => ({
      name: machine.name ? `${group.name} - ${machine.name}` : group.name,
      serialNumber: machine.name ? `${groupCode}-${String(index + 1).padStart(2, '0')}` : groupCode,
      parts: machine.parts,
      machineTasks: [...(machine.parts.length === 0 ? [GENERAL_INSPECTION] : []), ...CLEANING_TASKS],
    }));
  });
}
