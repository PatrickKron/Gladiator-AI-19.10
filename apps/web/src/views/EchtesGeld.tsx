import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { PageHeader } from '../components/ui.js';

/**
 * Echtes Geld, auf einen Blick erklärt (Patricks Mängelliste 2026-10-22, Punkt 5): drei Wege
 * (Börse per API-Key, eigene dezentrale Trading-Wallet, nur beobachten) — je Weg: was geht,
 * was (noch) nicht, drei Schritte, ein Knopf. Der Status oben kommt aus der echten DB.
 * Nichts hier handelt — die Seite führt nur hin. Was immer gilt (Risk-Gate, kein Withdraw,
 * Paper-Default, Kill-Switch) steht am Ende.
 */
export function EchtesGeld() {
  const { t } = useTranslation();
  const [exchanges, setExchanges] = useState<number | null>(null);
  const [wallets, setWallets] = useState<{ n: number; live: number } | null>(null);
  const [keysAllowed, setKeysAllowed] = useState<boolean | null>(null);
  const [approvals, setApprovals] = useState<number | null>(null);
  const [mode, setMode] = useState<string | null>(null);

  useEffect(() => {
    void trpc.exchanges.list.query().then((rows) => setExchanges(rows.length)).catch(() => setExchanges(0));
    void trpc.swaps.wallets
      .query()
      .then((rows) => setWallets({ n: rows.length, live: rows.filter((w) => w.mode === 'live' && w.liveApproved).length }))
      .catch(() => setWallets({ n: 0, live: 0 }));
    void trpc.swaps.config.query().then((c) => setKeysAllowed(c.liveKeysAllowed)).catch(() => setKeysAllowed(false));
    void trpc.trading.approvals.query().then((rows) => setApprovals(rows.filter((r) => r.approved).length)).catch(() => setApprovals(0));
    void trpc.settings.get.query().then((s) => setMode(s.mode)).catch(() => setMode(null));
  }, []);

  const chips = [
    exchanges !== null ? t('realMoney.statusExchanges', { n: exchanges }) : null,
    wallets !== null ? t('realMoney.statusWallets', { n: wallets.n, live: wallets.live }) : null,
    approvals !== null ? t('realMoney.statusApprovals', { n: approvals }) : null,
    mode ? t('realMoney.statusMode', { mode }) : null,
  ].filter((c): c is string => c !== null);

  return (
    <div>
      <PageHeader title={t('realMoney.title')} subtitle={t('realMoney.subtitle')} />
      <div className="mb-4 flex flex-wrap gap-2">
        {chips.map((c) => (
          <span key={c} className="chip num">
            {c}
          </span>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Way
          title={t('realMoney.cex')}
          what={t('realMoney.cexWhat')}
          not={t('realMoney.cexNot')}
          steps={[t('realMoney.cexStep1'), t('realMoney.cexStep2'), t('realMoney.cexStep3')]}
          href="#/einstellungen?tab=boersen"
          btn={t('realMoney.cexBtn')}
          status={exchanges !== null && exchanges > 0 ? t('realMoney.statusExchanges', { n: exchanges }) : null}
        />
        <Way
          title={t('realMoney.dex')}
          what={t('realMoney.dexWhat')}
          not={t('realMoney.dexNot')}
          steps={[t('realMoney.dexStep1'), t('realMoney.dexStep2'), t('realMoney.dexStep3')]}
          href="#/traden?tab=wallet"
          btn={t('realMoney.dexBtn')}
          status={keysAllowed === null ? null : keysAllowed ? t('realMoney.dexKeysOn') : t('realMoney.dexKeysOff')}
          statusTone={keysAllowed ? 'pos' : 'warn'}
        />
        <Way
          title={t('realMoney.watch')}
          what={t('realMoney.watchWhat')}
          not={t('realMoney.watchNot')}
          steps={[t('realMoney.watchStep1'), t('realMoney.watchStep2'), t('realMoney.watchStep3')]}
          href="#/traden?tab=wallet"
          btn={t('realMoney.watchBtn')}
          status={null}
        />
      </div>

      <section className="glass mt-4 p-4">
        <p className="text-sm font-semibold">{t('realMoney.rules')}</p>
        <ul className="mt-2 space-y-1.5 text-sm" style={{ color: 'var(--color-mut)' }}>
          {(['rule1', 'rule2', 'rule3', 'rule4'] as const).map((k) => (
            <li key={k} className="flex gap-2">
              <span style={{ color: 'var(--color-blue)' }}>•</span>
              <span>{t(`realMoney.${k}`)}</span>
            </li>
          ))}
        </ul>
        {/* Direkt dorthin, wo es geschaltet wird (v2: Kill-Switch und Live-Freigabe lagen auf der Trading-Seite) */}
        <div className="mt-3 flex flex-wrap gap-2">
          <a href="#/traden?tab=positionen" className="btn px-3 py-1.5 text-xs">
            {t('realMoney.toKillSwitch')}
          </a>
          <a href="#/traden?tab=risiko" className="btn px-3 py-1.5 text-xs">
            {t('realMoney.toApproval')}
          </a>
        </div>
      </section>
    </div>
  );
}

function Way({ title, what, not, steps, href, btn, status, statusTone = 'pos' }: { title: string; what: string; not: string; steps: string[]; href: string; btn: string; status: string | null; statusTone?: 'pos' | 'warn' }) {
  return (
    <section className="glass flex flex-col p-4">
      <p className="text-base font-semibold">{title}</p>
      <p className="mt-2 text-sm leading-relaxed">{what}</p>
      <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        {not}
      </p>
      <ol className="mt-3 space-y-1.5 text-sm">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-2">
            <span className="num shrink-0" style={{ color: 'var(--color-blue)' }}>
              {i + 1}.
            </span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
      {status && (
        <p className="mt-3 text-xs" style={{ color: statusTone === 'pos' ? 'var(--color-pos)' : 'var(--color-warn)' }}>
          {status}
        </p>
      )}
      <a href={href} className="btn-primary mt-4 self-start px-4 py-2 text-sm">
        {btn}
      </a>
    </section>
  );
}
