# Round Monitor

## Introduction

This repository contains the Round Monitor plugin. It provides the following functionality for Ark and Ark-powered blockchains:

Logging of:
- The full forging order for each round as it starts.
- How long is left until your delegate is due to forge in the current round.
- The estimated time remaining in the current round.
- A list of the next few delegates about to forge.
- A visual indicator of whether you forged successfully (`✅`) or not (`❌`).

An additional HTTP server with endpoints to:
- Execute a safe restart of the node which will only run when there is sufficient time to ensure you do not miss a block.
- Cancel a pending safe restart.

The logging options are configurable and, by default, the HTTP server is only accessible on the local node for security reasons.

## Installation

Execute the following:

```yarn global add @alessiodf/round-monitor```

Once the plugin is installed, we must configure it by modifying `plugins.js`. This file is found in `~/.config/ark-core/{mainnet|devnet|testnet|unitnet}/plugins.js` depending on network.

Add a new section to the `module.exports` block for the configuration options. **Add it as the last section inside the `module.exports` block, after all the other sections.** An example configuration is below:

```
    "@alessiodf/round-monitor": {
        "enabled": true
    }
```

## Running

After installation, make sure the `plugins.js` file is correctly configured and restart Core. If you are using the CLI, this will probably be `ark core:restart` (or `ark relay:restart` if you wish to use the separate processes rather than the unified Core), although `ark` may be different in the case of bridgechains. If using Core Control, run `ccontrol restart relay`.

The plugin will start whenever the Core or Relay process is running, as long as the `enabled` configuration option is `true`. All being well, additional lines will begin to appear in your Core or Relay log files.

It will automatically detect any configured delegates on the node assuming BIP38 is not used. If using BIP38, or you would like to monitor additional delegates not configured on the node, add them to the `delegate` directive explained further below.

Some example log lines are as follows:

```INFO : Time until we forge: alessio [8s] [11/51: xillion/alessio/starshot] [5m 20s]```

This tells us that `alessio` is 8 seconds away from the opening of its forging slot, that we are currently 11 delegates into the current round of 51, that the next three forgers are `xillion`, `alessio` and `starshot` and that the round is due to end in 5 minutes and 20 seconds.

```INFO : Time until we forge: alessio ✅ [6m 40s] [13/51: starshot/geops/bongoninja] [5m 4s]```

The check mark shows that `alessio` forged successfully in this round and the block has been received and accepted by the local relay node.

You may be wondering why we might forge again in 6 minutes and 40 seconds since we've already forged in the round and the round is scheduled to end in only 5 minutes and 4 seconds. That is because the round end time is only an estimate as it depends on 51 delegates forging successfully, so, in theory, if several other delegates miss their blocks, the round time will be extended by 8 seconds for each delegate that misses its block, so we could get to forge again in the same round.

```INFO : Time until we forge: alessio ❌ [3m 28s] [34/51: cam/proxima_centauri_b/theforgery] [2m 16s]```

The cross tells us that our local relay node did not receive a block from `alessio` when it was expected, which is indicative that we did not forge successfully.

```INFO : Time until we forge: alessio ✅ [3m 44s] [46/51: genesis_35/bioly/genesis_31] [40s] [Waiting to restart]```

We have requested a restart but it is not safe to do so yet, so we are waiting. In this case it is not safe to restart even though we have already forged in the round because the round is due to end in approximately 40 seconds, and we don't know where we will appear in the following round, so the restart may not complete in time if we forge early in the next round.

## Configuration Options

- `enabled` - Should be `true` to enable the plugin or `false` to disable it. Default: `false`.

- `delegate` - The names of any additional delegates you wish to monitor. This should be their delegate names in an array, not the public keys or passphrases. For example: `["alessio", "fun"]`. Default: none.

- `httpAddress` - The IP address to bind the HTTP server to. Beware, if this is publicly accessible then anyone can restart your node. Default: `127.0.0.1`.

- `httpPort` - The TCP port to bind the HTTP server to. It must not be already in use. Default: `5001`.

- `logLevel` - The log level used when printing round information. Must be either `error`, `warn`, `info` or `debug`. Default: `info`.

- `restartCommand` - The command to execute to trigger a restart if not using the Core CLI. If using the CLI, this should not be set. Default: none.

- `restartTimeBuffer` - The minimum number of seconds between now and our forging time **and also** between now and the end of the round in order to execute a safe restart. Default: `120`.

- `showForgingOrder` - A boolean value to enable or disable printing the full round order when each new round starts. Default: `true`.

- `showNextForgers` - An integer value corresponding to how many upcoming forgers to display. Default: `3`.

## Safe Restarting

One of the main aims of this plugin is to facilitate safe restarting so we do not miss blocks during restarts. This could be when updating Core or for any other reason that requires the Core, Relay or Forger processes to restart.

To safely restart, hit the `http://127.0.0.1:5001/restart` endpoint with a HTTP POST request. You can send HTTP POST requests from the Linux command line using cURL or similar. For example: `curl --request POST http://127.0.0.1:5001/restart`. If done correctly, you should see `Restart requested successfully` on your terminal screen.

Replace `5001` with the port specified in the `httpPort` configuration directive if you have changed it from the default.

If you no longer wish to restart, and the restart has not yet been executed, you can cancel it by sending a HTTP POST request to `http://127.0.0.1:5001/cancel`.

The restart procedure restarts the Core, Relay and Forger processes, if they are running.

## Safe Updating of Core

If you wish to safely update Core using the CLI, pass the `--no-restart` flag to the `ark update` command to update Core without restarting the process afterwards. When this is complete, execute a safe restart as per the above instructions. The whole process can be automated by also passing the `--force` flag to the `ark update` command like so: `ark update --force --no-restart ; curl --request POST http://127.0.0.1:5001/restart`.

If using Core Control, run `ccontrol update core` which will automatically initiate a safe restart if the plugin is enabled and both Relay and Forger processes are running.

## Credits

-   [All Contributors](../../contributors)
-   [alessiodf](https://github.com/alessiodf)

## License

[GPLv3](LICENSE) © [alessiodf](https://github.com/alessiodf)

