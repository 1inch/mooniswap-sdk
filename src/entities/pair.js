import { Price } from './fractions/price';
import { TokenAmount } from './fractions/tokenAmount';
import invariant from 'tiny-invariant';
import JSBI from 'jsbi';
import { _1000, _997, FIVE, MINIMUM_LIQUIDITY, ONE, ZERO } from '../constants';
import { parseBigintIsh, sqrt } from '../utils';
import { InsufficientInputAmountError, InsufficientReservesError } from '../errors';
import { Token } from './token';
export class Pair {
    // need to provide already sorted tokens
    constructor(tokenAmountA, tokenAmountB, poolAddress) {
        this.liquidityToken = new Token(tokenAmountA.token.chainId, poolAddress, 18, 'MOON-V1-' + tokenAmountA.token.symbol + '-' + tokenAmountB.token.symbol, 'Mooniswap V1 (' + tokenAmountA.token.symbol + '-' + tokenAmountB.token.symbol + ')');
        this.tokenAmounts = [tokenAmountA, tokenAmountB];
        this.poolAddress = poolAddress;
    }
    /**
     * Returns true if the token is either token0 or token1
     * @param token to check
     */
    involvesToken(token) {
        return token.equals(this.token0) || token.equals(this.token1);
    }
    /**
     * Returns the current mid price of the pair in terms of token0, i.e. the ratio of reserve1 to reserve0
     */
    get token0Price() {
        return new Price(this.token0, this.token1, this.tokenAmounts[0].raw, this.tokenAmounts[1].raw);
    }
    /**
     * Returns the current mid price of the pair in terms of token1, i.e. the ratio of reserve0 to reserve1
     */
    get token1Price() {
        return new Price(this.token1, this.token0, this.tokenAmounts[1].raw, this.tokenAmounts[0].raw);
    }
    /**
     * Return the price of the given token in terms of the other token in the pair.
     * @param token token to return price of
     */
    priceOf(token) {
        invariant(this.involvesToken(token), 'TOKEN');
        return token.equals(this.token0) ? this.token0Price : this.token1Price;
    }
    /**
     * Returns the chain ID of the tokens in the pair.
     */
    get chainId() {
        return this.token0.chainId;
    }
    get token0() {
        return this.tokenAmounts[0].token;
    }
    get token1() {
        return this.tokenAmounts[1].token;
    }
    get reserve0() {
        return this.tokenAmounts[0];
    }
    get reserve1() {
        return this.tokenAmounts[1];
    }
    reserveOf(token) {
        invariant(this.involvesToken(token), 'TOKEN');
        return token.equals(this.token0) ? this.reserve0 : this.reserve1;
    }
    // todo: add virtual balances
    getOutputAmount(inputAmount) {
        invariant(this.involvesToken(inputAmount.token), 'TOKEN');
        if (JSBI.equal(this.reserve0.raw, ZERO) || JSBI.equal(this.reserve1.raw, ZERO)) {
            throw new InsufficientReservesError();
        }
        const inputReserve = this.reserveOf(inputAmount.token);
        const outputReserve = this.reserveOf(inputAmount.token.equals(this.token0) ? this.token1 : this.token0);
        const inputAmountWithFee = JSBI.multiply(inputAmount.raw, _997);
        const numerator = JSBI.multiply(inputAmountWithFee, outputReserve.raw);
        const denominator = JSBI.add(JSBI.multiply(inputReserve.raw, _1000), inputAmountWithFee);
        const outputAmount = new TokenAmount(inputAmount.token.equals(this.token0) ? this.token1 : this.token0, JSBI.divide(numerator, denominator));
        if (JSBI.equal(outputAmount.raw, ZERO)) {
            throw new InsufficientInputAmountError();
        }
        return [outputAmount, new Pair(inputReserve.add(inputAmount), outputReserve.subtract(outputAmount), this.poolAddress)];
    }
    // todo: add virtual balances
    getInputAmount(outputAmount) {
        invariant(this.involvesToken(outputAmount.token), 'TOKEN');
        if (JSBI.equal(this.reserve0.raw, ZERO) ||
            JSBI.equal(this.reserve1.raw, ZERO) ||
            JSBI.greaterThanOrEqual(outputAmount.raw, this.reserveOf(outputAmount.token).raw)) {
            throw new InsufficientReservesError();
        }
        const outputReserve = this.reserveOf(outputAmount.token);
        const inputReserve = this.reserveOf(outputAmount.token.equals(this.token0) ? this.token1 : this.token0);
        const numerator = JSBI.multiply(JSBI.multiply(inputReserve.raw, outputAmount.raw), _1000);
        const denominator = JSBI.multiply(JSBI.subtract(outputReserve.raw, outputAmount.raw), _997);
        const inputAmount = new TokenAmount(outputAmount.token.equals(this.token0) ? this.token1 : this.token0, JSBI.add(JSBI.divide(numerator, denominator), ONE));
        return [inputAmount, new Pair(inputReserve.add(inputAmount), outputReserve.subtract(outputAmount), this.poolAddress)];
    }
    getLiquidityMinted(totalSupply, tokenAmountA, tokenAmountB) {
        invariant(totalSupply.token.equals(this.liquidityToken), 'LIQUIDITY');
        const tokenAmounts = [tokenAmountA, tokenAmountB];
        invariant(tokenAmounts[0].token.equals(this.token0) && tokenAmounts[1].token.equals(this.token1), 'TOKEN');
        let liquidity;
        if (JSBI.equal(totalSupply.raw, ZERO)) {
            liquidity = JSBI.subtract(sqrt(JSBI.multiply(tokenAmounts[0].raw, tokenAmounts[1].raw)), MINIMUM_LIQUIDITY);
        }
        else {
            const amount0 = JSBI.divide(JSBI.multiply(tokenAmounts[0].raw, totalSupply.raw), this.reserve0.raw);
            const amount1 = JSBI.divide(JSBI.multiply(tokenAmounts[1].raw, totalSupply.raw), this.reserve1.raw);
            liquidity = JSBI.lessThanOrEqual(amount0, amount1) ? amount0 : amount1;
        }
        if (!JSBI.greaterThan(liquidity, ZERO)) {
            throw new InsufficientInputAmountError();
        }
        return new TokenAmount(this.liquidityToken, liquidity);
    }
    getLiquidityValue(token, totalSupply, liquidity, feeOn = false, kLast) {
        invariant(this.involvesToken(token), 'TOKEN');
        invariant(totalSupply.token.equals(this.liquidityToken), 'TOTAL_SUPPLY');
        invariant(liquidity.token.equals(this.liquidityToken), 'LIQUIDITY');
        invariant(JSBI.lessThanOrEqual(liquidity.raw, totalSupply.raw), 'LIQUIDITY');
        let totalSupplyAdjusted;
        if (!feeOn) {
            totalSupplyAdjusted = totalSupply;
        }
        else {
            invariant(!!kLast, 'K_LAST');
            const kLastParsed = parseBigintIsh(kLast);
            if (!JSBI.equal(kLastParsed, ZERO)) {
                const rootK = sqrt(JSBI.multiply(this.reserve0.raw, this.reserve1.raw));
                const rootKLast = sqrt(kLastParsed);
                if (JSBI.greaterThan(rootK, rootKLast)) {
                    const numerator = JSBI.multiply(totalSupply.raw, JSBI.subtract(rootK, rootKLast));
                    const denominator = JSBI.add(JSBI.multiply(rootK, FIVE), rootKLast);
                    const feeLiquidity = JSBI.divide(numerator, denominator);
                    totalSupplyAdjusted = totalSupply.add(new TokenAmount(this.liquidityToken, feeLiquidity));
                }
                else {
                    totalSupplyAdjusted = totalSupply;
                }
            }
            else {
                totalSupplyAdjusted = totalSupply;
            }
        }
        return new TokenAmount(token, JSBI.divide(JSBI.multiply(liquidity.raw, this.reserveOf(token).raw), totalSupplyAdjusted.raw));
    }
}
//# sourceMappingURL=pair.js.map