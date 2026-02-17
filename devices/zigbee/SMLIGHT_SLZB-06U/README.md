# SMLIGHT SLZB-06U

## official documentation page 
[Coordinator documentation](https://smlight.tech/manual/slzb-06/)


The **SMLIGHT SLZB-06U** is a Zigbee radio adapter designed to act as the **Zigbee coordinator** (or, depending on firmware, a router) for your Zigbee network. 
In this PoC, its role is: it is the **gateway-side Zigbee radio** that forms the Zigbee PAN and bridges Zigbee traffic to the IP network, so **Zigbee2MQTT** (and then **Mosquitto/Node-RED**) can work with real devices.

## What it is

A small device containing a **Zigbee chipset + firmware** (commonly based on **TI CC2652** family in this product line).

It exposes that Zigbee radio to your system via:

- **USB serial** (plugged into a PC/RPi/host)
- **Ethernet (LAN)**, typically via a **TCP serial bridge** (you connect to it over the network as if it were a serial port)
- Often **PoE (power over Ethernet)**, which is convenient for placement (center of building, away from noisy USB/PC).

## What you can do with it

With coordinator firmware, it lets you:

### Create a Zigbee network

- Pick a Zigbee channel (11-26) and PAN ID.
- Allow devices to join (pairing).
- Maintain the network trust center (security keys).

### Pair and control Zigbee devices

- Sensors (motion, temperature, luminance) report telemetry periodically or on events.
- Actuators (smart plugs, TRVs) receive commands (ON/OFF, setpoint, etc.).

### Integrate with Zigbee2MQTT

- Zigbee2MQTT talks to the coordinator and publishes device messages to MQTT (`zigbee2mqtt/<device>`).
- It also listens for commands from MQTT (`zigbee2mqtt/<device>/set`).


## How you typically use it (in this PoC)

### Mode choice: Ethernet vs USB

**Ethernet (LAN) mode** is usually best for a PoC:

- You can place it centrally (better mesh, better range).
- Less USB interference from a PC.
- Node-RED/Zigbee2MQTT can run anywhere on the LAN and still reach it.

**USB mode** is simpler for first bring-up but can be less reliable if the host is noisy or far from devices.

- Right now, we're going with USB mode because of limitation on the pc (only one ethernet port, and already used), but Ethernet would be better

### With Zigbee2MQTT (most common workflow)

#### Power and connect

- Plug Ethernet (PoE if available) or USB power.
- Find its IP address (router DHCP lease page, or its discovery method).

#### Confirm what serial endpoint it exposes

If using Ethernet, Zigbee2MQTT will usually connect via something like:

- `tcp://<ip>:<port>`

If using USB, it will be something like:

- `/dev/ttyUSB0` or `/dev/ttyACM0` (Linux), COM port on Windows.

#### Configure Zigbee2MQTT

- Set `serial.port` to the correct endpoint (USB device or `tcp://...`).
- Start Zigbee2MQTT and confirm it reports coordinator startup.

#### Pair devices

- Enable join in Zigbee2MQTT.
- Put a sensor/plug into pairing mode.
- It appears in Zigbee2MQTT and MQTT topics start flowing.

#### Operate from MQTT/Node-RED

- Telemetry appears under `zigbee2mqtt/<friendly_name>`.
- Commands are published to `zigbee2mqtt/<friendly_name>/set`.

## Coordinator vs router firmware (important)

This device can be flashed with different firmware:

- **Coordinator firmware**: what you want for Zigbee2MQTT (it forms the network).
- **Router firmware**: joins an existing Zigbee network to extend range (not what you want as the main coordinator).

For this PoC, we use **Coordinator** mode and we are not going to test the router firmware.

## What to watch out for (common hidden complexity)

- **Channel selection**: avoid Wi-Fi overlap (2.4 GHz). Poor channel choice causes instability.
- **Backups**: the coordinator stores network keys; if you replace/reset it without backup, devices may need re-pairing.
- **Placement**: Zigbee is sensitive to distance/obstructions; Ethernet + PoE helps placement.
- **MQTT naming**: Zigbee2MQTT friendly names become MQTT topics used in Node-RED.

## How it fits your architecture

**Zigbee devices -> SLZB-06U (coordinator) -> Zigbee2MQTT -> Mosquitto -> Node-RED / Dashboard / DB**

So in your MQTT backbone model, the SLZB-06U is the Zigbee radio front-end.

------------------------------------------------------------------------------------------

# Detailed setup and configuration (Runbook D1)

This section expands step `D1` from `poc_project_runbook_ubuntu_EN.md` into a strict step-by-step procedure.

It assumes:

- Ubuntu host path: `~/Public/poc`
- Docker stack path: `~/Public/poc/stack`
- Zigbee2MQTT runs in Docker (`zigbee2mqtt` service)
- SLZB-06U is used over LAN (TCP), not USB

## Is runbook D1 explicit enough?

Not fully for a first setup. `D1` gives the right objective but leaves some critical details implicit:

- exact fields to configure on the coordinator
- exact Zigbee2MQTT values to edit
- validation criteria to distinguish healthy startup vs reconnect loop
- what to save as evidence beyond the two log files

Use this section for execution, then keep using the global runbook for the full project sequence.

## Inputs to decide before you start

Set and freeze these values before pairing any Zigbee device:

- `SLZB06_IP` (example: `172.17.0.101`)
- `SLZB06_PORT` (usually `6638`)
- Zigbee channel (recommended one of `15`, `20`, `25`; avoid Wi-Fi overlap)
- `pan_id` (4 hex digits, example `0x1A62`)
- `ext_pan_id` (8 bytes, example `[0xDD,0xDD,0xDD,0xDD,0xDD,0xDD,0xDD,0xDD]`)

## Step-by-step

### 1. Connect and discover the coordinator

1. Connect SLZB-06U to Ethernet (PoE or USB power).
2. Find its IP in your router/DHCP leases.
3. Reserve a fixed DHCP lease for that MAC address.
4. Verify from the Ubuntu host:

```bash
ping -c 3 <SLZB06_IP>
```

Expected result: ping replies with stable latency and no packet loss.

#### How to find and confirm the dynamic IP (when reservation is not ready yet)

Use this procedure when the network team has not yet created a DHCP reservation.

1. Confirm your LAN subnet:

```bash
ip -4 addr show scope global
ip route
```

2. Replace `<LAN_PREFIX>` below with your subnet prefix (example: `172.17.0`), then scan for devices:

```bash
seq 1 254 | xargs -I{} -P 64 sh -c 'ping -c 1 -W 1 <LAN_PREFIX>.{} >/dev/null 2>&1 && echo <LAN_PREFIX>.{}' | sort -V
```

3. Check which discovered IP exposes the coordinator endpoints (`80` and `6638`):

```bash
seq 1 254 | xargs -I{} -P 64 sh -c 'nc -z -w 1 <LAN_PREFIX>.{} 80 >/dev/null 2>&1 && echo "80 <LAN_PREFIX>.{}"; nc -z -w 1 <LAN_PREFIX>.{} 6638 >/dev/null 2>&1 && echo "6638 <LAN_PREFIX>.{}"' | sort -V
```

4. Confirm candidate device identity from its web page:

```bash
curl --compressed -sS -m 5 http://<CANDIDATE_IP>/ | rg -i "SLZB OS|SMLIGHT"
```

5. Confirm connectivity:

```bash
ping -c 3 <CANDIDATE_IP>
nc -z -w 2 <CANDIDATE_IP> 6638 && echo "6638 OK"
```

6. Record this as the temporary value for `SLZB06_IP` until reservation is in place.

Important: with dynamic DHCP, the IP can change after reboot or lease renewal. Re-check this step before continuing if connectivity breaks.

7. Ask for a fixed IP to your nice network administrator

The coordinator now has a fixed IP: `172.17.0.101`.

### 2. Configure coordinator mode in SLZB web UI

1. Open `http://<SLZB06_IP>` in a browser.
2. Confirm the Zigbee firmware mode is `Coordinator` (not `Router`).
3. Confirm the TCP serial server is enabled and note its port (commonly `6638`) (in "Z2M and ZHA").
4. Save and reboot the coordinator if the UI requests it.

Expected result: after reboot, the device is reachable and TCP endpoint is available.

### 3. Update stack environment

Edit `stack/.env`:

- set `SLZB06_IP=<SLZB06_IP>`
- set `SLZB06_PORT=<your_port>`
- set `COMPOSE_PROFILES=zigbee` so Zigbee services run

### 4. Render Zigbee2MQTT configuration from `.env`

This project generates `stack/zigbee2mqtt/configuration.yaml` from
`stack/templates/zigbee2mqtt_configuration.yaml.tmpl` and `stack/.env`.

Run:

```bash
cd ~/Public/poc
bash scripts/15_render_configs.sh
```

Then verify:

```bash
rg -n "adapter:|port: tcp://|channel:|pan_id:|ext_pan_id:|network_key:" stack/zigbee2mqtt/configuration.yaml
```

Expected key block in generated file:

```yaml
adapter: zstack

serial:
  port: tcp://<SLZB06_IP>:<SLZB06_PORT>

advanced:
  channel: 15
  pan_id: 0x1A62
  ext_pan_id: [0xDD,0xDD,0xDD,0xDD,0xDD,0xDD,0xDD,0xDD]
  network_key: GENERATE
```

Notes:

- Keep `network_key: GENERATE` only for first network creation.
- After commissioning, keep generated values stable and back up `stack/zigbee2mqtt/`.

### 5. Start Zigbee2MQTT and validate startup

```bash
cd ~/Public/poc/stack
docker compose up -d zigbee2mqtt
docker logs --tail 200 -f zigbee2mqtt
```

Expected result in logs:

- coordinator initialization succeeds
- no continuous reconnect loop
- no repeated connection refused/timeouts every few seconds

Stop log tail with `Ctrl+C` after confirmation.

### 6. Restart persistence check (required by D1)

```bash
docker restart zigbee2mqtt
docker logs --tail 200 zigbee2mqtt
```

Expected result: same healthy startup after restart; frozen `channel`/`pan_id`/`ext_pan_id` still applied.

### 7. Save D1 evidence

```bash
cp ~/Public/poc/stack/zigbee2mqtt/configuration.yaml \
  ~/Public/poc/evidence/configs/D1_z2m_configuration.yaml

docker logs --tail 200 zigbee2mqtt \
  | tee ~/Public/poc/evidence/logs/D1_z2m_startup.txt

docker restart zigbee2mqtt

docker logs --tail 200 zigbee2mqtt \
  | tee ~/Public/poc/evidence/logs/D1_z2m_after_restart.txt
```

Optional but recommended:

- screenshot of SLZB-06U UI showing coordinator mode and TCP port
- screenshot of Zigbee2MQTT frontend healthy status

## Fast troubleshooting

- `ECONNREFUSED` or timeout: wrong `serial.port`, wrong IP/port, or coordinator TCP server disabled.
- endless reconnect loop: coordinator not in `Coordinator` mode or wrong adapter setting.
- devices cannot join later: channel/PAN changed after initial pairing; restore original values.
- Zigbee service does not start: verify `COMPOSE_PROFILES=zigbee` and rerun `docker compose up -d`.
- `failed to set up container networking: network ... not found`: stale Zigbee containers reference a deleted Docker network; run `docker rm -f zigbee2mqtt` (and `docker rm -f zigbee-adapter-sim` only if present from an older setup), then `docker compose up -d zigbee2mqtt`.

## Next step after D1

Continue with runbook step `E1` to pair your first periodic Zigbee sensor and validate telemetry cadence.
