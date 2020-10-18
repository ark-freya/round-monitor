import { Repositories } from "@arkecosystem/core-database";
import { Container, Contracts, Enums, Providers, Services, Utils } from "@arkecosystem/core-kernel";
import { Crypto, Identities, Interfaces, Managers } from "@arkecosystem/crypto";
import { spawnSync } from "child_process";

@Container.injectable()
export class Monitor {
    @Container.inject(Container.Identifiers.Application)
    private readonly app!: Contracts.Kernel.Application;

    @Container.inject(Container.Identifiers.DatabaseBlockRepository)
    private readonly blockRepository!: Repositories.BlockRepository;

    @Container.inject(Container.Identifiers.PluginConfiguration)
    @Container.tagged("plugin", "@alessiodf/round-monitor")
    private readonly configuration!: Providers.PluginConfiguration;

    @Container.inject(Container.Identifiers.EventDispatcherService)
    private readonly events!: Contracts.Kernel.EventDispatcher;

    @Container.inject(Container.Identifiers.LogService)
    private readonly logger!: Contracts.Kernel.Logger;

    @Container.inject(Container.Identifiers.WalletRepository)
    @Container.tagged("state", "blockchain")
    private readonly walletRepository!: Contracts.State.WalletRepository;

    private currentRound!: Contracts.Shared.RoundInfo;
    private delegates: Array<any> = [];
    private delegatesInRound!: Array<string>;
    private restartRequested!: boolean;
    private roundSlot!: number;
    private slot!: number;

    private blockTimeLookup;

    public async boot(): Promise<void> {
        const delegate = this.configuration.get("delegate");

        let secrets: Array<string> | undefined = this.app.config("delegates.secrets");
        if (secrets && Array.isArray(secrets)) {
            for (const secret of secrets) {
                try {
                    const publicKey = Identities.PublicKey.fromPassphrase(secret);
                    if (publicKey) {
                        this.delegates.push({ publicKey });
                    }
                } catch (error) {
                    //
                }
            }
        }

        secrets = undefined;

        if (delegate) {
            if (Array.isArray(delegate)) {
                for (const name of delegate) {
                    if (typeof name === "string") {
                        this.delegates.push({ name });
                    }
                }
            } else if (typeof delegate === "string") {
                this.delegates.push({ name: delegate });
            }
        }

        const lastBlock: Interfaces.IBlock | undefined = this.app
            .get<Contracts.State.StateStore>(Container.Identifiers.StateStore)
            .getLastBlock();
        this.blockTimeLookup = await Utils.forgingInfoCalculator.getBlockTimeLookup(this.app, lastBlock.data.height);

        this.events.listen(Enums.BlockEvent.Applied, {
            handle: (data) => {
                this.newBlock(data);
            },
        });
        this.prepareRound();
        await this.calculateRoundOrder(lastBlock.data.height + 1, lastBlock.data, true);

        this.process();
    }

    public cancelRestart(): boolean {
        if (this.restartRequested) {
            this.restartRequested = false;
            this.logger.info("Safe restart cancelled");
            return true;
        }
        return false;
    }

    public requestRestart(): boolean {
        if (!this.restartRequested) {
            this.restartRequested = true;
            this.logger.info("Safe restart requested");
            return true;
        }
        return false;
    }

    private async calculateRoundOrder(
        nextHeight: number,
        lastBlock: Interfaces.IBlockData,
        initial: boolean = false,
    ): Promise<void> {
        const round: Contracts.Shared.RoundInfo = Utils.roundCalculator.calculateRound(nextHeight);

        if (this.currentRound && this.currentRound.round === round.round) {
            return;
        }

        this.currentRound = round;

        const roundWallets: Contracts.State.Wallet[] = (await this.app
            .get<Services.Triggers.Triggers>(Container.Identifiers.TriggerService)
            .call("getActiveDelegates", { roundInfo: round })) as Contracts.State.Wallet[];

        this.delegatesInRound = roundWallets.map((wallet) => wallet.getAttribute("delegate.username"));
        const sameSlot: boolean =
            Crypto.Slots.getSlotNumber(this.blockTimeLookup, lastBlock.timestamp) ===
            Crypto.Slots.getSlotNumber(this.blockTimeLookup);
        const roundPositionRemaining: number =
            this.currentRound.maxDelegates -
            Math.round(((lastBlock.height / this.currentRound.maxDelegates) % 1) * this.currentRound.maxDelegates) -
            1;
        const roundOrder: Array<string> = this.getCurrentOrder(
            Crypto.Slots.getSlotNumber(this.blockTimeLookup) + (sameSlot ? 1 : 0),
        );

        const orderText: string = roundOrder
            .map((delegate: string, index: number) => {
                const ansiCode: number = index > roundPositionRemaining ? 2 : 22;
                if (this.configuration.get("ansi")) {
                    return `\x1b[${ansiCode}m${delegate},\x1b[22m`;
                } else {
                    return `${delegate},`;
                }
            })
            .join(" ")
            .replace(/,([^,]*)$/, "$1");

        if (this.configuration.get("showForgingOrder")) {
            if (Utils.roundCalculator.isNewRound(nextHeight)) {
                this.logger.info(`New forging order: ${orderText}`);
            } else {
                this.logger.info(`Remaining forging order: ${orderText}`);
            }
        }

        const lastRoundBlockData: Interfaces.IBlockData | undefined = await this.blockRepository.findByHeight(
            this.currentRound.roundHeight - 1,
        );
        this.roundSlot = Crypto.Slots.getSlotNumber(this.blockTimeLookup, lastRoundBlockData?.timestamp) + 1;
    }

