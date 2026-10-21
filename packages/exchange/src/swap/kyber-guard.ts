import { decodeFunctionData, parseAbi } from 'viem';

/**
 * Prüft die von KyberSwap gebauten Aufrufdaten VOR dem Senden
 * (Sicherheitsprüfung 2026-10-21): Bisher war nur die Router-Adresse geprüft
 * — eine manipulierte Antwort hätte Empfänger, Mindestmenge oder Gebühren
 * unbemerkt ändern können. Jetzt wird die Calldata des MetaAggregationRouterV2
 * dekodiert und muss genau zum bestätigten Angebot passen:
 *   Empfänger = eigene Wallet, Tokens = Angebot, Menge = Angebot,
 *   Mindestmenge ≥ unsere, keine Fremdgebühren, mitgeschickter ETH-Betrag
 *   = Kaufbetrag (Token-Verkauf: 0), keine Teilausführung. Unbekannte Funktion
 *   → verweigert. Offen (dokumentiert): `srcReceivers`/Executor sind nicht
 *   prüfbar — ein Diebstahl dort bleibt durch die Mindestmenge (bestätigt +
 *   unabhängige Preisprüfung im Swap-Service) begrenzt.
 */

const DESC =
  '(address srcToken, address dstToken, address[] srcReceivers, uint256[] srcAmounts, address[] feeReceivers, uint256[] feeAmounts, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags, bytes permit)';

export const KYBER_ROUTER_ABI = parseAbi([
  `function swap((address callTarget, address approveTarget, bytes targetData, ${DESC} desc, bytes clientData) execution) payable returns (uint256 returnAmount, uint256 gasUsed)`,
  `function swapSimpleMode(address caller, ${DESC} desc, bytes executorData, bytes clientData) returns (uint256 returnAmount, uint256 gasUsed)`,
]);

type Desc = {
  srcToken: string;
  dstToken: string;
  srcReceivers: readonly string[];
  srcAmounts: readonly bigint[];
  feeReceivers: readonly string[];
  feeAmounts: readonly bigint[];
  dstReceiver: string;
  amount: bigint;
  minReturnAmount: bigint;
  flags: bigint;
  permit: string;
};

/** MetaAggregationRouterV2: Teilausführung erlaubt (Mindestmenge nur noch anteilig) — nie für uns. */
const FLAG_PARTIAL_FILL = 0x01n;

/** Dekodiert die Swap-Beschreibung; wirft bei unbekannter Funktion. */
export function decodeKyberDesc(data: `0x${string}`): Desc {
  return decodeKyber(data).desc;
}

function decodeKyber(data: `0x${string}`): { fn: 'swap' | 'swapSimpleMode'; desc: Desc } {
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: KYBER_ROUTER_ABI, data });
  } catch {
    throw new Error('Swap verweigert: KyberSwap-Aufrufdaten nicht lesbar (unbekannte Funktion).');
  }
  if (decoded.functionName === 'swap') return { fn: 'swap', desc: (decoded.args[0] as { desc: Desc }).desc };
  return { fn: 'swapSimpleMode', desc: decoded.args[1] as Desc };
}

const lc = (a: string) => a.toLowerCase();

export function assertKyberSwap(
  data: `0x${string}`,
  value: bigint,
  expect: { owner: string; srcToken: string; dstToken: string; amountIn: bigint; minOut: bigint; nativeIn: boolean },
): void {
  const { fn, desc: d } = decodeKyber(data);
  const deny = (why: string): never => {
    throw new Error(`Swap verweigert: ${why}`);
  };
  if (lc(d.dstReceiver) !== lc(expect.owner)) deny('Empfänger ist nicht die eigene Wallet.');
  if (lc(d.srcToken) !== lc(expect.srcToken) || lc(d.dstToken) !== lc(expect.dstToken)) deny('Tokens passen nicht zum bestätigten Angebot.');
  if (d.amount !== expect.amountIn) deny('Menge passt nicht zum bestätigten Angebot.');
  if (d.minReturnAmount < expect.minOut) deny('Mindestmenge niedriger als bestätigt.');
  if (d.srcAmounts.reduce((s, x) => s + x, 0n) > d.amount) deny('Aufteilung übersteigt die Menge.');
  if (d.feeAmounts.some((f) => f > 0n) || d.feeReceivers.length > d.feeAmounts.length) deny('Fremdgebühren in der Route.');
  if (value !== (expect.nativeIn ? expect.amountIn : 0n)) deny('mitgeschickter Betrag passt nicht zum Angebot.');
  // swapSimpleMode nimmt kein natives ETH an — würde nur Gas kosten
  if (fn === 'swapSimpleMode' && expect.nativeIn) deny('Route kann natives Guthaben nicht annehmen.');
  if ((d.flags & FLAG_PARTIAL_FILL) !== 0n) deny('Teilausführung in der Route (Mindestmenge nur anteilig).');
}
