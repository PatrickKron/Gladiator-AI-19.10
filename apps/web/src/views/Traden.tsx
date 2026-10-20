import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { accountForHash, hashForAccount, rememberAccount, rememberedAccount, TRADE_ACCOUNTS, type TradeAccount } from '../lib/trade-account.js';
import { DemoKonto, Trading } from './Trading.js';
import { WalletTrading } from './WalletTrading.js';

/**
 * Traden (UI-Welle 3): EINE Seite mit Konto-Schalter statt drei verstreuter
 * Seiten. Die Konten bleiben technisch strikt getrennt (eigene Router/Tabellen) —
 * der Schalter wechselt nur die Ansicht. Alte Links (#/demo, #/trading,
 * #/wallet) leiten hierher weiter.
 */

const ACCOUNT_STYLE: Record<TradeAccount, { active: string; color: string }> = {
  demo: { active: 'rgba(225,78,207,0.16)', color: 'var(--color-magenta)' },
  agent: { active: 'rgba(79,209,255,0.14)', color: 'var(--color-cyan)' },
  wallet: { active: 'rgba(52,211,153,0.14)', color: 'var(--color-pos)' },
};

export function Traden() {
  const { t } = useTranslation();
  const account = accountForHash(window.location.hash, rememberedAccount());

  useEffect(() => {
    rememberAccount(account);
  }, [account]);

  return (
    <div>
      <div className="reveal mb-5 flex flex-wrap items-center gap-3" style={{ '--stagger': 0 } as React.CSSProperties}>
        <span className="label">{t('trade.accountLabel')}</span>
        <div className="flex flex-wrap rounded-[0.625rem] border p-1" style={{ borderColor: 'var(--color-line)' }} role="tablist" aria-label={t('trade.accountLabel')}>
          {TRADE_ACCOUNTS.map((a) => (
            <a
              key={a}
              href={hashForAccount(a)}
              role="tab"
              aria-selected={a === account}
              className="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
              style={a === account ? { background: ACCOUNT_STYLE[a].active, color: ACCOUNT_STYLE[a].color } : { color: 'var(--color-mut)' }}
              title={t(`trade.hint_${a}`)}
            >
              {t(`trade.account_${a}`)}
            </a>
          ))}
        </div>
        <span className="text-xs" style={{ color: 'var(--color-mut)' }}>
          {t(`trade.hint_${account}`)}
        </span>
      </div>
      {account === 'demo' && <DemoKonto key="demo" />}
      {account === 'agent' && <Trading key="agent" />}
      {account === 'wallet' && <WalletTrading key="wallet" />}
    </div>
  );
}