    private getCurrentOrder(slot: number): Array<string> {
        return this.delegatesInRound
            .slice(this.delegatesInRound.indexOf(this.delegatesInRound[slot % this.currentRound.maxDelegates]))
            .concat(this.delegatesInRound)
            .slice(0, this.currentRound.maxDelegates);
    }

    private async newBlock({ data }): Promise<void> {
        this.blockTimeLookup = await Utils.forgingInfoCalculator.getBlockTimeLookup(this.app, data.height);
        const nextHeight: number = data.height + 1;
        if (Utils.roundCalculator.isNewRound(nextHeight)) {
            this.prepareRound();
            this.calculateRoundOrder(nextHeight, data);
        }
    }

    private prepareRound(): void {
        for (const delegate of this.delegates) {
            delete delegate.position;
            delete delegate.state;
            delete delegate.time;
            if (!delegate.publicKey && delegate.name) {
                try {
                    const wallet: Contracts.State.Wallet = this.walletRepository.findByUsername(delegate.name);
                    if (wallet.publicKey) {
                        delegate.publicKey = wallet.publicKey;
                    }
                } catch {
                    //
                }
            }
            if (!delegate.name && delegate.publicKey) {
                try {
                    const wallet: Contracts.State.Wallet = this.walletRepository.findByPublicKey(delegate.publicKey);
                    if (wallet.hasAttribute("delegate")) {
                        const name = wallet.getAttribute("delegate.username");
                        if (name) {
                            delegate.name = name;
                        }
                    }
                } catch {
                    //
                }
            }
        }
        this.delegates = this.delegates.filter(
            (delegate, index, self) =>
                self.findIndex(
                    (thisDelegate) =>
                        thisDelegate.name === delegate.name && thisDelegate.publicKey === delegate.publicKey,
                ) === index,
        );
    }

