#!/usr/bin/env python3
"""Zeversolar ZL 2000S -> MQTT bridge (runs on garagepi).

Data path:
    inverter RS485
      -> ESP32 "solar-gateway" 192.168.0.111:6638   (esphome stream_server)
      -> socat pty /dev/ttyZEVER                    (zever-bridge.service)
      -> this script
      -> mosquitto 192.168.0.10 -> Home Assistant   (MQTT discovery)

Wire format, both directions:

    AA 55 | src(2,LE) | dst(2,BE) | ctrl(1) | func(1) | len(1) | data[len] | sum(2,BE)
    |<---------------- 9-byte header ------------------------>|
    total frame length = 11 + len
    sum = (sum of every byte from AA up to and including the last data byte) & 0xFFFF

Why this file is fussy about reading
------------------------------------
The serial port is a socat pty bridged over TCP and Wi-Fi. TCP does not lose bytes,
but it makes no promise about WHEN they arrive. The previous version wrote a request,
slept 1.5 s, and parsed whatever happened to be in the buffer. A late frame was
therefore parsed as a short one, every absent field defaulted to 0 via raw.get(id, 0),
and those zeros were published. energy_total carries state_class total_increasing, so
a published 0 reads as a meter reset and corrupts long-term statistics in HA.

It also had a silent failure path: parse_and_publish() opened with
`if len(response) < 12: return` -- no log, no publish, no error -- so a short frame
left the service looking healthy while producing nothing at all.

So, in this version:
  * every read is deadline-driven and resynchronises on the AA55 header
  * every frame is checked against its own declared length AND its own checksum
  * a frame that fails any check is logged with its hex and dropped
  * no field ever defaults to 0; a frame either validates whole or is not used
  * a failed poll marks the entities unavailable instead of giving them a value
  * every outcome is logged, so silence from this service now means it is not running

An inverter asleep overnight and a broken link look identical at the protocol level
(both give nothing back). The log distinguishes "no bytes at all" from "partial or
corrupt frame", which is the useful signal for telling them apart.
"""

import json
import logging
import os
import random
import sys
import time

import paho.mqtt.client as mqtt
import serial

# --- configuration (env overrides for everything worth changing) ---------------
SERIAL_PORT = os.environ.get("ZEVER_SERIAL_PORT", "/dev/ttyZEVER")
BAUD_RATE = 9600
MY_ADDRESS = 0x01
INVERTER_ADDR = 0x01

MQTT_BROKER = os.environ.get("MQTT_BROKER", "192.168.0.10")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
MQTT_USER = os.environ.get("MQTT_USER") or None
MQTT_PASS = os.environ.get("MQTT_PASS") or None
MQTT_TOPIC_PREFIX = "zeversolar"
HA_DISCOVERY_PREFIX = "homeassistant"

SERIAL_NUMBER = os.environ.get("ZEVER_SERIAL_NUMBER", "BS20000101750111")

POLL_INTERVAL = float(os.environ.get("ZEVER_POLL_INTERVAL", "30"))
FRAME_TIMEOUT = float(os.environ.get("ZEVER_FRAME_TIMEOUT", "4.0"))
# consecutive failed polls before the entities are marked unavailable
UNAVAILABLE_AFTER = int(os.environ.get("ZEVER_UNAVAILABLE_AFTER", "3"))
# after this many consecutive failures, drop to one log line every Nth poll
LOG_EVERY_NTH_FAILURE = int(os.environ.get("ZEVER_LOG_EVERY_NTH", "10"))

HEADER = b"\xAA\x55"
HEADER_LEN = 9
CHECKSUM_LEN = 2
READ_CHUNK_TIMEOUT = 0.2

