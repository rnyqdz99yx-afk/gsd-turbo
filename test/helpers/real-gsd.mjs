import { gsdCoreDir } from '../../lib/paths.mjs';
import { GSD_TESTED_RANGE, readVersion, versionInRange } from '../../lib/gsd.mjs';

// The GSD core installed on this machine (the config directory's), for the suites that run it.
export const REAL_CORE = gsdCoreDir(null);
export const REAL_VERSION = REAL_CORE ? readVersion(REAL_CORE) : null;
// TURBO_GSD_UNTESTED=1 (the nightly compatibility check): a GSD outside the tested range runs these suites too.
export const REAL_GSD = Boolean(REAL_VERSION) && (versionInRange(REAL_VERSION) || process.env.TURBO_GSD_UNTESTED === '1');
// The skip reason of a real-GSD test; false when the installed GSD runs it.
export const NO_REAL_GSD = !REAL_GSD && `GSD core ${GSD_TESTED_RANGE} is not installed`;