    private async process(): Promise<void> {
        const lastBlockData: Interfaces.IBlockData | undefined = this.app
            .get<Contracts.State.StateStore>(Container.Identifiers.StateStore)
            .getLastBlock().data;
        const slot: number = Crypto.Slots.getSlotNumber(this.blockTimeLookup);

        if (slot === this.slot) {
            return;
        }

        this.slot = slot;

        if (Crypto.Slots.getSlotNumber(this.blockTimeLookup, lastBlockData.timestamp) === this.slot) {
            return this.processNextSlot();
        }

        const blockTime: number = Managers.configManager.getMilestone(lastBlockData.height).blocktime;
        const fixedOrder: Array<string> = this.getCurrentOrder(this.roundSlot);
        const roundOrder: Array<string> = this.getCurrentOrder(this.slot);
        const roundPosition: number = Math.round(
            ((lastBlockData.height / this.currentRound.maxDelegates) % 1) * this.currentRound.maxDelegates,
        );
        const roundTimeRemaining: number = (this.currentRound.maxDelegates - roundPosition - 1) * blockTime;
        let forgeTimeRemaining: number = roundTimeRemaining;
        const delegatesForging: Array<any> = [];

        roundOrder.map((activeDelegate: string, index: number) => {
            const ourDelegate = this.delegates.filter((delegate) => activeDelegate === delegate.name).pop();
            if (ourDelegate) {
                const wallet: Contracts.State.Wallet = this.walletRepository.findByUsername(activeDelegate);
                const delegateInfo = wallet.getAttribute("delegate");
                if (delegateInfo && delegateInfo.lastBlock && delegateInfo.lastBlock.height) {
                    if (
                        Crypto.Slots.getSlotNumber(this.blockTimeLookup, delegateInfo.lastBlock.timestamp) >=
                        this.roundSlot
                    ) {
                        ourDelegate.state = true;
                    } else if (
                        Crypto.Slots.getSlotNumber(this.blockTimeLookup) >
                            this.roundSlot + fixedOrder.indexOf(activeDelegate) &&
                        Crypto.Slots.getSlotNumber(this.blockTimeLookup, delegateInfo.lastBlock.timestamp) <
                            this.roundSlot
                    ) {
                        ourDelegate.state = false;
                    }
                }
                ourDelegate.position = index;
                ourDelegate.time = index * blockTime;
                if (ourDelegate.time < forgeTimeRemaining) {
                    forgeTimeRemaining = ourDelegate.time;
                }
                delegatesForging.push(ourDelegate);
            }
        });

        const restartTimeBuffer: number = Number(this.configuration.get("restartTimeBuffer"));

        if (
            this.restartRequested &&
            (!this.delegates.filter((delegate) => delegate.name && delegate.publicKey).length ||
                ((!delegatesForging.length || forgeTimeRemaining >= restartTimeBuffer) &&
                    roundTimeRemaining >= restartTimeBuffer))
        ) {
            await this.restart();
            return;
        }

        const roundMinutes: number = Math.floor(Math.trunc(roundTimeRemaining) / 60);
        const roundSeconds: number = Math.trunc(roundTimeRemaining) - roundMinutes * 60;

        let output: string = "";

        let roundEndTime: string = "";
        if (roundMinutes) {
            roundEndTime = `${roundMinutes}m `;
        }
        roundEndTime += `${roundSeconds}s`;

        if (delegatesForging.length) {
            const forgingTimes: Array<string> = [];
            for (const delegate of delegatesForging) {
                const minutes: number = Math.floor(Math.trunc(delegate.time) / 60);
                const seconds: number = Math.trunc(delegate.time) - minutes * 60;
                let forgingTime: string = "";
                if (minutes) {
                    forgingTime = `${minutes}m `;
                }
                forgingTime += `${seconds}s (${delegate.name})`;
                if (delegate.state !== undefined) {
                    if (delegate.state) {
                        forgingTime += " ✅";
                    } else {
                        forgingTime += " ❌";
                    }
                }
                if (this.configuration.get("ansi")) {
                    const ansiCode: number =
                        delegate.position === 0
                            ? 1
                            : delegate.position + roundPosition >= this.currentRound.maxDelegates
                            ? 2
                            : 22;
                    forgingTimes.push(`\x1b[${ansiCode}m${forgingTime},\x1b[22m`);
                } else {
                    forgingTimes.push(`${forgingTime},`);
                }
            }
            output += `Time until we forge: ${forgingTimes.join(" ").replace(/,([^,]*)$/, "$1")} `;
        }

        if (
            !isNaN(Number(this.configuration.get("showNextForgers"))) &&
            Number(this.configuration.get("showNextForgers")) > 0
        ) {
            const orderText: string = roundOrder
                .map((delegate: string, index: number) => {
                    const ansiCode: number =
                        index === 0 ? 1 : index + roundPosition >= this.currentRound.maxDelegates ? 2 : 22;
                    if (this.configuration.get("ansi")) {
                        return `\x1b[${ansiCode}m${delegate},\x1b[22m`;
                    } else {
                        return `${delegate},`;
                    }
                })
                .slice(0, this.configuration.get("showNextForgers"))
                .join(" ")
                .replace(/,([^,]*)$/, "$1");
            const positionText: string = `${roundPosition + 1}/${this.currentRound.maxDelegates}`;
            if (!delegatesForging.length) {
                output = `Next to forge: ${orderText} [${positionText}] `;
            } else {
                output += `[${positionText}: ${orderText}] `;
            }
        }

        if (this.configuration.get("showRoundTime")) {
            if (output.length) {
                output += `[${roundEndTime}] `;
            } else {
                output = `Round ends in ${roundEndTime} `;
            }
        }

        if (this.restartRequested) {
            if (output.length) {
                if (this.configuration.get("ansi")) {
                    output += "\x1b[1m[Waiting to restart\x1b[22m]";
                } else {
                    output += "[Waiting to restart]";
                }
            }
        }

        if (output.length) {
            this.logger.info(output.trim());
        }

        return this.processNextSlot();
    }

    private async processNextSlot(): Promise<void> {
        setTimeout(() => this.process(), Crypto.Slots.getTimeInMsUntilNextSlot(this.blockTimeLookup));
    }

    private async restart(): Promise<void> {
        this.logger.info("Round Monitor is safely restarting Core now");
        const processes: string = spawnSync("pm2 jlist", { shell: true }).stdout.toString().split("\n").pop()!;

        const forgerProcess = JSON.parse(processes).find(
            (pm2Process) => pm2Process.name === `${process.env.CORE_TOKEN}-forger`,
        );
        if (forgerProcess && forgerProcess.pm2_env && forgerProcess.pm2_env.status === "online") {
            spawnSync(`pm2 restart ${process.env.CORE_TOKEN}-forger --update-env`, {
                shell: true,
            });
        }

        const relayProcess = JSON.parse(processes).find(
            (pm2Process) => pm2Process.name === `${process.env.CORE_TOKEN}-relay`,
        );
        if (relayProcess && relayProcess.pm2_env && relayProcess.pm2_env.status === "online") {
            spawnSync(`pm2 restart ${process.env.CORE_TOKEN}-relay --update-env`, {
                shell: true,
            });
        }

        const coreProcess = JSON.parse(processes).find(
            (pm2Process) => pm2Process.name === `${process.env.CORE_TOKEN}-core`,
        );
        if (coreProcess && coreProcess.pm2_env && coreProcess.pm2_env.status === "online") {
            spawnSync(`pm2 restart ${process.env.CORE_TOKEN}-core --update-env`, {
                shell: true,
            });
        }

        await this.app.terminate();
        process.exit();
    }
}
