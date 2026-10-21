import { encodeFunctionData } from 'viem';
import { KYBER_ROUTER_ABI } from '../kyber-guard.js';

/** NUR für Tests: KyberSwap-`swap(...)`-Calldata mit wählbarer Swap-Beschreibung. */
export function kyberSwapCalldata(desc: {
  srcToken: string;
  dstToken: string;
  dstReceiver: string;
  amount: bigint;
  minReturnAmount: bigint;
  feeReceivers?: string[];
  feeAmounts?: bigint[];
}): `0x${string}` {
  const executor = '0x1111111111111111111111111111111111111111';
  return encodeFunctionData({
    abi: KYBER_ROUTER_ABI,
    functionName: 'swap',
    args: [
      {
        callTarget: executor,
        approveTarget: '0x0000000000000000000000000000000000000000',
        targetData: '0x1234',
        desc: {
          srcToken: desc.srcToken as `0x${string}`,
          dstToken: desc.dstToken as `0x${string}`,
          srcReceivers: [executor],
          srcAmounts: [desc.amount],
          feeReceivers: (desc.feeReceivers ?? []) as `0x${string}`[],
          feeAmounts: desc.feeAmounts ?? [],
          dstReceiver: desc.dstReceiver as `0x${string}`,
          amount: desc.amount,
          minReturnAmount: desc.minReturnAmount,
          flags: 0n,
          permit: '0x',
        },
        clientData: '0x',
      },
    ],
  });
}
