"use strict"

exports.plugin = {
    pkg: require("../package.json"),
    defaults: {
        enabled: false,
        httpPort: 5001,
        logLevel: "info",
        restartTimeBuffer: 120,
        showForgingOrder: true,
        showNextForgers: 5
    },
    async register (app, options) {
        if (!options.enabled) {
            return;
        }
        
        // Only allow acceptable log levels, otherwise default to info level
        const validLogLevels = ["error", "warn", "info", "debug"];
        if (!validLogLevels.includes(options.logLevel)) {
            options.logLevel = "info";
        }

        const blockchain = app.resolvePlugin("blockchain");
        const database = app.resolvePlugin("database");
        const logger = app.resolvePlugin("logger");
        const emitter = app.resolvePlugin("event-emitter");
        const execa = require("execa");
        const path = require("path");

        const { roundCalculator } = require("@arkecosystem/core-utils");
        const { createServer, mountServer } = require("@arkecosystem/core-http-utils");
        const { slots } = require("@arkecosystem/crypto");

        const cli = path.dirname(process.mainModule.filename) + "/run";

        let canRestart = true;
        let forgeState = undefined;
        let newRound = false;
        let publicKeys = [];
        let restartRequested = false;
        let restarting = false;
        let roundOrder = [];
        let lastSlot = 0;
        let slot = 0;

        emitter.on("round.created", async () => {
            // Start of a new round, wipe the old round info
            roundOrder.length = 0;
            publicKeys.length = 0;
            slot = 0;
            newRound = true;
            forgeState = undefined;
        });

        const startServer = async () => {
            // For security reasons, this server will only be accessible from localhost
            const server = await createServer({
                host: "127.0.0.1",
                port: options.httpPort
            });

            server.route({
                method: "POST",
                path: "/restart",
                handler() {
                    logger.info("Node restart requested");
                    restartRequested = true;
                    return "Restart requested successfully\n";
                }
            });

            server.route({
                method: "POST",
                path: "/cancel",
                handler() {
                    logger.info("Node restart cancelled");
                    restartRequested = false;
                    return "Restart cancelled successfully\n";
                }
            });

            return mountServer("Round Monitor", server);
        }

        const processNextSlot = async () => {
            const nextSlot = slots.getSlotNumber();
            if (nextSlot === lastSlot) {
                return;
            }
            lastSlot = nextSlot;
            canRestart = true;
            const block = blockchain.getLastBlock().data;
            const blockTime = app.getConfig().getMilestone(block.height).blocktime;
            const numDelegates = app.getConfig().getMilestone(block.height).activeDelegates;
            const roundPosition = numDelegates - Math.round(((block.height / numDelegates) % 1) * numDelegates) - 1;
            const roundRemaining = roundPosition * blockTime;

            let logBuilder = "";

            if (!roundOrder.length) {
                // No info exists for this round so fetch it from the database
                const round = await database.getActiveDelegates(roundCalculator.calculateRound(block.height + 1));
                roundOrder = round.map(delegate => delegate.username);
                publicKeys = round.map(delegate => delegate.publicKey);
            }

            // Sort the round order correctly
            const order = roundOrder.slice(roundOrder.indexOf(roundOrder[(nextSlot) % numDelegates])).concat(roundOrder).slice(0, numDelegates);
            const position = order.indexOf(options.delegate);
            const publicKey = publicKeys[roundOrder.indexOf(options.delegate)];
            if (slot === 0) {
                // This is our expected forge slot so we can compare to see if we forged successfully later
                slot = nextSlot + position;
            }
            if (newRound) {
                newRound = false;
                if (options.showForgingOrder) {
                    logger.info(`New round! Forging order: ${order.join(", ")}`);
                }
            }

            if (options.delegate) {
                if (position > -1) {
                    const timeRemaining = position * blockTime;
                    const minutes = Math.floor(parseInt(timeRemaining) / 60);
                    const seconds = parseInt(timeRemaining) - minutes * 60;
                    
                    // Determine if there is enough time to restart before we forge
                    canRestart = canRestart && timeRemaining > options.restartTimeBuffer;
                    let timeText = "";
                    if (minutes) {
                        timeText += minutes + "m ";
                    }
                    timeText += seconds + "s";
                    logBuilder += `Time until ${options.delegate} forges: ${timeText} `;
                    // We forged the last block!
                    if (block.generatorPublicKey === publicKey) {
                        forgeState = true;
                    // We haven't successfully forged yet and our slot has passed, so we failed
                    } else if(!forgeState && slots.getSlotNumber() > slot) {
                        forgeState = false;
                    }
                    if (forgeState !== undefined) {
                        logBuilder += (forgeState ? "✅" : "❌") + " ";
                    }
                } else {
                    logBuilder += `${options.delegate} is not forging in this round `;
                }
            } else {
                logBuilder += "No delegate configured in Round Monitor ";
            }

            // Show the current round position
            logBuilder += `[${(numDelegates - roundPosition)}/${numDelegates}`;
            
            // Show the next forgers
            logBuilder += options.showNextForgers > 0 ? `: ${order.slice(0, options.showNextForgers).join("/")}] ` : "] ";

            const minutes = Math.floor(parseInt(roundRemaining) / 60);
            const seconds = parseInt(roundRemaining) - minutes * 60;
            let timeText = "";
            if (minutes) {
                timeText += minutes + "m ";
            }
            timeText += seconds + "s";

            // Determine if there is also enough time to restart before the round ends
            canRestart = !options.delegate || (canRestart && roundRemaining > options.restartTimeBuffer);

            logBuilder += `[${timeText}]`;
            if (restartRequested) {
                logBuilder += ` [Waiting to restart]`;
            }

            logger[options.logLevel](logBuilder);

            // A restart has been requested and there is sufficient time to do it now
            if (canRestart && restartRequested && !restarting) {
                restarting = true;
                logger.warn("Safe to restart - going down now!");
                
                // Swallow any exceptions because some of these processes won't be running
                execa.shell(cli + " core:restart").then(() => {}, () => {});
                execa.shell(cli + " forger:restart").then(() => {}, () => {});
                execa.shell(cli + " relay:restart").then(() => {}, () => {});
            }
        }

        processNextSlot();
        startServer();

        // Check every 200ms for a new slot; this doesn't affect performance and is more reliable than slots.getTimeInMsUntilNextSlot() due to a race condition
        // Also more reliable than relying on the block.applied or block.received events in case consecutive blocks are missed
        setInterval(() => processNextSlot(), 200);
    }
}
