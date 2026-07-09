import { describe, expect, it } from 'vitest';
import { favoriteTerms, groupNewsByFavorites, titleMatchesFavorite, tokenize } from './newsMatch.js';

/** Echte Favoriten-Formen aus product.favorites (Ticker + Name). */
const BTC = { ticker: 'BTC', name: 'Bitcoin' };
const ETH = { ticker: 'ETH', name: 'Ethereum' };
const KO = { ticker: 'KO', name: 'Coca-Cola Company' };
const BCH = { ticker: 'BCH', name: 'Bitcoin Cash' };
const ATT = { ticker: 'T', name: 'AT&T Inc' };

describe('tokenize', () => {
  it('zerlegt case-insensitiv an Nicht-Wortzeichen (Bindestrich, Apostroph, &)', () => {
    expect(tokenize("Ethereum's newest nonprofit")).toEqual(['ethereum', 's', 'newest', 'nonprofit']);
    expect(tokenize('Coca-Cola & AT&T')).toEqual(['coca', 'cola', 'at', 't']);
  });
});

describe('favoriteTerms', () => {
  it('liefert Ticker UND signifikante Namensteile', () => {
    expect(favoriteTerms(BTC)).toEqual([['btc'], ['bitcoin']]);
  });

  it('entfernt Rechtsform-Zusätze aus Namen (Company/Inc/…)', () => {
    expect(favoriteTerms(KO)).toEqual([['ko'], ['coca', 'cola']]);
  });

  it('verwirft Einzel-Token-Begriffe unter 2 Zeichen (Ticker „T"), behält aber die Namensfolge', () => {
    expect(favoriteTerms(ATT)).toEqual([['at', 't']]);
  });

  it('dedupliziert, wenn Name und Ticker identisch tokenisieren', () => {
    expect(favoriteTerms({ ticker: 'BTC', name: 'BTC' })).toEqual([['btc']]);
  });
});

describe('titleMatchesFavorite', () => {
  it('trifft über den Ticker als ganzes Wort (case-insensitiv)', () => {
    expect(titleMatchesFavorite('BTC price passes $63K after Trump comment', BTC)).toBe(true);
    expect(titleMatchesFavorite('btc holds support', BTC)).toBe(true);
  });

  it('trifft über den Asset-Namen (BTC ↔ „Bitcoin")', () => {
    expect(titleMatchesFavorite('Can Bitcoin hold $62K ahead of options expiry?', BTC)).toBe(true);
  });

  it('trifft NICHT als Substring mitten im Wort („somETHing" ≠ ETH)', () => {
    expect(titleMatchesFavorite('Something is brewing in the market', ETH)).toBe(false);
    expect(titleMatchesFavorite('Knockout quarter for retailers', KO)).toBe(false);
  });

  it('trifft Wortgrenzen trotz Satzzeichen („Ethereum\'s" → ethereum)', () => {
    expect(titleMatchesFavorite("Ethereum's newest nonprofit wants to guide Wall Street", ETH)).toBe(true);
  });

  it('mehrwortiger Name nur als ganze Folge — „Cash" allein trifft „Bitcoin Cash" nicht', () => {
    expect(titleMatchesFavorite('Bitcoin Cash rallies 12%', BCH)).toBe(true);
    expect(titleMatchesFavorite('Cash is flowing out of funds', BCH)).toBe(false);
  });

  it('Bindestrich-Namen treffen über die Token-Folge („Coca-Cola raises dividend")', () => {
    expect(titleMatchesFavorite('Coca-Cola raises dividend for 63rd year', KO)).toBe(true);
  });

  it('mehrteilige Ticker-Folge trifft („AT&T beats estimates"), obwohl „T" allein tabu ist', () => {
    expect(titleMatchesFavorite('AT&T beats estimates', ATT)).toBe(true);
    expect(titleMatchesFavorite('T-Mobile expands network', ATT)).toBe(false);
  });
});

describe('groupNewsByFavorites', () => {
  const news = [
    { title: 'Can Bitcoin hold $62K ahead of options expiry?' }, // → BTC
    { title: 'White House says it received no nominees' }, // → rest
    { title: "Ethereum's newest nonprofit wants to guide Wall Street" }, // → ETH
    { title: 'BTC price passes $63K after comment' }, // → BTC
    { title: 'Bitcoin Cash flips a resistance level' }, // → BTC (Name) UND BCH (Folge)
    { title: 'Coca-Cola raises dividend' }, // → KO
  ];

  it('gruppiert je Favorit mit korrekten Zählern, meistgenannte zuerst', () => {
    const { groups } = groupNewsByFavorites(news, [KO, ETH, BTC]);
    expect(groups.map((g) => [g.ticker, g.items.length])).toEqual([
      ['BTC', 3],
      ['ETH', 1],
      ['KO', 1],
    ]);
  });

  it('legt den Rest unverändert unter „Alle News" ab', () => {
    const { rest } = groupNewsByFavorites(news, [KO, ETH, BTC]);
    // „Bitcoin Cash flips …" trifft BTC über den Namen „Bitcoin" → nur eine Rest-Meldung.
    expect(rest.map((n) => n.title)).toEqual(['White House says it received no nominees']);
  });

  it('eine Schlagzeile darf mehrere Favoriten treffen (in jeder Gruppe sichtbar)', () => {
    const { groups, rest } = groupNewsByFavorites(news, [BTC, BCH]);
    const btc = groups.find((g) => g.ticker === 'BTC')!;
    const bch = groups.find((g) => g.ticker === 'BCH')!;
    expect(btc.items.some((n) => n.title.startsWith('Bitcoin Cash'))).toBe(true);
    expect(bch.items.map((n) => n.title)).toEqual(['Bitcoin Cash flips a resistance level']);
    expect(rest).toHaveLength(3); // White House, Ethereum, Coca-Cola
  });

  it('ohne Favoriten: keine Gruppen, alles im Rest', () => {
    const { groups, rest } = groupNewsByFavorites(news, []);
    expect(groups).toEqual([]);
    expect(rest).toHaveLength(news.length);
  });

  it('doppelte Favoriten (gleicher Ticker) erzeugen nur eine Gruppe', () => {
    const { groups } = groupNewsByFavorites(news, [BTC, { ticker: 'btc', name: 'Bitcoin' }]);
    expect(groups.filter((g) => g.ticker.toUpperCase() === 'BTC')).toHaveLength(1);
  });
});
