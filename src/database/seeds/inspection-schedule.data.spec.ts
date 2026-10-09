import { DAILY, INSPECTION_SCHEDULE, inspectionMachines, MONTHLY, WEEKLY } from './inspection-schedule.data';

describe('inspection schedule data', () => {
  const machines = inspectionMachines();

  it('covers the 22 rows of the document, flattening systems into 36 machines', () => {
    expect(INSPECTION_SCHEDULE.map((group) => group.no)).toEqual(
      Array.from({ length: 22 }, (_, index) => index + 1),
    );
    expect(machines).toHaveLength(36);
  });

  it('gives every machine a unique name and serial number', () => {
    expect(new Set(machines.map((machine) => machine.name.toLowerCase())).size).toBe(machines.length);
    expect(new Set(machines.map((machine) => machine.serialNumber)).size).toBe(machines.length);
    for (const machine of machines) {
      expect(machine.serialNumber).toBe(machine.serialNumber.toUpperCase());
    }
  });

  it('names machines of a system after the system and keeps stand-alone names', () => {
    const names = machines.map((machine) => machine.name);
    expect(names).toContain('Laser Cutting System 1 - Air Compressor');
    expect(names).toContain('Sheet Coil Cutting System - Shear Machine');
    expect(names).toContain('Shear Machine');
    expect(
      machines.find((machine) => machine.name === 'Laser Cutting System 1 - Air Compressor'),
    ).toMatchObject({ serialNumber: 'INSP-01-04' });
  });

  it('uses only daily, weekly and monthly intervals and unique part names per machine', () => {
    for (const machine of machines) {
      for (const task of [...machine.parts, ...machine.machineTasks]) {
        expect([DAILY, WEEKLY, MONTHLY]).toContain(task.intervalDays);
      }
      const partNames = machine.parts.map((part) => part.name.toLowerCase());
      expect(new Set(partNames).size).toBe(partNames.length);
    }
  });

  it('adds cleaning to every machine and a general inspection to machines without parts', () => {
    const lathe = machines.find((machine) => machine.name === 'Lathe Machine');
    expect(lathe?.parts).toHaveLength(0);
    expect(lathe?.machineTasks.map((task) => task.name)).toEqual([
      'General inspection',
      'External cleaning',
      'Internal cleaning',
    ]);

    const laser = machines.find(
      (machine) => machine.name === 'Laser Cutting System 1 - CNC Laser Cutting Machine',
    );
    expect(laser?.parts).toHaveLength(11);
    expect(laser?.machineTasks.map((task) => task.name)).toEqual(['External cleaning', 'Internal cleaning']);
  });

  it('keeps the document frequencies', () => {
    const punching = machines.find((machine) => machine.name === 'Punching Machine');
    expect(punching?.parts.find((part) => part.name === 'Lube (gears & bearings)')?.intervalDays).toBe(DAILY);
    const laser = machines.find(
      (machine) => machine.name === 'Laser Cutting System 2 - CNC Laser Cutting Machine',
    );
    expect(laser?.parts.find((part) => part.name === 'Cutting head')?.intervalDays).toBe(WEEKLY);
  });
});
