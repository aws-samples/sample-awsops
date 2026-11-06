// Client-safe helpers for the /eks page's automatic member registration.
//
// GET /api/eks never writes. It flags `accessEntryVerified` on listed-but-unregistered
// member clusters whose registered read role has a verified Access Entry (admins only).
// The admin page then sends the ordinary POST /api/eks/[cluster]/register with
// `{auto:true}`, so the write goes through the same admin, Access Entry and
// isEnvCluster checks and the same audit log line as the manual [조회 등록] button.
//
// DELETE suppression: eks_registrations has no column that can mark a removed cluster
// without also allow-listing it (every row is a registration), and this feature must not
// add a migration. A cluster this browser's admin unregistered is therefore remembered
// in localStorage and skipped by auto-registration until a manual [조회 등록] clears it.
// Limitation: the marker is per browser profile — another admin, browser or a cleared
// storage can auto-register the cluster again while its Access Entry remains. Removing
// the owner's Access Entry is the durable way to keep a member cluster unregistered.

export const AUTO_REGISTER_SUPPRESS_KEY = 'awsops.eks.autoRegisterSuppressed.v1';
const MAX_ENTRIES = 500;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

export function readAutoRegisterSuppressed(storage: StorageLike | null = defaultStorage()): Set<string> {
  if (!storage) return new Set();
  try {
    const raw = JSON.parse(storage.getItem(AUTO_REGISTER_SUPPRESS_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function write(ids: Set<string>, storage: StorageLike | null) {
  if (!storage) return;
  try {
    storage.setItem(AUTO_REGISTER_SUPPRESS_KEY, JSON.stringify([...ids].slice(-MAX_ENTRIES)));
  } catch { /* storage full/blocked — suppression degrades to this page view only */ }
}

/** DELETE succeeded: keep auto-registration from re-adding this cluster in this browser. */
export function suppressAutoRegister(id: string, storage: StorageLike | null = defaultStorage()) {
  const ids = readAutoRegisterSuppressed(storage);
  ids.delete(id); // re-append so the newest marker survives the size cap
  ids.add(id);
  write(ids, storage);
}

/** Manual [조회 등록]/auth save: the admin explicitly wants the cluster back. */
export function clearAutoRegisterSuppression(id: string, storage: StorageLike | null = defaultStorage()) {
  const ids = readAutoRegisterSuppressed(storage);
  if (ids.delete(id)) write(ids, storage);
}

export interface AutoRegisterRow {
  id?: string; name: string; access: string; runtime?: boolean; accessEntryVerified?: boolean;
}

/** Cluster ids the admin page should auto-POST, excluding suppressed and already-tried ids. */
export function autoRegisterCandidates(
  rows: AutoRegisterRow[], opts: { admin: boolean; suppressed: Set<string>; attempted: Set<string> },
): string[] {
  if (!opts.admin) return [];
  return rows.flatMap((row) => {
    const id = row.id ?? row.name;
    return row.accessEntryVerified === true && row.access === 'entry-only' && !row.runtime
      && !opts.suppressed.has(id) && !opts.attempted.has(id) ? [id] : [];
  });
}
