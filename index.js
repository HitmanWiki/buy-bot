const { ethers } = require("ethers");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
require("dotenv").config();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const RPC_URL = process.env.MONAD_RPC_URL;
const zlur_TOKEN = process.env.zlur_TOKEN_ADDRESS;

const POOL_ADDRESS = "0xC5C77b7aBD9BBeF47e06e234313C1eB413EcA52d".toLowerCase();

const bot = new TelegramBot(TOKEN, { polling: false });

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const MIN_zlur_AMOUNT = 100;

const GIFS = {
    small: "https://zlurpeeonmonad.fun/buy.mp4",
    medium: "https://zlurpeeonmonad.fun/buy.mp4",
    large: "https://zlurpeeonmonad.fun/buy.mp4"
};

function getEmojis(usdAmount) {
    if (usdAmount >= 10000) return "🟢".repeat(20);
    if (usdAmount >= 5000) return "🟢".repeat(16);
    if (usdAmount >= 1000) return "🟢".repeat(12);
    if (usdAmount >= 500) return "🟢".repeat(8);
    if (usdAmount >= 100) return "🟢".repeat(6);
    if (usdAmount >= 50) return "🟢".repeat(4);
    if (usdAmount >= 10) return "🟢".repeat(3);
    if (usdAmount >= 5) return "🟢".repeat(2);
    return "🟢".repeat(1);
}

function getGif(usdAmount) {
    return GIFS.small;
}

async function getTokenData() {
    try {
        const response = await axios.get(
            `https://api.dexscreener.com/latest/dex/tokens/${zlur_TOKEN}`,
            { timeout: 10000 }
        );
        
        if (response.data.pairs && response.data.pairs[0]) {
            const pair = response.data.pairs[0];
            const price = parseFloat(pair.priceUsd);
            const marketCap = pair.fdv || pair.marketCap || 0;
            
            console.log(`📊 Live Data: Price=$${price}, MC=$${marketCap.toLocaleString()}`);
            return { price, marketCap };
        }
    } catch (error) {
        console.log(`⚠️ DexScreener error: ${error.message}`);
    }
    
    // Return last known values
    return { price: lastPrice || 0.00000894, marketCap: lastMarketCap || 8940 };
}

function formatMessage(usdSpent, monSpent, zlurAmount, txHash, marketCap, buyerAddress) {
    const emojis = getEmojis(usdSpent);
    const txUrl = `https://monadexplorer.com/tx/${txHash}`;
    const buyerUrl = `https://monadexplorer.com/address/${buyerAddress}`;
    const dexUrl = `https://dexscreener.com/monad/${zlur_TOKEN}`;
    
    return `${emojis}\n\n` +
           `🔀 Spent <b>$${usdSpent.toFixed(2)}</b> (${monSpent.toFixed(4)} MON)\n` +
           `🔀 Got <b>${zlurAmount.toLocaleString()}</b> zlur\n` +
           `👤 <a href="${buyerUrl}">Buyer</a> | <a href="${txUrl}">TX</a>\n` +
           `🪙 <b>New Holder</b>\n` +
           `💸 Market Cap <b>$${marketCap.toLocaleString()}</b>\n\n` +
           `🧲 <a href="${dexUrl}">DexT</a> | ` +
           `<a href="${dexUrl}">Screener</a> | ` +
           `<a href="${dexUrl}">Buy</a> | ` +
           `<a href="https://dexscreener.com/trending">Trending</a>`;
}

async function sendAlert(usdSpent, monSpent, zlurAmount, txHash, marketCap, buyerAddress) {
    try {
        const message = formatMessage(usdSpent, monSpent, zlurAmount, txHash, marketCap, buyerAddress);
        const gifUrl = getGif(usdSpent);
        
        await bot.sendAnimation(CHAT_ID, gifUrl, {
            caption: message,
            parse_mode: "HTML"
        });
        
        console.log(`✅ ALERT SENT: $${usdSpent.toFixed(2)} | MC: $${marketCap.toLocaleString()}`);
    } catch (error) {
        console.log("⚠️ Send failed:", error.message);
        await bot.sendMessage(CHAT_ID, message, { parse_mode: "HTML" });
    }
}

let lastProcessedBlock = null;
const processedTxs = new Set();
let lastPrice = 0.00000894;
let lastMarketCap = 8940;

