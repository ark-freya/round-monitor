# Round Monitor

## Introduction

This repository contains the Round Monitor plugin. It provides the following functionality for ARK Core 3.0 blockchains:

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

**This is TBC with the new `ark plugin:install` command.**

Once the plugin is installed, we must configure it by modifying `app.json`. This file is found in `~/.config/ark-core/{mainnet|devnet|testnet|unitnet}/app.json` depending on network.

Add a new entry to the end of the `plugins` section within either the `relay` or `core` blocks, depending on whether you wish to use the separate relay/forger processes or the unified Core respectively. Of course, you can also add the plugin to both blocks if you wish to have the freedom to swap between the separate processes and the unified Core. Your entry or entries should look like the following:

```
    "relay": {
        "plugins": [
            ...
            {
                "package": "@alessiodf/round-monitor"
            }
        ]
    },
```

Or:

```
    "core": {
        "plugins": [
            ...
            {
                "package": "@alessiodf/round-monitor"
            }
        ]
    },
```

That's all you need to do to run Round Monitor with the default settings. If you wish, you can customise its behaviour by reading the [Configuration Options](#configuration-options) section below.

## Running

After installation, make sure the `app.json` file is correctly configured and restart Core. If you are using the CLI, this will probably be `ark core:restart` (or `ark relay:restart` if you wish to use the separate processes rather than the unified Core), although `ark` may be different in the case of bridgechains. If using Core Control, run `ccontrol restart relay`.

The plugin will start whenever the Core or Relay process is running. All being well, additional lines will begin to appear in your Core or Relay log files.

It will automatically detect any configured delegates on the node assuming BIP38 is not used. If using BIP38, or you would like to monitor additional delegates not configured on the node, add them to the `delegate` directive explained further below.

Some example log lines are as follows:

```INFO : Time until we forge: 8s (alessio) [11/51: geops/alessio/arktoshi] [5m 20s]```

This tells us that `alessio` is 8 seconds away from the opening of its forging slot, that we are currently 11 delegates into the current round of 51, that the next three forgers are `geops`, `alessio` and `arktoshi` and that the round is due to end in 5 minutes and 20 seconds.

```INFO : Time until we forge: 6m 40s (alessio) ✅ [6m 40s] [13/51: espresso/echo/boldninja] [5m 4s]```

The check mark shows that `alessio` forged successfully in this round and the block has been received and accepted by the local relay node.

You may be wondering why we might forge again in 6 minutes and 40 seconds since we've already forged in the round and the round is scheduled to end in only 5 minutes and 4 seconds. That is because the round end time is only an estimate as it depends on 51 delegates (in the case of ARK) forging successfully, so, in theory, if several other delegates miss their blocks, the round time will be extended for each delegate that misses its block, so we could get to forge again in the same round.

```INFO : Time until we forge: 3m 28s (alessio) ❌ [3m 28s] [34/51: cam/mililiter/kaos] [2m 16s]```

The cross tells us that our local relay node did not receive a block from `alessio` when it was expected, which is indicative that we did not forge successfully.

```INFO : Time until we forge: 3m 44s (alessio) ✅ [3m 44s] [46/51: dark_jamie/friendsoflittleyus/the_bobbie_bunch] [40s] [Waiting to restart]```

We have requested a restart but it is not safe to do so yet, so we are waiting. In this case it is not safe to restart even though we have already forged in the round because the round is due to end in approximately 40 seconds, and we don't know where we will appear in the following round, so the restart may not complete in time if we forge early in the next round.

## Configuration Options

- `ansi` - A boolean value to determine whether or not to add ANSI control characters to the output to add bold and dimmed formatting (bold text indicates the next forging delegate, dimmed text indicates the slot has passed so the delegate is not currently expected to forge again in this round). Default: `true`.

- `enabled` - Should be `true` to enable the plugin or `false` to disable it. Default: `true`.

- `delegate` - The names of any additional delegates you wish to monitor. This can either be a delegate name, e.g. `"alessio"` or it can be an array of multiple delegate names, such as `["alessio", "fun"]`. Remember it will automatically include any forging delegates configured on your node without explicitly setting this. Default: none.

- `server.host` - The IP address to bind the HTTP server to. Beware, if this is publicly accessible then anyone can restart your node, so only change this if you know what you are doing. Default: `127.0.0.1`.

- `server.port` - The TCP port to bind the HTTP server to. It must not be already in use. Default: 1000 above the P2P port number.

- `restartTimeBuffer` - The minimum number of seconds between now and our forging time **and also** between now and the end of the round in order to execute a safe restart. Default: `180`.

- `showForgingOrder` - A boolean value to enable or disable printing the full round order when each new round starts. Default: `true`.

- `showNextForgers` - An integer value corresponding to how many upcoming forgers to display. Default: `3`.

- `showRoundTime` - A boolean value to enable or disable printing the time left until the end of the round. Default: `true`.

Any of these options can be added to the `app.json` file, either in the `relay` or `core` blocks, depending on whether you wish to use the separate processes or the unified Core respectively. For example, if you want to use a custom configuration for the `relay` process:

```
    "relay": {
        "plugins": [
            ...
            {
                "package": "@alessiodf/round-monitor",
                "options": {
                    "ansi": true,
                    "delegate": ["alessio", "fun"],
                    "server": {
                        "port": 6000
                    }
                }
            }
        ]
    },
```

Alternatively, if you use the `core` process:

```
    "core": {
        "plugins": [
            ...
            {
                "package": "@alessiodf/round-monitor",
                "options": {
                    "ansi": true,
                    "delegate": ["alessio", "fun"],
                    "server": {
                        "port": 6000
                    }
                }
            }
        ]
    },
```

## Safe Restarting

One of the main aims of this plugin is to facilitate safe restarting so we do not miss blocks during restarts. This could be when updating Core or for any other reason that requires the Core, Relay or Forger processes to restart.

To safely restart, hit the `http://127.0.0.1:XXXX/restart` endpoint with a HTTP POST request, where `XXXX` is the port that the Round Monitor server is listening on. By default, the port is 1000 above the P2P port, although you can set it manually as explained above. If you are not sure of the port, check your log as you will see a line similar to the following, which in this case shows the port is 5002:

```INFO : Round Monitor server started at http://127.0.0.1:5002```

You can send HTTP POST requests from the Linux command line using cURL or similar. For example: `curl --request POST http://127.0.0.1:5002/restart`. If done correctly, you should see a `Safe restart requested successfully` response on your terminal screen.

If you no longer wish to restart, and the restart has not yet been executed, you can cancel it by sending a HTTP POST request to `http://127.0.0.1:XXXX/cancel`.

The restart procedure restarts the Core, Relay and Forger processes, if they are running.

## Safe Updating of Core

If you wish to safely update Core using the CLI, pass the `--no-restart` flag to the `ark update` command to update Core without restarting the process afterwards. When this is complete, execute a safe restart as per the above instructions. The whole process can be automated by also passing the `--force` flag to the `ark update` command like so: `ark update --force --no-restart ; curl --request POST http://127.0.0.1:XXXX/restart`. Remember to substitute `XXXX` for your actual port.

If using Core Control, run `ccontrol update core` which will automatically initiate a safe restart if the plugin is enabled and both Relay and Forger processes are running.

## Credits

-   [All Contributors](../../contributors)
-   [alessiodf](https://github.com/alessiodf)

## License

[GPLv3](LICENSE) © [alessiodf](https://github.com/alessiodf)
