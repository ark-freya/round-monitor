exports.plugin = {
    "pkg": require("../package.json"),
    "defaults": {
        "enabled": false,
        "httpAddress": "127.0.0.1",
        "httpPort": 5001,
        "logLevel": "info",
        "restartTimeBuffer": 120,
        "showForgingOrder": true,
        "showNextForgers": 3
    },
    async register (app, options) {
        if (!options.enabled) {
            return;
        }

        const validLogLevels = ["error", "warn", "info", "debug"];
        if (!validLogLevels.includes(options.logLevel)) {
            options.logLevel = "info";
        }

        const blockchain = app.resolvePlugin("blockchain"),
              config = app.getConfig(),
              database = app.resolvePlugin("database"),
              emitter = app.resolvePlugin("event-emitter"),
              logger = app.resolvePlugin("logger");

        const execa = require("execa");
        const path = require("path");

        const scopes = Object.keys(app.plugins.plugins).filter(
              scope => scope.endsWith("/core-api") ||
              scope.endsWith("/core-blockchain") ||
              scope.endsWith("/core-event-emitter") ||
              scope.endsWith("/core-p2p") ||
              scope.endsWith("/core-state") ||
              scope.endsWith("/core-transaction-pool")
        ).map(
              scope => scope.substring(0, scope.lastIndexOf("/"))
        ).reduce((count, current) => {
              if (current in count) {
                  count[current]++;
              } else {
                  count[current] = 1;
              }
              return count;
        },{});

        const scope = Object.keys(scopes).reduce((a, b) => scopes[a] > scopes[b] ? a : b);

        const {roundCalculator} = require(`${scope}/core-utils`);
        const {createServer, mountServer} = require(`${scope}/core-http-utils`);
        const {Crypto, Identities} = require(`${scope}/crypto`), {Slots} = Crypto;

        const delegates = {"keys": [], "monitoring": []},
              restart = {"active": false, "requested": false},
              round = {"calculated": [], "order": []},
              slot = {"last": 0, "round": 0};

        let newRound = false;

        emitter.on("round.created", async () => {
            round.order.length = 0;
            delegates.keys.length = 0;
            for (const delegate of delegates.monitoring) {
                delegate.state = undefined;
            }
            newRound = true;
        });

        const importDelegates = () => {
            let secrets = config.get("delegates.secrets");
            if (secrets && Array.isArray(secrets)) {
                for (const secret of secrets) {
                    try {
                        const publicKey = Identities.PublicKey.fromPassphrase(secret);
                        if (publicKey) {
                            const delegateName = getDelegateName(publicKey);
                            if (delegateName && delegateName !== options.delegate) {
                                delegates.monitoring.push({"name": delegateName, "state": undefined});
                            }
                        }
                    } catch (error) {
                    }
                }
            }
            secrets = null;
            if (options.delegate) {
                if (Array.isArray(options.delegate)) {
                    for (const delegate of options.delegate) {
                        delegates.monitoring.push({"name": delegate, "state": undefined});
                    }
                } else {
                    delegates.monitoring.push({"name": options.delegate, "state": undefined});
                }
            }
        },

        getDelegateName = (publicKey) => {
            const delegate = database.walletManager.findByPublicKey(publicKey);
            return delegate.username ? delegate.username : delegate.attributes.delegate.username;
        },

        getDelegateInfo = async (publicKey) => {
            if (database.delegates) {
                return await database.delegates.findById(publicKey);
            }
            const {Database} = require(`${scope}/core-interfaces`);
            return (await database.wallets.findById(Database.SearchScope.Delegates, publicKey)).attributes.delegate;
        },

        getRound = async (calculated) => {
            const roundDelegates = await database.getActiveDelegates(calculated);
            return roundDelegates.map((delegate) => ({username: delegate.username ? delegate.username : delegate.attributes.delegate.username, publicKey: delegate.publicKey}));
        },

        startServer = async () => {
            const server = await createServer({
                  "host": options.httpAddress,
                  "port": options.httpPort
            });

            server.route({
                "method": "POST",
                "path": "/restart",
                handler () {
                    logger.info("Node restart requested");
                    restart.requested = true;
                    return "Restart requested successfully\n";
                }
            });

            server.route({
                "method": "POST",
                "path": "/cancel",
                handler () {
                    logger.info("Node restart cancelled");
                    restart.requested = false;
                    return "Restart cancelled successfully\n";
                }
            });

            return mountServer("Round Monitor", server);
        },

        processNextSlot = async () => {
            const nextSlot = Slots.getSlotNumber();
            if (nextSlot === slot.last) {
                return;
            }
            slot.last = nextSlot;

            let canRestart = true;

            const block = blockchain.getLastBlock().data,
                  blockTime = config.getMilestone(block.height).blocktime,
                  numDelegates = config.getMilestone(block.height).activeDelegates,
                  roundPosition = numDelegates - Math.round(block.height / numDelegates % 1 * numDelegates) - 1,
                  roundRemaining = roundPosition * blockTime;

            let logBuilder = "";

            if (!round.order.length) {
                round.calculated = roundCalculator.calculateRound(block.height + 1);
                const thisRound = await getRound(round.calculated);
                round.order = thisRound.map((delegate) => delegate.username);
                delegates.keys = thisRound.map((delegate) => delegate.publicKey);
                const lastRoundBlock = await database.blocksBusinessRepository.findByHeight(round.calculated.roundHeight - 1);
                slot.round = Slots.getSlotNumber(lastRoundBlock.timestamp) + 1;
            }

            const order = round.order.slice(round.order.indexOf(round.order[nextSlot % numDelegates])).concat(round.order).slice(0, numDelegates),
                  fixedOrder = round.order.slice(round.order.indexOf(round.order[slot.round % numDelegates])).concat(round.order).slice(0, numDelegates);

            if (newRound) {
                newRound = false;
                if (options.showForgingOrder) {
                    logger.info(`New round! Forging order: ${order.join(", ")}`);
                }
            }

            let forgingDelegates = 0;

            if (delegates.monitoring.length) {
                const delegateForgeTimes = [];
                for (const delegate of delegates.monitoring) {
                    const position = order.indexOf(delegate.name),
                          publicKey = delegates.keys[round.order.indexOf(delegate.name)];
                    if (position > -1) {
                        const delegateInfo = await getDelegateInfo(publicKey),
                              delegatePosition = fixedOrder.indexOf(delegate.name);

                        if (delegateInfo && delegateInfo.lastBlock && delegateInfo.lastBlock.height) {
                            if (Slots.getSlotNumber(delegateInfo.lastBlock.timestamp) >= slot.round) {
                                delegate.state = true;
                            } else if (Slots.getSlotNumber() > slot.round + delegatePosition && Slots.getSlotNumber(delegateInfo.lastBlock.timestamp) < slot.round) {
                                delegate.state = false;
                            }
                        }

                        let forgeText = "";

                        forgingDelegates++;

                        const timeRemaining = position * blockTime,
                              minutes = Math.floor(parseInt(timeRemaining) / 60),
                              seconds = parseInt(timeRemaining) - minutes * 60;

                        canRestart = canRestart && timeRemaining > options.restartTimeBuffer;

                        let timeText = "";

                        if (minutes) {
                            timeText += `${minutes}m `;
                        }

                        timeText += `${seconds}s`;
                        forgeText += `${delegate.name}`;

                        if (delegate.state !== undefined) {
                            forgeText += delegate.state ? " ✅" : " ❌";
                        }

                        forgeText += ` [${timeText}], `;
                        delegateForgeTimes.push({timeRemaining, forgeText});
                    }
                }

                if (forgingDelegates) {
                    logBuilder += "Time until we forge: ";
                    delegateForgeTimes.sort((a, b) => b.timeRemaining < a.timeRemaining);
                    for (const delegateForgeTime of delegateForgeTimes) {
                        logBuilder += delegateForgeTime.forgeText;
                    }
                    logBuilder = `${logBuilder.substring(0, logBuilder.length - 2)} `;
                } else {
                    logBuilder += "We are not forging in this round ";
                }
            } else {
                logBuilder += "No delegates configured on this node ";
            }

            logBuilder += `[${(numDelegates - roundPosition)}/${numDelegates}`;
            logBuilder += options.showNextForgers > 0 ? `: ${order.slice(0, options.showNextForgers).join("/")}] ` : "] ";

            const minutes = Math.floor(parseInt(roundRemaining) / 60),
                  seconds = parseInt(roundRemaining) - minutes * 60;

            let timeText = "";

            if (minutes) {
                timeText += `${minutes}m `;
            }

            timeText += `${seconds}s`;

            canRestart = !delegates.monitoring.length || (canRestart && roundRemaining > options.restartTimeBuffer);

            logBuilder += `[${timeText}]`;

            if (restart.requested) {
                logBuilder += " [Waiting to restart]";
            }

            logger[options.logLevel](logBuilder);

            if (canRestart && restart.requested && !restart.active) {
                restart.active = true;
                logger.warn("Safe to restart - going down now!");

                if (options.restartCommand) {
                    execa.command(options.restartCommand, {"shell": true}).then(() => {}, () => {});
                } else {
                    const cli = `${path.dirname(process.mainModule.filename)}/run`;
                    execa.command(`${cli} core:restart`, {"shell": true}).then(() => {}, () => {});
                    execa.command(`${cli} forger:restart`, {"shell": true}).then(() => {}, () => {});
                    execa.command(`${cli} relay:restart`, {"shell": true}).then(() => {}, () => {});
                }
            }
        };

        importDelegates();
        processNextSlot();
        startServer();

        setInterval(() => processNextSlot(), 200);
    }
};