async function refreshPrice() {
    const data = await getTokenData();
    lastPrice = data.price;
    lastMarketCap = data.marketCap;
    console.log(`💰 Price updated: $${lastPrice} | MC: $${lastMarketCap.toLocaleString()}`);
}

async function checkLatestBlock() {
    try {
        const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
        const currentBlock = await provider.getBlockNumber();
        
        if (!lastProcessedBlock) {
            lastProcessedBlock = currentBlock;
            console.log(`🚀 Started from block ${currentBlock}`);
            await refreshPrice();
            return;
        }
        
        if (currentBlock > lastProcessedBlock) {
            for (let block = lastProcessedBlock + 1; block <= currentBlock; block++) {
                try {
                    const filter = {
                        address: zlur_TOKEN,
                        topics: [TRANSFER_TOPIC],
                        fromBlock: block,
                        toBlock: block
                    };
                    
                    const logs = await provider.getLogs(filter);
                    
                    if (logs.length > 0) {
                        console.log(`\n📦 BLOCK ${block} - Found ${logs.length} transfer(s)`);
                    }
                    
                    for (const log of logs) {
                        const txHash = log.transactionHash;
                        if (processedTxs.has(txHash)) continue;
                        
                        const fromAddr = "0x" + log.topics[1].slice(26);
                        const toAddr = "0x" + log.topics[2].slice(26);
                        const value = BigInt(log.data);
                        const zlurAmount = Number(ethers.utils.formatEther(value));
                        
                        if (zlurAmount < MIN_zlur_AMOUNT) continue;
                        
                        // 🔥 CRITICAL: Refresh price BEFORE every potential buy
                        await refreshPrice();
                        
                        const usdValue = zlurAmount * lastPrice;
                        
                        const isBuy = fromAddr.toLowerCase() === POOL_ADDRESS && 
                                      toAddr.toLowerCase() !== POOL_ADDRESS;
                        
                        const isSell = toAddr.toLowerCase() === POOL_ADDRESS && 
                                       fromAddr.toLowerCase() !== POOL_ADDRESS;
                        
                        console.log(`   🔄 ${zlurAmount.toLocaleString()} zlur ($${usdValue.toFixed(2)})`);
                        console.log(`      From: ${fromAddr.slice(0, 15)}... ${isBuy ? '✅ POOL' : ''}`);
                        console.log(`      To: ${toAddr.slice(0, 15)}...`);
                        
                        if (isBuy) {
                            console.log(`   🎯 BUY DETECTED! $${usdValue.toFixed(2)} worth`);
                            console.log(`   ✅ Buyer: ${toAddr}`);
                            console.log(`   📊 Market Cap at buy time: $${lastMarketCap.toLocaleString()}`);
                            
                            await sendAlert(usdValue, usdValue, zlurAmount, txHash, lastMarketCap, toAddr);
                            processedTxs.add(txHash);
                            await new Promise(resolve => setTimeout(resolve, 500));
                        } else if (isSell) {
                            console.log(`   ⏭️ SELL ignored: ${zlurAmount.toLocaleString()} zlur to pool`);
                        }
                    }
                } catch (error) {
                    if (!error.message.includes("block range") && !error.message.includes("rate limit")) {
                        console.log(`   Error: ${error.message.slice(0, 100)}`);
                    }
                }
            }
            lastProcessedBlock = currentBlock;
        }
    } catch (error) {
        console.error("❌ Error:", error.message);
    }
}

async function start() {
    console.log("\n========================================");
    console.log("🎨 zlur Buy Bot - REAL-TIME MARKET CAP");
    console.log("========================================\n");
    
    if (!TOKEN || !CHAT_ID || !zlur_TOKEN) {
        console.error("❌ Missing .env variables!");
        process.exit(1);
    }
    
    console.log("✅ Configuration loaded");
    console.log("✅ Token:", zlur_TOKEN.slice(0, 10) + "...");
    console.log("✅ Pool Address:", POOL_ADDRESS.slice(0, 15) + "...");
    console.log(`✅ Min zlur: ${MIN_zlur_AMOUNT.toLocaleString()}`);
    console.log("\n🚀 BOT IS LIVE! Fetching LIVE market cap on EVERY buy...\n");
    
    setInterval(checkLatestBlock, 2000);
    await checkLatestBlock();
}

start().catch(console.error);