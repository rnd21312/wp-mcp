import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Lang = 'fa' | 'en';

interface Ctx {
  lang: Lang;
  setLang: (l: Lang) => void;
  /** Picks the English or Persian text. */
  t: (en: string, fa: string) => string;
}

const I18n = createContext<Ctx>({ lang: 'fa', setLang: () => undefined, t: (en) => en });

const read = (): Lang => {
  try {
    return localStorage.getItem('wpm_lang') === 'en' ? 'en' : 'fa';
  } catch {
    return 'fa';
  }
};

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(read);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr';
    try {
      localStorage.setItem('wpm_lang', lang);
    } catch {
      /* private mode */
    }
  }, [lang]);
  const value = useMemo<Ctx>(() => ({ lang, setLang, t: (en, fa) => (lang === 'fa' ? fa : en) }), [lang]);

  return <I18n.Provider value={value}>{children}</I18n.Provider>;
}

export const useI18n = (): Ctx => useContext(I18n);
