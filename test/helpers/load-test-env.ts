import { resolve } from 'node:path';
import { config } from 'dotenv';

// Shell-provided variables win, so CI can point DATABASE_URL at its own database.
config({ path: resolve(__dirname, '../../.env.test'), quiet: true });