logging.basicConfig(
    level=os.environ.get("ZEVER_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("zeversolar")

# --- protocol tables ----------------------------------------------------------
# The validated V610 firmware map: the inverter returns these data ids, in this
# order, two bytes each. An id's position in this list IS its byte offset / 2.
DATA_MAP = [
    0x00, 0x0D, 0x01, 0x02, 0x04, 0x05, 0x41, 0x42, 0x43, 0x44,
    0x45, 0x47, 0x48, 0x49, 0x4A, 0x4C, 0x78, 0x79, 0x7A, 0x7B,
    0x3A, 0x3B, 0x7D, 0x7E, 0x7F,
]
DATA_OFFSET = {data_id: index * 2 for index, data_id in enumerate(DATA_MAP)}
# ids this script actually reads; the payload must be long enough to cover all of them
USED_IDS = (0x00, 0x0D, 0x01, 0x04, 0x42, 0x44, 0x47, 0x48, 0x4A)
REQUIRED_DATA_BYTES = max(DATA_OFFSET[i] for i in USED_IDS) + 2

SENSORS = [
    {"id": "power", "name": "Current Power", "unit": "W",
     "dev_cls": "power", "stat_cls": "measurement", "ic": "mdi:solar-power"},
    {"id": "energy_today", "name": "Energy Today", "unit": "kWh",
     "dev_cls": "energy", "stat_cls": "total_increasing"},
    {"id": "energy_total", "name": "Energy Total", "unit": "kWh",
     "dev_cls": "energy", "stat_cls": "total_increasing"},
    {"id": "voltage_pv", "name": "PV Voltage", "unit": "V",
     "dev_cls": "voltage", "stat_cls": "measurement"},
    {"id": "current_pv", "name": "PV Current", "unit": "A",
     "dev_cls": "current", "stat_cls": "measurement"},
    {"id": "voltage_ac", "name": "Grid Voltage", "unit": "V",
     "dev_cls": "voltage", "stat_cls": "measurement"},
    {"id": "temperature", "name": "Temperature", "unit": "°C",
     "dev_cls": "temperature", "stat_cls": "measurement"},
]


class LinkError(Exception):
    """The serial port itself failed -- reopen it."""


def hexdump(raw, limit=64):
    if not raw:
        return "<nothing>"
    body = raw[:limit].hex(" ")
    return body + (f" ... (+{len(raw) - limit} more)" if len(raw) > limit else "")


def checksum(payload):
    return (sum(payload) & 0xFFFF).to_bytes(2, byteorder="big")


def construct_packet(source, dest, ctrl, func, data=b""):
    payload = (
        HEADER
        + source.to_bytes(2, byteorder="little")
        + dest.to_bytes(2, byteorder="big")
        + ctrl.to_bytes(1, byteorder="big")
        + func.to_bytes(1, byteorder="big")
        + len(data).to_bytes(1, byteorder="big")
        + data
    )
    return payload + checksum(payload)


def read_frame(ser, timeout, echo=None):
    """Read one complete, checksum-valid frame.

    Returns (frame, reason, raw). frame is None unless reason is None.

    raw is EVERY byte received during the attempt, not merely whatever survived
    resynchronisation -- the old code reported the post-discard buffer, which
    made a full 11-byte echo read as "1 bytes" and hid the real fault.

    If echo is given, a frame byte-identical to it is the local RS485 echo of
    our own transmission: auto-direction RS485 modules hear their own output.
    It is skipped and reading continues, so a genuine reply arriving behind the
    echo is still found. Without this the echo is returned as though it were
    the inverter's answer.
    """
    deadline = time.monotonic() + timeout
    buf = bytearray()
    received = bytearray()
    seen_bad_checksum = False
    echo_seen = False

    while time.monotonic() < deadline:
        try:
            waiting = ser.in_waiting
            chunk = ser.read(waiting if waiting else 1)
        except OSError as exc:
            raise LinkError(f"read failed: {exc}") from exc
        if chunk:
            buf.extend(chunk)
            received.extend(chunk)

        while True:
            start = buf.find(HEADER)
            if start < 0:
                # keep a trailing 0xAA in case its 0x55 is in the next chunk
                if len(buf) > 1:
                    del buf[:-1]
                break
            if start > 0:
                del buf[:start]
            if len(buf) < HEADER_LEN:
                break
            total = HEADER_LEN + buf[8] + CHECKSUM_LEN
            if len(buf) < total:
                break
            frame = bytes(buf[:total])
            expected = int.from_bytes(checksum(frame[:-CHECKSUM_LEN]), "big")
            actual = int.from_bytes(frame[-CHECKSUM_LEN:], "big")
            if expected == actual:
                if echo is not None and frame == echo:
                    echo_seen = True
                    del buf[:total]
                    continue
                return frame, None, bytes(received)
            seen_bad_checksum = True
            logger.debug("checksum mismatch (want %04X got %04X) in %s",
                         expected, actual, hexdump(frame))
            del buf[:2]  # step past this header and resynchronise

    if echo_seen:
        return None, (
            f"only our own transmission came back -- local RS485 echo of "
            f"{len(received)} bytes, no reply from the inverter"
        ), bytes(received)
    if seen_bad_checksum:
        return None, "checksum failed on every candidate frame", bytes(received)
    if not received:
        return None, "no bytes at all (inverter asleep, or the link is down)", b""
    return None, (f"incomplete frame after {timeout:.1f}s "
                  f"({len(received)} bytes received)"), bytes(received)


def request(ser, packet, description):
    try:
        ser.reset_input_buffer()
        ser.write(packet)
        ser.flush()
    except OSError as exc:
        raise LinkError(f"write failed during {description}: {exc}") from exc
    return read_frame(ser, FRAME_TIMEOUT, echo=packet)


def parse_frame(frame):
    """Turn a validated frame into a reading. Returns (data, reason)."""
    data_len = frame[8]
    data = frame[HEADER_LEN:HEADER_LEN + data_len]
    if len(data) < REQUIRED_DATA_BYTES:
        return None, (f"payload is {len(data)} bytes, need {REQUIRED_DATA_BYTES} "
                      f"to cover every field")

    def word(data_id):
        offset = DATA_OFFSET[data_id]
        return int.from_bytes(data[offset:offset + 2], byteorder="big")

    energy_total = ((word(0x47) << 16) + word(0x48)) / 10.0
    if energy_total <= 0:
        # A commissioned inverter cannot have a zero lifetime total. Publishing it
        # would look like a meter reset to HA's long-term statistics.
        return None, "energy_total read as 0, implausible - frame rejected"

    return {
        "power": word(0x44),
        "energy_today": word(0x0D) / 100.0,
        "energy_total": energy_total,
        "voltage_pv": word(0x01) / 10.0,
        "current_pv": word(0x04) / 10.0,
        "voltage_ac": word(0x42) / 10.0,
        "temperature": word(0x00) / 10.0,
        "status_code": word(0x4A),
    }, None


class ZeversolarBridge:
    def __init__(self):
        self.serial_number = SERIAL_NUMBER
        self.state_topic = f"{MQTT_TOPIC_PREFIX}/{self.serial_number}/state"
        self.availability_topic = f"{MQTT_TOPIC_PREFIX}/{self.serial_number}/status"
        self.discovery_published = False
        self.available = None          # tri-state: None = not yet declared
        self.consecutive_failures = 0
        self.ser = None

        client_id = f"Zeversolar_Bridge_{random.randint(1000, 9999)}"
        self.mqtt_client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id)
        if MQTT_USER and MQTT_PASS:
            self.mqtt_client.username_pw_set(MQTT_USER, MQTT_PASS)
        # if this process dies, the broker says so on our behalf
        self.mqtt_client.will_set(self.availability_topic, "offline", retain=True)
        self.mqtt_client.on_connect = self._on_connect
        self.mqtt_client.on_disconnect = self._on_disconnect

    # --- MQTT -----------------------------------------------------------------
    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        logger.info("MQTT connected to %s:%s (%s)", MQTT_BROKER, MQTT_PORT, reason_code)
        self.publish_discovery()
        # re-assert availability after a reconnect, since the LWT may have fired
        if self.available is not None:
            self._publish_availability(self.available, force=True)

    def _on_disconnect(self, client, userdata, *args):
        logger.warning("MQTT disconnected from %s:%s", MQTT_BROKER, MQTT_PORT)

    def connect_mqtt(self):
        try:
            self.mqtt_client.connect(MQTT_BROKER, MQTT_PORT, 60)
        except OSError as exc:
            logger.error("cannot reach MQTT broker %s:%s - %s", MQTT_BROKER, MQTT_PORT, exc)
            sys.exit(1)
        self.mqtt_client.loop_start()

    def publish_discovery(self):
        device_info = {
            "identifiers": [self.serial_number],
            "manufacturer": "Zeversolar",
            "model": "ZL 2000S",
            "name": "Solar Inverter",
        }
        for sensor in SENSORS:
            payload = {
                "name": sensor["name"],
                "unique_id": f"{self.serial_number}_{sensor['id']}",
                "state_topic": self.state_topic,
                "value_template": f"{{{{ value_json.{sensor['id']} }}}}",
                "unit_of_measurement": sensor["unit"],
                "device_class": sensor["dev_cls"],
                "device": device_info,
                "availability_topic": self.availability_topic,
                "payload_available": "online",
                "payload_not_available": "offline",
            }
            if "stat_cls" in sensor:
                payload["state_class"] = sensor["stat_cls"]
            if "ic" in sensor:
                payload["icon"] = sensor["ic"]
            topic = (f"{HA_DISCOVERY_PREFIX}/sensor/{self.serial_number}/"
                     f"{sensor['id']}/config")
            self.mqtt_client.publish(topic, json.dumps(payload), retain=True)
        if not self.discovery_published:
            logger.info("published HA discovery for %d sensors (availability topic: %s)",
                        len(SENSORS), self.availability_topic)
            self.discovery_published = True

    def _publish_availability(self, available, force=False):
        if available == self.available and not force:
            return
        self.available = available
        self.mqtt_client.publish(
            self.availability_topic, "online" if available else "offline", retain=True
        )
        logger.info("entities marked %s", "available" if available else "UNAVAILABLE")

    # --- serial ---------------------------------------------------------------
    def open_serial(self):
        if self.ser is not None and self.ser.is_open:
            return self.ser
        self.close_serial()
        self.ser = serial.Serial(
            SERIAL_PORT, BAUD_RATE, timeout=READ_CHUNK_TIMEOUT,
            rtscts=False, dsrdtr=False,
        )
        logger.info("opened %s at %d baud", SERIAL_PORT, BAUD_RATE)
        return self.ser

    def close_serial(self):
        if self.ser is not None:
            try:
                self.ser.close()
            except Exception:
                pass
            self.ser = None

    def handshake(self, ser):
        logger.info("running handshake")
        wake = construct_packet(MY_ADDRESS, 0x00, 0x10, 0x00)
        frame, reason, raw = request(ser, wake, "wake-up")
        if frame is None:
            logger.warning("handshake wake-up failed: %s | raw: %s", reason, hexdump(raw))
            return False
        data_len = frame[8]
        serial_bytes = frame[HEADER_LEN:HEADER_LEN + data_len]
        if not serial_bytes:
            logger.warning("handshake wake-up returned an empty payload: %s", hexdump(frame))
            return False
        logger.info("inverter answered wake-up with %d-byte id", len(serial_bytes))
        alloc = construct_packet(
            MY_ADDRESS, 0x00, 0x10, 0x01,
            serial_bytes + INVERTER_ADDR.to_bytes(1, "big"),
        )
        frame, reason, raw = request(ser, alloc, "address allocation")
        if frame is None:
            logger.warning("address allocation not acknowledged: %s | raw: %s",
                           reason, hexdump(raw))
            return False
        logger.info("handshake complete")
        return True

    # --- one poll -------------------------------------------------------------
    def poll_once(self, ser):
        """Returns (data, reason). data is None on any failure."""
        query = construct_packet(MY_ADDRESS, INVERTER_ADDR, 0x11, 0x02)
        frame, reason, raw = request(ser, query, "query")
        if frame is None:
            if not self.handshake(ser):
                return None, f"query failed ({reason}) and handshake did not complete"
            frame, reason, raw = request(ser, query, "query after handshake")
            if frame is None:
                return None, f"query failed after a successful handshake: {reason}"
        data, reason = parse_frame(frame)
        if data is None:
            return None, f"{reason} | frame: {hexdump(frame)}"
        return data, None

    def record_success(self, data):
        if self.consecutive_failures:
            logger.info("recovered after %d failed poll(s)", self.consecutive_failures)
        self.consecutive_failures = 0
        self.mqtt_client.publish(self.state_topic, json.dumps(data))
        self._publish_availability(True)
        logger.info(
            "published %sW | today %skWh | total %skWh | PV %sV %sA | grid %sV | %s°C | status %s",
            data["power"], data["energy_today"], data["energy_total"],
            data["voltage_pv"], data["current_pv"], data["voltage_ac"],
            data["temperature"], data["status_code"],
        )

    def record_failure(self, reason):
        self.consecutive_failures += 1
        n = self.consecutive_failures
        # loud on the way in and every Nth after that, so an overnight outage does
        # not bury the log but never goes completely silent either
        if n <= UNAVAILABLE_AFTER or n % LOG_EVERY_NTH_FAILURE == 0:
            logger.warning("poll failed (%d in a row): %s", n, reason)
        else:
            logger.debug("poll failed (%d in a row): %s", n, reason)
        if n >= UNAVAILABLE_AFTER:
            self._publish_availability(False)

    # --- main loop ------------------------------------------------------------
    def run(self):
        logger.info(
            "starting: port=%s poll=%.0fs frame_timeout=%.1fs broker=%s:%s",
            SERIAL_PORT, POLL_INTERVAL, FRAME_TIMEOUT, MQTT_BROKER, MQTT_PORT,
        )
        self.connect_mqtt()
        while True:
            try:
                ser = self.open_serial()
                data, reason = self.poll_once(ser)
                if data is not None:
                    self.record_success(data)
                else:
                    self.record_failure(reason)
            except LinkError as exc:
                # the pty went away -- socat restarting, or the ESP32 dropped off
                self.close_serial()
                self.record_failure(f"serial link lost: {exc}")
            except serial.SerialException as exc:
                self.close_serial()
                self.record_failure(f"cannot open {SERIAL_PORT}: {exc}")
            except Exception as exc:  # never let the loop die silently
                logger.exception("unexpected error in poll loop: %s", exc)
                self.close_serial()
                self.record_failure(f"unexpected error: {exc}")
            time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    bridge = ZeversolarBridge()
    try:
        bridge.run()
    except KeyboardInterrupt:
        logger.info("stopping on interrupt")
        bridge.close_serial()
