# homebridge-deako

[![npm](https://img.shields.io/npm/v/homebridge-deako)](https://www.npmjs.com/package/homebridge-deako)
[![CI](https://github.com/mitch-zink/homebridge-deako/actions/workflows/ci.yml/badge.svg)](https://github.com/mitch-zink/homebridge-deako/actions/workflows/ci.yml)

Control [Deako](https://www.deako.com/) smart light switches and dimmers from Apple Home through [Homebridge](https://homebridge.io).

- **Local only.** Talks to the Deako hub on your network. No cloud account, no tokens.
- **Auto-discovery.** Every light the hub reports appears in Apple Home as a light.
- **Live state.** Changes from the wall switch or the Deako app update Apple Home right away.
- **Dimmers.** Deako dimmers get a brightness slider.
- **Self-healing.** Reconnects when the hub drops the connection.

## How it works

```
Apple Home ⇄ Homebridge (this plugin) ⇄ TCP 23, JSON lines ⇄ Deako hub ⇄ switches
```

The plugin uses the same local integration API as the official Deako library
([pydeako](https://pypi.org/project/pydeako/)), which Home Assistant also uses.

## Install

Search for **Deako** in the Plugins tab of the Homebridge UI, or run:

```sh
npm install -g homebridge-deako
```

## Configure

1. Find your Deako hub's IP address. It is the Deako device that accepts connections on TCP port 23.
   You can see it in your router's client list (it often shows as an "Espressif" device), or check a candidate with
   `nc -vz <ip> 23`.
2. Reserve that IP address in your router so it does not change.
3. Add the platform:

```json
{
  "platform": "Deako",
  "name": "Deako",
  "host": "192.168.1.50"
}
```

| Option | Required | Default | Description |
|---|---|---|---|
| `host` | yes | | IP address of the Deako hub |
| `port` | no | `23` | TCP port of the local integration |
| `name` | no | `Deako` | Name shown in the Homebridge log |

## Notes

- **One connection at a time.** The Deako hub accepts one local client. If another integration
  (for example Home Assistant) is connected to the same hub, this plugin cannot connect, and
  the other way around.
- Lights that the hub stops reporting are removed from Apple Home after 30 seconds of a successful connection.

## Development

```sh
npm test   # runs the protocol tests against a fake hub (node:test, no dependencies)
```

## License

MIT
