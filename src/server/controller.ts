import { Container, Contracts } from "@arkecosystem/core-kernel";
import Boom from "@hapi/boom";
import Hapi from "@hapi/hapi";

import { Monitor } from "../monitor";

@Container.injectable()
export class Controller {
    @Container.inject(Container.Identifiers.Application)
    protected readonly app!: Contracts.Kernel.Application;

    @Container.inject(Container.Identifiers.LogService)
    protected readonly logger!: Contracts.Kernel.Logger;

    private monitorSymbol = Symbol.for("RoundMonitor<Monitor>");

    public async restart(request: Hapi.Request, h: Hapi.ResponseToolkit): Promise<any> {
        const success: boolean = this.app.get<Monitor>(this.monitorSymbol).requestRestart();
        if (success) {
            return h.response({ success: true, message: "Safe restart requested successfully" }).code(202);
        } else {
            return Boom.forbidden("Safe restart already requested");
        }
    }

    public async cancel(request: Hapi.Request, h: Hapi.ResponseToolkit): Promise<any> {
        const success: boolean = this.app.get<Monitor>(this.monitorSymbol).cancelRestart();
        if (success) {
            return h.response({ success: true, message: "Safe restart cancelled successfully" }).code(200);
        } else {
            return Boom.forbidden("No safe restart was requested");
        }
    }
}
