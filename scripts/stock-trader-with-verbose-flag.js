// To get full autocomplete in any Bitburner script, add this JSDoc comment
// above your main function. It tells VS Code to use the NS type definitions.

let hasWseAcct = false;
let hasTixApi = false;
let has4SData = false;
let verbose = false;

/**
 * @type {Stock[]} 
 */
let stockObjects

/** @type {StockResult[]} */
let ownedStocks = ([]);

const BUFFER = 0.6;



/** @type {import("NetscriptDefinitions").Player} */
let player;




export class Stock {
    /**
     * @param {string} sym
     * @param {import("NetscriptDefinitions").NS} ns
     */
    constructor(sym, ns) {
        this.sym = sym;
        this.ns = ns;
    }

    get symbol() { 
        return this.sym;
    }

    get forecast() {
        return this.ns.stock.getForecast(this.sym);
    }

    get volatility() {
        return this.ns.stock.getVolatility(this.sym);
    }

    get maxSharesAvailable() {
        return this.ns.stock.getMaxShares(this.sym);
    }

    get ownedLongShares() {
        let resultRow = new StockResult(this.ns, this);
        return resultRow.ownedLongShares;
    }

    get ownedShortShares() {
        let resultRow = new StockResult(this.ns, this);
        return resultRow.ownedShortShares;
    }

    /**
     * @param {Number} shares number of shares to be purchased
     * @returns price at which each stock was purchased at
     */
    buy(shares) {
        return this.ns.stock.buyStock(this.sym, shares);
    }
    /**
     * @param {Number} shares number of short shares to be purchased
     * @returns price at which each short stock was purchased at
     */
    buyShort(shares) {
        return this.ns.stock.buyShort(this.sym, shares);
    }

    /**
     * @param {Number} shares number of shares to be sold
     * @returns price at which each stock was sold for
    */
    sell(shares) {
        return this.ns.stock.sellStock(this.sym, shares);
    }

    /**
     * @param {Number} shares number of short shares to be sold
     * @returns price at which each short stock was sold at
     */
    sellShort(shares) {
        return this.ns.stock.sellShort(this.sym, shares);
    }

}

export class StockResult extends Stock {

    /**
     *  @type {number[]} 
     * The first element in the returned array is the number of shares the player owns of the stock in the Long position. 
     * The second element in the array is the average price of the player’s shares in the Long position.
     * The third element in the array is the number of shares the player owns of the stock in the Short position. 
     * The fourth element in the array is the average price of the player’s Short position.
     * All elements in the returned array are numeric.
     */
    resultArray = [];

    /**
     * @param {import("NetscriptDefinitions").NS} ns
     * @param {Stock} stock stock we're representing the results of
    */
    constructor(ns, stock) {
        super(stock.sym, ns);
        this.resultArray = ns.stock.getPosition(stock.sym);
        this.ns = ns;
        // const [sharesLong, avgLongPrice, sharesShort, avgShortPrice] = ns.stock.getPosition("ECP");
    }

    get ownedLongShares() {
        return this.resultArray[0];
    }

    get ownedShortShares() {
        return this.resultArray[2];
    }

    get averageLongPrice() {
        return this.resultArray[1];
    }

    get averageShortPrice() {
        return this.resultArray[3];
    }
}


/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @returns a dollar amount that is deducted from the wallet, allocated for purchasing stocks
 */
