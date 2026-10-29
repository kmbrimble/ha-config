#!/usr/bin/env python3
"""Garage Remote MQTT relay (runs on garagepi): garageremote/<Name> "ON" pulses a relay for 1 s.

Relays are active LOW. Deliberately no GPIO.cleanup(): it floats the pins, which can fire the relays.
MQTT_USER / MQTT_PASS come from the environment (EnvironmentFile); unset means anonymous.
"""
import os
import time

import paho.mqtt.client as mqtt
import RPi.GPIO as GPIO

relay_pins = [17, 18, 27, 22, 23, 24]
names = ["Carport Door", "Bike Door", "Car Door", "Carport Gate", "Bike Gate", "Car Gate"]
MQTT_BROKER = "192.168.0.10"
TOPIC_PREFIX = "garageremote"

GPIO.setmode(GPIO.BCM)
for pin in relay_pins:
    GPIO.setup(pin, GPIO.OUT, initial=GPIO.HIGH)  # HIGH = off, set at setup so there is no low glitch


def trigger_relay(index):
    pin = relay_pins[index]
    print(f"relay {names[index]}: BCM {pin} LOW (pulse start)", flush=True)
    GPIO.output(pin, GPIO.LOW)
    time.sleep(1)
    GPIO.output(pin, GPIO.HIGH)
    print(f"relay {names[index]}: BCM {pin} HIGH (pulse end)", flush=True)


def on_connect(client, userdata, flags, reason_code, properties):
    # Subscribing here (not once at startup) re-subscribes after every reconnect.
    for name in names:
        client.subscribe(f"{TOPIC_PREFIX}/{name.replace(' ', '_')}")


def on_message(client, userdata, msg):
    if msg.payload.decode() != "ON":
        return
    for i, name in enumerate(names):
        if msg.topic == f"{TOPIC_PREFIX}/{name.replace(' ', '_')}":
            print(f"message on {msg.topic}", flush=True)
            trigger_relay(i)


client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="relay_mqtt")
if os.environ.get("MQTT_USER") and os.environ.get("MQTT_PASS"):
    client.username_pw_set(os.environ["MQTT_USER"], os.environ["MQTT_PASS"])
client.on_connect = on_connect
client.on_message = on_message
client.on_connect_fail = lambda client, userdata: print("mqtt connect failed, retrying", flush=True)
# Wi-Fi can be minutes behind boot; retry the first connect forever (paho backs off 1 -> 120 s).
client.connect_async(MQTT_BROKER, 1883, 60)
client.loop_forever(retry_first_connection=True)
