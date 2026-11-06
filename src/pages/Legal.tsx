// Public /privacy and /terms pages. The text lives in legal/*.md (plain Markdown the
// owner edits); it is bundled at build time. Works signed out and inside the desktop
// and mobile shells (in-app routes; the contact email opens via the external-link handler).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import privacyMd from '../../legal/privacy.md?raw';
import termsMd from '../../legal/terms.md?raw';
import { APP_NAME } from '../../shared/config.ts';
import { get } from '../api.ts';
import { Markdown } from '../lib/markdown.tsx';

export const LEGAL_DEFAULTS = { CONTACT_EMAIL: 'support@devswartz.com', OPERATOR_NAME: 'devswartz.com', APP_NAME };

export function LegalPage({ doc }: { doc: 'privacy' | 'terms' }) {
  const [values, setValues] = useState<Record<string, string>>(LEGAL_DEFAULTS);
  useEffect(() => {
    // The server may override the defaults with LEGAL_CONTACT_EMAIL / LEGAL_OPERATOR_NAME.
    get<{ legalContactEmail?: string; legalOperatorName?: string }>('/auth/config')
      .then((c) =>
        setValues({
          ...LEGAL_DEFAULTS,
          ...(c.legalContactEmail ? { CONTACT_EMAIL: c.legalContactEmail } : {}),
          ...(c.legalOperatorName ? { OPERATOR_NAME: c.legalOperatorName } : {}),
        }),
      )
      .catch(() => {});
  }, []);
  useEffect(() => {
    const prev = document.title;
    document.title = `${doc === 'privacy' ? 'Privacy Policy' : 'Terms of Service'} · ${APP_NAME}`;
    return () => void (document.title = prev);
  }, [doc]);
  return (
    <div className="legal-page">
      <article className="legal-card">
        <Link className="link small" to="/">
          ← Back to {APP_NAME}
        </Link>
        <Markdown
          source={doc === 'privacy' ? privacyMd : termsMd}
          values={values}
          link={(href, children, key) =>
            href.startsWith('/') ? (
              <Link key={key} to={href}>
                {children}
              </Link>
            ) : (
              <a key={key} href={href}>
                {children}
              </a>
            )
          }
        />
      </article>
    </div>
  );
}

/** "Privacy · Terms" links for the login screen. */
export function LegalLinks({ className = 'muted small center' }: { className?: string }) {
  return (
    <p className={className}>
      <Link to="/privacy">Privacy</Link> · <Link to="/terms">Terms</Link>
    </p>
  );
}
