/**
 * Favoriten-News-Abgleich (rein & testbar): ordnet echte RSS-Schlagzeilen den
 * ★-Favoriten zu — Grundlage der Magazin-Sektion „Für meine Märkte".
 *
 * WARUM wortweise statt Substring: „ETH" würde sonst mitten in „somETHing"
 * treffen. Titel und Suchbegriffe werden deshalb in Wort-Tokens zerlegt und
 * nur ZUSAMMENHÄNGENDE Token-Folgen verglichen. Ein Favorit trifft über
 * seinen Ticker ODER seinen Asset-Namen (BTC ↔ „Bitcoin"); Rechtsform-Zusätze
 * wie „Company" in „Coca-Cola Company" identifizieren keinen Markt und werden
 * vor dem Abgleich entfernt.
 */

export type NewsFavorite = { ticker: string; name: string };

export type FavoriteNewsGroup<N> = { ticker: string; name: string; items: N[] };

export type GroupedNews<N> = { groups: FavoriteNewsGroup<N>[]; rest: N[] };

/** Rechtsform-/Füllwörter in Asset-Namen — sie sagen nichts über den Markt aus. */
const NAME_STOPWORDS = new Set([
  'inc',
  'corp',
  'corporation',
  'company',
  'co',
  'ltd',
  'plc',
  'se',
  'ag',
  'nv',
  'sa',
  'the',
  'and',
  'of',
  'class',
  'shares',
  'etf',
  'trust',
  'fund',
  'index',
  'group',
  'holdings',
  'holding',
  'token',
  'coin',
  'usd',
  'usdt',
  'usdc',
]);

/** Zerlegt Text in kleingeschriebene Wort-Tokens (Unicode-Buchstaben/Ziffern). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
}

/** Kommt `seq` als zusammenhängende Token-Folge in `hay` vor? */
function containsSequence(hay: string[], seq: string[]): boolean {
  if (seq.length === 0 || seq.length > hay.length) return false;
  for (let i = 0; i <= hay.length - seq.length; i++) {
    let hit = true;
    for (let j = 0; j < seq.length; j++) {
      if (hay[i + j] !== seq[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/**
 * Suchbegriffe eines Favoriten als Token-Folgen: Ticker UND signifikante
 * Namensteile. Zwei bewusste Schutzregeln gegen falsche Treffer:
 * - Einzel-Token-Begriffe brauchen ≥ 2 Zeichen (ein einzelnes „T" träfe
 *   zufällige Wörter — „AT&T" trifft trotzdem über die Folge „at t").
 * - Mehrwortige Namen zählen nur als GANZE Folge: „Bitcoin Cash" soll nicht
 *   jede „Cash"-Schlagzeile einsammeln.
 */
export function favoriteTerms(fav: NewsFavorite): string[][] {
  const terms: string[][] = [];
  const push = (seq: string[]) => {
    if (seq.length === 0) return;
    if (seq.length === 1 && seq[0]!.length < 2) return;
    // Duplikate vermeiden (z. B. Name === Ticker)
    if (terms.some((t) => t.length === seq.length && t.every((w, i) => w === seq[i]))) return;
    terms.push(seq);
  };
  push(tokenize(fav.ticker));
  push(tokenize(fav.name).filter((w) => !NAME_STOPWORDS.has(w)));
  return terms;
}

/** Trifft der Titel diesen Favoriten (Ticker ODER Name, case-insensitiv, wortweise)? */
export function titleMatchesFavorite(title: string, fav: NewsFavorite): boolean {
  const hay = tokenize(title);
  return favoriteTerms(fav).some((seq) => containsSequence(hay, seq));
}

/**
 * Gruppiert News je Favorit und liefert den Rest (Original-Reihenfolge)
 * separat zurück. Nur Favoriten MIT Treffern erscheinen — meistgenannte
 * zuerst, damit das Wichtigste oben steht. Eine Schlagzeile darf mehrere
 * Favoriten treffen und erscheint dann in jeder betroffenen Gruppe (WARUM:
 * „Bitcoin Cash flippt ETH" ist für BEIDE Märkte relevant).
 */
export function groupNewsByFavorites<N extends { title: string }>(
  news: N[],
  favorites: NewsFavorite[],
): GroupedNews<N> {
  // Doppelte Favoriten (gleicher Ticker) nur einmal gruppieren.
  const unique: NewsFavorite[] = [];
  const seen = new Set<string>();
  for (const f of favorites) {
    const key = f.ticker.toUpperCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(f);
    }
  }

  const termsPerFav = unique.map((f) => favoriteTerms(f));
  const groups: FavoriteNewsGroup<N>[] = unique.map((f) => ({ ticker: f.ticker, name: f.name, items: [] }));
  const rest: N[] = [];

  for (const item of news) {
    const hay = tokenize(item.title);
    let matched = false;
    for (let i = 0; i < unique.length; i++) {
      if (termsPerFav[i]!.some((seq) => containsSequence(hay, seq))) {
        groups[i]!.items.push(item);
        matched = true;
      }
    }
    if (!matched) rest.push(item);
  }

  return {
    groups: groups
      .filter((g) => g.items.length > 0)
      .sort((a, b) => b.items.length - a.items.length || a.ticker.localeCompare(b.ticker)),
    rest,
  };
}
