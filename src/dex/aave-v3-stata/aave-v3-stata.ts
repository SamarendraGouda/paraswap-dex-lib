import { AsyncOrSync } from 'ts-essentials';
import {
  Token,
  Address,
  ExchangePrices,
  PoolPrices,
  AdapterExchangeParam,
  PoolLiquidity,
  Logger,
  NumberAsString,
  DexExchangeParam,
} from '../../types';
import { SwapSide, Network } from '../../constants';
import * as CALLDATA_GAS_COST from '../../calldata-gas-cost';
import { Utils, getBigIntPow, getDexKeysWithNetwork } from '../../utils';
import { Context, IDex } from '../../dex/idex';
import { IDexHelper } from '../../dex-helper/idex-helper';
import { AaveV3StataData, StataFunctions, TokenType } from './types';
import { SimpleExchange } from '../simple-exchange';
import { AaveV3StataConfig, Adapters } from './config';
import { Interface } from '@ethersproject/abi';
import { fetchTokenList } from './utils';
import { getTokenType, setTokensOnNetwork } from './tokens';
import { uint256ToBigInt } from '../../lib/decoders';
import TokenABI from '../../abi/aavev3stata/Token.json';
// import { IStaticATokenLM_ABI } from '@bgd-labs/aave-address-book';
// slimmed down version of @bgd-labs/aave-address-book
// required as version of web3-utils used is buggy
//import IStaticATokenFactory_ABI from '../../abi/aave-v3-stata/StaticATokenFactory.json';

export const TOKEN_LIST_CACHE_KEY = 'stata-token-list';
const TOKEN_LIST_TTL_SECONDS = 24 * 60 * 60; // 1 day
const TOKEN_LIST_LOCAL_TTL_SECONDS = 3 * 60 * 60; // 3h
// const RAY = BigInt(1e27);
const RAY = BigInt(`1${'0'.repeat(27)}`);

