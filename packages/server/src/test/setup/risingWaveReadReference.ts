/**
 * Global server test setup (vitest setupFiles). RisingWave is a hard dependency
 * and CI has no RisingWave, so every server test explicitly installs the Postgres
 * references of the RisingWave-served reads (see src/test/risingWaveReadReference.ts).
 * A test that exercises a RisingWave read itself uninstalls them and restores
 * them in its own finally.
 */
import { installRisingWaveReadReferences } from "../risingWaveReadReference";

installRisingWaveReadReferences();
