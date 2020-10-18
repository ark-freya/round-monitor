import { Container, Contracts } from "@arkecosystem/core-kernel";
import Hapi from "@hapi/hapi";

import { Controller } from "./controller";

export type RouteConfig = {
    id: string;
    handler: any;
};

@Container.injectable()
export abstract class Route {
    @Container.inject(Container.Identifiers.Application)
    protected readonly app!: Contracts.Kernel.Application;

    public register(server: Hapi.Server): void {
        const controller = this.getController(server);
        server.bind(controller);

        for (const [path, config] of Object.entries(this.getRoutesConfigByPath())) {
            server.route({
                method: "POST",
                path,
                config: {
                    id: config.id,
                    handler: config.handler,
                },
            });
        }
    }

    public abstract getRoutesConfigByPath(): { [path: string]: RouteConfig };

    protected abstract getController(server: Hapi.Server): Controller;
}

export class RestartRoute extends Route {
    public getRoutesConfigByPath(): { [path: string]: RouteConfig } {
        const controller = this.getController();
        return {
            "/restart": {
                id: "restart",
                handler: controller.restart,
            },
        };
    }

    protected getController(): Controller {
        return this.app.resolve(Controller);
    }
}

export class CancelRoute extends Route {
    public getRoutesConfigByPath(): { [path: string]: RouteConfig } {
        const controller = this.getController();
        return {
            "/cancel": {
                id: "cancel",
                handler: controller.cancel,
            },
        };
    }

    protected getController(): Controller {
        return this.app.resolve(Controller);
    }
}
