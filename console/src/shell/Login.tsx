import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Button, Field, Notice } from '../ui';

/**
 * The login of the console: username and password, then (when the account has it) the 6-digit
 * code of the authenticator app or a recovery code. After a successful login the browser is asked
 * to save the credentials (Chrome, Edge, Android): the usual heuristics miss logins that do not
 * reload the page; the password manager then fills them in, unlocked with fingerprint or face.
 */
function rememberCredentials(id: string, password: string) {
  try {
    const W = window as unknown as { PasswordCredential?: new (o: { id: string; password: string; name: string }) => Credential };
    if (W.PasswordCredential && id && password) navigator.credentials.store(new W.PasswordCredential({ id, password, name: id })).catch(() => {});
  } catch {
    /* not supported: the browser's own heuristics still apply */
  }
}

export function Login({
  onLogin,
  onTotp,
}: {
  onLogin: (u: string, p: string) => Promise<{ mfaToken?: string; rememberDays?: number } | void>;
  onTotp: (t: string, c: string, remember: boolean) => Promise<void>;
}) {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [code, setCode] = useState('');
  // with the two-step code the console stays signed in for 30 days (titolare, 17/10/2026)
  const [remember, setRemember] = useState(true);
  const [mfa, setMfa] = useState<{ token: string; id: string; password: string; days: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (mfa) codeRef.current?.focus();
  }, [mfa]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const login = (e: FormEvent) => {
    e.preventDefault();
    const id = user.trim();
    const password = pass;
    void run(async () => {
      try {
        const r = await onLogin(id, password);
        if (r && r.mfaToken) setMfa({ token: r.mfaToken, id, password, days: r.rememberDays ?? 30 });
        else rememberCredentials(id, password);
      } finally {
        setPass('');
      }
    });
  };
  const verify = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await onTotp(mfa!.token, code.trim(), remember);
      rememberCredentials(mfa!.id, mfa!.password);
    });
  };

  return (
    <div className="lg">
      <img className="lg-logo" src="/assets/cda-net-logo.svg" alt="CDA Net" />
      <section className="ui-card lg-card">
        {!mfa ? (
          <>
            <h1>Accesso</h1>
            <p className="ui-muted">Console Admin/NOC CDA Net. Il provisioning delle CPE si esegue dall’app Android.</p>
            <form className="lg-form" onSubmit={login}>
              <Field label="Username">
                <input autoComplete="username" required value={user} onChange={(e) => setUser(e.target.value)} />
              </Field>
              <Field label="Password">
                <input type="password" autoComplete="current-password" required value={pass} onChange={(e) => setPass(e.target.value)} />
              </Field>
              {error && <Notice tone="bad">{error}</Notice>}
              <Button type="submit" variant="primary" busy={busy}>
                Accedi
              </Button>
            </form>
          </>
        ) : (
          <>
            <h1>Verifica in due passaggi</h1>
            <form className="lg-form" onSubmit={verify}>
              <Field label="Codice dell’app di autenticazione" hint="Hai perso il telefono? Inserisci uno dei codici di recupero (es. 7KQ2-M9XD).">
                <input ref={codeRef} autoComplete="one-time-code" inputMode="numeric" required maxLength={9} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
              </Field>
              <label className="ui-check">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                <span>
                  Resta connesso per {mfa.days === 1 ? '1 giorno' : `${mfa.days} giorni`} su questo browser
                  <span className="ui-field-hint">Anche chiudendo il browser. Su un computer condiviso toglilo: la sessione si chiude con il browser.</span>
                </span>
              </label>
              {error && <Notice tone="bad">{error}</Notice>}
              <Button type="submit" variant="primary" busy={busy}>
                Verifica
              </Button>
            </form>
            <button
              type="button"
              className="ui-link"
              onClick={() => {
                setMfa(null);
                setCode('');
                setError(null);
              }}
            >
              Torna indietro
            </button>
          </>
        )}
      </section>
    </div>
  );
}
