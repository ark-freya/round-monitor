import { Providers, Types, Utils } from "@arkecosystem/core-kernel";

import { Monitor } from "./monitor";
import { Server } from "./server/server";

export class ServiceProvider extends Providers.ServiceProvider {
    private monitorSymbol = Symbol.for("RoundMonitor<Monitor>");
    private serverSymbol = Symbol.for("RoundMonitor<Server>");

    public async register(): Promise<void> {
        await this.build();
    }

    public async bootWhen(): Promise<boolean> {
        return !!this.config().get("enabled");
    }

    public async boot(): Promise<void> {
        this.app.get<Server>(this.serverSymbol).boot();
        this.app.get<Monitor>(this.monitorSymbol).boot();
    }

    public async dispose(): Promise<void> {
        if (!this.config().get("enabled")) {
            return;
        }

        this.app.get<Server>(this.serverSymbol).dispose();
    }

    private async build(): Promise<void> {
        this.app.bind<Server>(this.serverSymbol).to(Server).inSingletonScope();
        this.app.bind<Monitor>(this.monitorSymbol).to(Monitor).inSingletonScope();

        const server: Server = this.app.get<Server>(this.serverSymbol);
        const serverConfig = this.config().get<Types.JsonObject>("server");
        Utils.assert.defined<Types.JsonObject>(serverConfig);

        await server.initialize("Round Monitor server", serverConfig);
    }
}
