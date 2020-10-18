export const defaults = {
    ansi: true,
    enabled: true,
    server: {
        host: "127.0.0.1",
        port: (Number(process.env.CORE_P2P_PORT) || 4001) + 1000,
    },
    restartTimeBuffer: 180,
    showForgingOrder: true,
    showNextForgers: 3,
    showRoundTime: true,
};