export function calcBuffer(ns) {
    /** @type {Number} */
    const currentMoney = player.money;

    // calculate the proportion of money using BUFFER    
    const allocatedFunds = currentMoney.valueOf() * BUFFER;

    if (verbose) ns.print(`Allocated $${allocatedFunds} for stocks.`);
    return allocatedFunds;
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 */
export function init(ns) {
    // Initialize: Buy WSE Account (200m), TIX API Access (5b), and 4S Market Data/API (1b + 25b).
    if (!hasWseAcct) {
        ns.stock.purchaseWseAccount();
        hasWseAcct = true;
    }
    if (!hasTixApi) {
        ns.stock.purchaseTixApi();
        hasTixApi = true;
    }
    if (!has4SData) {
        ns.stock.purchase4SMarketData();
        has4SData = true;
    }
}


/**
 * @param {import("NetscriptDefinitions").NS} ns
 */
export async function main(ns) {
    verbose = ns.args.includes("-v") || ns.args.includes("--verbose");

    init(ns);
    stockObjects = ns.stock.getSymbols().map(sym => new Stock(sym, ns));

    let lastHeartbeat = 0;

    while (true) {
        player = ns.getPlayer();

        const now = Date.now();
        if (now - lastHeartbeat >= 15000) {
            printHeartbeat(ns);
            lastHeartbeat = now;
        }

        for (const stock of stockObjects) {
            if (stock.ownedLongShares > 0 && stock.forecast < 0.5) {
                stock.sell(stock.ownedLongShares);
            }

            if (stock.ownedShortShares > 0 && stock.forecast > 0.5) {
                stock.sellShort(stock.ownedShortShares);
            }
        }

        let budget = calcBuffer(ns);

        for (const stock of stockObjects) {
            if (stock.forecast > 0.6) {
                const transactionCost = purchaseLongStocks(ns, stock, budget);
                if (transactionCost > 0) {
                    budget -= transactionCost;
                }
            }
        }

        await ns.sleep(1500);
    }
}
/**
 * @param {import("NetscriptDefinitions").NS} ns 
 */
function printHeartbeat(ns) { 
    ns.print("Stocks inventory: ");
    ns.print("[");
    // for(let stockResult of ownedStocks) {
    //     ns.tprint(`{${stockResult.sym}, ${stockResult.ownedLongShares}},`);
    // }
    for (let stock of stockObjects) {
        if (stock.ownedLongShares > 0) {
            ns.print(`{${stock.sym}, ${stock.ownedLongShares}},`);
        }
    }
    ns.print("]");
}


/**
 * execeute a buy order of long stocks given the targeted stock to buy and a budget to do so with
 * @param {import("NetscriptDefinitions").NS} ns 
 * @param {Stock} stock 
 * @param {Number} budget 
 * @returns the overall cost of the transaction if it succeeded, -1 if it failed
 */
function purchaseLongStocks(ns, stock, budget) {
    const pricePerStock = ns.stock.getAskPrice(stock.sym);

    /** @type {Number} the number of stocks affordable on the given budget */
    const stocksAvailableForPurchase = stock.maxSharesAvailable - stock.ownedLongShares;

    const numStocksToBuy = Math.min(
        Math.floor(budget / pricePerStock),
        stocksAvailableForPurchase
    );


    if (numStocksToBuy > 0) {
        // ns.tprint(`Preparing to buy ${numStocksToBuy} long shares of ${stock.sym}...`);
        const moneySpentPerStock = stock.buy(numStocksToBuy);
        const transactionCost = moneySpentPerStock * numStocksToBuy + 100000;

        // @todo: replace with tprintf to format the money string
        ns.print(`SUCCESS Purchased ${numStocksToBuy} for $${transactionCost}`);
        return transactionCost;
    } else if (numStocksToBuy <= 0) {

        if (stocksAvailableForPurchase <= 0) {
            if (verbose) ns.print(`INFO ${stock.sym} at max cap: skipping...`);
        } else if (budget <= pricePerStock) {
            if (verbose) ns.print(`FAILURE Insufficient funds to buy ${stock.sym}.
                       Price:                    ${pricePerStock}
                       Budget:                   ${budget}`);

            // ns.tprint(`Failed to make long stock order for ${stock.sym}.
            //     Stats: 
            //     Budget available at time of exception: ${budget}
            //     # of Long stocks intended:             ${numStocksToBuy}
            //     # of Long stocks available:            ${stocksAvailableForPurchase}`);
        }
    }
    return -1;
}

