import { afterEach, describe, expect, it } from 'vitest';
import {
  escapeHtml,
  formatKillSwitchAlert,
  formatSignalAlert,
  telegramConfigured,
  type SignalAlertData,
} from './telegram.js';

/** Telegram-Ausspielung (11_ Phase 7): pure Formatter, TDD. HTML-parse_mode. */

const signal: SignalAlertData = {
  symbol: 'BTC/USDT',
  timeframe: '1h',
  direction: 'long',
  setupType: 'swing',
  source: 'engine',
  entry: 62000,
  stopLoss: 60500,
  takeProfits: [64000, 66000],
  score: 8.5,
  portfolioVote: 'confirm',
  portfolioConfidence: 0.72,
  disabledAgents: ['makro', 'shadow'],
};

describe('formatSignalAlert', () => {
  it('enthält Richtung, Symbol, Level, Score und Schwarm-Urteil', () => {
    const text = formatSignalAlert(signal);
    expect(text).toMatch(/LONG/);
    expect(text).toMatch(/BTC\/USDT/);
    expect(text).toMatch(/62.?000/);
    expect(text).toMatch(/60.?500/);
    expect(text).toMatch(/8[.,]5/);
    expect(text).toMatch(/confirm/i);
    expect(text).toMatch(/72\s?%/);
  });

  it('nennt deaktivierte Agenten ehrlich', () => {
    expect(formatSignalAlert(signal)).toMatch(/makro/i);
  });

  it('reject-Urteil wird klar markiert', () => {
    const text = formatSignalAlert({ ...signal, portfolioVote: 'reject', portfolioConfidence: 0.9 });
    expect(text).toMatch(/reject/i);
  });
});

describe('formatKillSwitchAlert', () => {
  it('AN: unmissverständliche Warnung', () => {
    const text = formatKillSwitchAlert(true, 'patrick@example.com');
    expect(text).toMatch(/AKTIVIERT/);
    expect(text).toMatch(/keine neuen Orders/i);
  });
  it('AUS: Entwarnung mit Hinweis auf normales Gate', () => {
    const text = formatKillSwitchAlert(false, 'patrick@example.com');
    expect(text).toMatch(/deaktiviert/i);
  });
});

describe('escapeHtml (Telegram-HTML-Injection verhindern)', () => {
  it('escapt <, >, &', () => {
    expect(escapeHtml('<b>x</b> & y')).toBe('&lt;b&gt;x&lt;/b&gt; &amp; y');
  });
});

describe('telegramConfigured', () => {
  const OLD = { ...process.env };
  afterEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = OLD.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_CHAT_ID = OLD.TELEGRAM_CHAT_ID;
  });

  it('ohne Token/Chat-ID → false (ehrlich deaktiviert, kein Fake-Versand)', () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    expect(telegramConfigured()).toBe(false);
  });

  it('der ALTE kompromittierte Token (7544725601:…) wird VERWEIGERT', () => {
    process.env.TELEGRAM_BOT_TOKEN = '7544725601:AAFxyz';
    process.env.TELEGRAM_CHAT_ID = '123';
    expect(telegramConfigured()).toBe(false);
  });

  it('mit neuem Token + Chat-ID → true', () => {
    process.env.TELEGRAM_BOT_TOKEN = '8123456789:AAHneu';
    process.env.TELEGRAM_CHAT_ID = '123';
    expect(telegramConfigured()).toBe(true);
  });
});