export class AaveV3Stata
  extends SimpleExchange
  implements IDex<AaveV3StataData>
{
  readonly hasConstantPriceLargeAmounts = true;

  readonly isFeeOnTransferSupported = false;

  public static dexKeysWithNetwork: { key: string; networks: Network[] }[] =
    getDexKeysWithNetwork(AaveV3StataConfig);

  logger: Logger;

  // static readonly stata = new Interface(IStaticATokenLM_ABI);
  static readonly stata = new Interface(TokenABI);

  private state: Record<string, { blockNumber: number; rate: bigint }> = {};

  constructor(
    readonly network: Network,
    readonly dexKey: string,
    readonly dexHelper: IDexHelper,
    protected config = AaveV3StataConfig[dexKey][network],
    protected adapters = Adapters[network],
  ) {
    super(dexHelper, dexKey);
    this.logger = dexHelper.getLogger(dexKey);
  }

  // Initialize pricing is called once in the start of
  // pricing service. It is intended to setup the integration
  // for pricing requests. It is optional for a DEX to
  // implement this function
  async initializePricing(blockNumber: number) {
    let cachedTokenList = await this.dexHelper.cache.getAndCacheLocally(
      this.dexKey,
      this.network,
      TOKEN_LIST_CACHE_KEY,
      TOKEN_LIST_LOCAL_TTL_SECONDS,
    );
    if (cachedTokenList !== null) {
      setTokensOnNetwork(this.network, JSON.parse(cachedTokenList));
      return;
    }

    let tokenList = await fetchTokenList(
      this.dexHelper.web3Provider,
      blockNumber,
      this.config.factoryAddress,
      this.dexHelper.multiWrapper,
    );

    await this.dexHelper.cache.setex(
      this.dexKey,
      this.network,
      TOKEN_LIST_CACHE_KEY,
      TOKEN_LIST_TTL_SECONDS,
      JSON.stringify(tokenList),
    );

    setTokensOnNetwork(this.network, tokenList);

    // init state for all tokens as empty
    tokenList.forEach(token => {
      this.state[token.address] = {
        blockNumber: 0,
        rate: 0n,
      };
    });
  }

  // Returns the list of contract adapters (name and index)
  // for a buy/sell. Return null if there are no adapters.
  getAdapters(side: SwapSide): { name: string; index: number }[] | null {
    return this.adapters[side] ? this.adapters[side] : null;
  }

  private _getPoolIdentifier(srcToken: Token, destToken: Token): string {
    return (
      this.dexKey +
      [srcToken.address.toLowerCase(), destToken.address.toLowerCase()]
        .sort((a, b) => (a > b ? 1 : -1))
        .join('_')
    );
  }

  // Returns list of pool identifiers that can be used
  // for a given swap. poolIdentifiers must be unique
  // across DEXes. It is recommended to use
  // ${dexKey}_${poolAddress} as a poolIdentifier
  async getPoolIdentifiers(
    srcToken: Token,
    destToken: Token,
    side: SwapSide,
    blockNumber: number,
  ): Promise<string[]> {
    return [this._getPoolIdentifier(srcToken, destToken)];
  }

  // Returns pool prices for amounts.
  // If limitPools is defined only pools in limitPools
  // should be used. If limitPools is undefined then
  // any pools can be used.
  async getPricesVolume(
    srcToken: Token,
    destToken: Token,
    amounts: bigint[],
    side: SwapSide,
    blockNumber: number,
    limitPools?: string[],
  ): Promise<null | ExchangePrices<AaveV3StataData>> {
    const src = getTokenType(this.network, srcToken.address);
    const dest = getTokenType(this.network, destToken.address);

    // the token itself can only swap from/to underlying and aToken, so
    // - at least one must be stata
    // - maximum one can be stata
    if (
      ![src, dest].includes(TokenType.STATA_TOKEN) ||
      (src === TokenType.STATA_TOKEN && dest === TokenType.STATA_TOKEN)
    ) {
      return null;
    }

    // on the buy side (mint, withdraw) we only support the underlying<->stata conversion, not the aUnderlying
    if (side === SwapSide.BUY && ![src, dest].includes(TokenType.UNDERLYING))
      return null;

    const stata = src === TokenType.STATA_TOKEN ? srcToken : destToken;
    const stataAddressLower = stata.address.toLowerCase();

    // following what is done on wstETH
    if (blockNumber > this.state[stataAddressLower].blockNumber) {
      const cached = await this.dexHelper.cache.get(
        this.dexKey,
        this.network,
        `state_${stataAddressLower}`,
      );
      if (cached) {
        this.state[stataAddressLower] = Utils.Parse(cached);
      } else {
        const results = await this.dexHelper.multiWrapper.tryAggregate<bigint>(
          true,
          [
            {
              target: stata.address,
              callData: AaveV3Stata.stata.encodeFunctionData('rate'),
              decodeFunction: uint256ToBigInt,
            },
          ],
          blockNumber,
        );
        this.state[stataAddressLower] = {
          blockNumber,
          rate: results[0].returnData,
        };
        this.dexHelper.cache.setex(
          this.dexKey,
          this.network,
          'state',
          60,
          Utils.Serialize(this.state[stataAddressLower]),
        );
      }
    }

    return [
      {
        prices: amounts.map(amount =>
          src === TokenType.STATA_TOKEN
            ? (amount * RAY) / this.state[stataAddressLower].rate
            : (amount * this.state[stataAddressLower].rate) / RAY,
        ),
        unit: getBigIntPow(
          (side === SwapSide.SELL ? destToken : srcToken).decimals,
        ),
        gasCost: 400_000, // 250_000 from underlying, far less from aToken
        exchange: this.dexKey,
        data: {
          srcType: src,
          destType: dest,
          exchange: destToken.address,
        },
        poolAddresses: [stataAddressLower],
      },
    ];
  }

  // Returns estimated gas cost of calldata for this DEX in multiSwap
  getCalldataGasCost(
    poolPrices: PoolPrices<AaveV3StataData>,
  ): number | number[] {
    // TODO: update if there is any payload in getAdapterParam
    return CALLDATA_GAS_COST.DEX_NO_PAYLOAD;
  }

  // Not used for V6
  getAdapterParam(): AdapterExchangeParam {
    return {
      targetExchange: '0x',
      payload: '0x',
      networkFee: '0',
    };
  }

  // Encode call data used by simpleSwap like routers
  // Used for simpleSwap & simpleBuy
  // Hint: this.buildSimpleParamWithoutWETHConversion
  // could be useful
  // async getSimpleParam(
  //   srcToken: string,
  //   destToken: string,
  //   srcAmount: string,
  //   destAmount: string,
  //   data: AaveV3StataData,
  //   side: SwapSide,
  // ): Promise<SimpleExchangeParam> {
  //   const { exchange, srcType, destType } = data;
  //   let swapData;
  //
  //   if (side === SwapSide.SELL) {
  //     if (srcType === TokenType.STATA_TOKEN) {
  //       // e.g. sell srcAmount 100 srcToken stataUSDC for destToken USDC
  //       swapData = AaveV3Stata.stata.encodeFunctionData(StataFunctions.redeem, [
  //         srcAmount,
  //         this.augustusAddress, // receiver
  //         this.augustusAddress, // owner
  //         destType === TokenType.UNDERLYING, // withdraw from aToken
  //       ]);
  //     } else {
  //       // sell srcAmount 100 srcToken USDC for destToken stataUSDC
  //       swapData = AaveV3Stata.stata.encodeFunctionData(
  //         StataFunctions.deposit,
  //         [
  //           srcAmount,
  //           this.augustusAddress, // receiver
  //           0, // referrer (noop)
  //           srcType === TokenType.UNDERLYING, // deposit to aave
  //         ],
  //       );
  //     }
  //   } else {
  //     if (srcType === TokenType.STATA_TOKEN) {
  //       // e.g. buy destAmount 100 destToken USDC for srcToken stataUSDC
  //       swapData = AaveV3Stata.stata.encodeFunctionData(
  //         StataFunctions.withdraw,
  //         [
  //           destAmount,
  //           this.augustusAddress, // receiver
  //           this.augustusAddress, // owner
  //         ],
  //       );
  //     } else {
  //       // e.g. buy destAmount 100 destToken stataUSDC for srcToken USDC
  //       swapData = AaveV3Stata.stata.encodeFunctionData(StataFunctions.mint, [
  //         destAmount,
  //         this.augustusAddress,
  //       ]);
  //     }
  //   }
  //
  //   return this.buildSimpleParamWithoutWETHConversion(
  //     srcToken,
  //     srcAmount,
  //     destToken,
  //     destAmount,
  //     swapData,
  //     exchange,
  //   );
  // }

  getDexParam(
    srcToken: Address,
    destToken: Address,
    srcAmount: NumberAsString,
    destAmount: NumberAsString,
    recipient: Address,
    data: AaveV3StataData,
    side: SwapSide,
    _: Context,
    executorAddress: Address,
  ): DexExchangeParam {
    const { exchange, srcType, destType } = data;
    let swapData;

    if (side === SwapSide.SELL) {
      if (srcType === TokenType.STATA_TOKEN) {
        // e.g. sell srcAmount 100 srcToken stataUSDC for destToken USDC
        swapData = AaveV3Stata.stata.encodeFunctionData(StataFunctions.redeem, [
          srcAmount,
          recipient, // receiver
          executorAddress, // owner
          destType === TokenType.UNDERLYING, // withdraw from aToken
        ]);
      } else {
        // sell srcAmount 100 srcToken USDC for destToken stataUSDC
        swapData = AaveV3Stata.stata.encodeFunctionData(
          StataFunctions.deposit,
          [
            srcAmount,
            recipient, // receiver
            0, // referrer (noop)
            srcType === TokenType.UNDERLYING, // deposit to aave
          ],
        );
      }
    } else {
      if (srcType === TokenType.STATA_TOKEN) {
        // e.g. buy destAmount 100 destToken USDC for srcToken stataUSDC
        swapData = AaveV3Stata.stata.encodeFunctionData(
          StataFunctions.withdraw,
          [
            destAmount,
            recipient, // receiver
            executorAddress, // owner
          ],
        );
      } else {
        // e.g. buy destAmount 100 destToken stataUSDC for srcToken USDC
        swapData = AaveV3Stata.stata.encodeFunctionData(StataFunctions.mint, [
          destAmount,
          recipient,
        ]);
      }
    }

    return {
      needWrapNative: this.needWrapNative,
      dexFuncHasRecipient: true,
      exchangeData: swapData,
      targetExchange: exchange,
      returnAmountPos: undefined,
    };
  }

  // This is called once before getTopPoolsForToken is
  // called for multiple tokens. This can be helpful to
  // update common state required for calculating
  // getTopPoolsForToken. It is optional for a DEX
  // to implement this
  async updatePoolState(): Promise<void> {
    // TODO: complete me!
  }

  // Returns list of top pools based on liquidity. Max
  // limit number pools should be returned.
  async getTopPoolsForToken(
    tokenAddress: Address,
    limit: number,
  ): Promise<PoolLiquidity[]> {
    //TODO: complete me!
    return [];
  }

  // This is optional function in case if your implementation has acquired any resources
  // you need to release for graceful shutdown. For example, it may be any interval timer
  releaseResources(): AsyncOrSync<void> {
    // TODO: complete me!
  }
}
