import { useEffect, useState, createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { api } from './api';
import { applyDefaultLocale } from './i18n';

export type SiteInfo = { name: string; tagline: string; description: string };

// Used only until /api/v1/config resolves; also the fallback if the request fails.
const DEFAULT_SITE: SiteInfo = { name: 'Family Gallery', tagline: 'PRIVATE FAMILY PHOTOS', description: 'A self-hosted family photo album' };

const SiteContext = createContext<SiteInfo>(DEFAULT_SITE);

export function SiteProvider({ children }: { children: ReactNode }) {
  const [site, setSite] = useState<SiteInfo>(DEFAULT_SITE);
  useEffect(() => {
    api<Partial<SiteInfo> & { name?: string; defaultLocale?: string }>('/config')
      .then(result => {
        // DEFAULT_LANGUAGE governs the interface language unless the visitor
        // already chose one in the settings dialog or via ?lang=.
        applyDefaultLocale(result.defaultLocale);
        setSite({
          name: result.name?.trim() || DEFAULT_SITE.name,
          tagline: result.tagline?.trim() || DEFAULT_SITE.tagline,
          description: result.description?.trim() || DEFAULT_SITE.description,
        });
      })
      .catch(() => { /* keep defaults */ });
  }, []);
  return <SiteContext.Provider value={site}>{children}</SiteContext.Provider>;
}

export function useSite() {
  return useContext(SiteContext);
}
