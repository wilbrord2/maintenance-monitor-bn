import { InitialSchema1789000000000 } from './1789000000000-InitialSchema';
import { AddMachinePartsAndRecurringMaintenance1791158400000 } from './1791158400000-AddMachinePartsAndRecurringMaintenance';
import { UnifyMachineLogs1791244800000 } from './1791244800000-UnifyMachineLogs';

/** Ordered list of schema migrations. Register every new migration here. */
export const MIGRATIONS = [
  InitialSchema1789000000000,
  AddMachinePartsAndRecurringMaintenance1791158400000,
  UnifyMachineLogs1791244800000,
];
