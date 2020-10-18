import { Container, Contracts, Types } from "@arkecosystem/core-kernel";
import { Server as HapiServer } from "@hapi/hapi";

import { CancelRoute, RestartRoute } from "./routes";

@Container.injectable()
export class Server {
    @Container.inject(Container.Identifiers.Application)
    private readonly app!: Contracts.Kernel.Application;

    @Container.inject(Container.Identifiers.LogService)
    private readonly logger!: Contracts.Kernel.Logger;

    private server!: HapiServer;
    private name!: string;

    public async initialize(name: string, optionsServer: Types.JsonObject): Promise<void> {
        this.name = name;

        const host = optionsServer.host;
        const port = Number(optionsServer.port);

        this.server = new HapiServer({ host, port });

        this.app.resolve(CancelRoute).register(this.server);
        this.app.resolve(RestartRoute).register(this.server);
    }

    public async boot(): Promise<void> {
        try {
            await this.server.start();
            this.logger.info(`${this.name} started at ${this.server.info.uri}`);
        } catch {
            await this.app.terminate(`Failed to start ${this.name}!`);
        }
    }

    public async dispose(): Promise<void> {
        try {
            await this.server.stop();
            this.logger.info(`${this.name} stopped at ${this.server.info.uri}`);
        } catch {
            await this.app.terminate(`Failed to stop ${this.name}!`);
        }
    }
}
