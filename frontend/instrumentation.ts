type StorageLike = {
  getItem?: (key: string) => string | null;
  setItem?: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
  clear?: () => void;
};

/**
 * Some Node runtimes expose a partial `localStorage` object without methods
 * (e.g. invalid --localstorage-file), which crashes Next dev overlay on SSR.
 * Install a no-op shim so server rendering stays alive.
 */
export function register(): void {
  const g = globalThis as Record<string, unknown>;
  const ensureStorage = (key: 'localStorage' | 'sessionStorage') => {
    const raw = g[key] as StorageLike | undefined;
    if (raw && typeof raw.getItem === 'function' && typeof raw.setItem === 'function') return;
    const backing = new Map<string, string>();
    g[key] = {
      getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
      setItem: (k: string, v: string) => {
        backing.set(String(k), String(v));
      },
      removeItem: (k: string) => {
        backing.delete(String(k));
      },
      clear: () => {
        backing.clear();
      },
    } satisfies StorageLike;
  };
  ensureStorage('localStorage');
  ensureStorage('sessionStorage');
}
